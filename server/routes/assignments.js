'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  validateAssignmentInput,
  validateAssignmentPatch,
  validateReplacementInput,
  validateAttendancePatch,
  isInteger,
} = require('../lib/validate');
const { generateToken, hashToken } = require('../lib/tokens');
const { getSessionCandidates } = require('./coverage');

// All assignments administration routes require auth + admin or coordinator role
router.use(requireAuth, requireRole('admin', 'coordinator'));

/**
 * GET /api/assignments
 * List and filter assignments.
 */
router.get('/', async (req, res, next) => {
  try {
    const { session_id, judge_id, competition_id, status, role } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);

    if (isNaN(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    if (isNaN(offset) || offset < 0) offset = 0;

    const whereClauses = [];
    const params = [];
    let paramIdx = 1;

    if (session_id && isInteger(session_id)) {
      params.push(session_id);
      whereClauses.push(`ja.session_id = $${paramIdx++}`);
    }

    if (judge_id && isInteger(judge_id)) {
      params.push(judge_id);
      whereClauses.push(`ja.judge_id = $${paramIdx++}`);
    }

    if (competition_id && isInteger(competition_id)) {
      params.push(competition_id);
      whereClauses.push(`s.competition_id = $${paramIdx++}`);
    }

    if (status && typeof status === 'string') {
      params.push(status);
      whereClauses.push(`ja.status = $${paramIdx++}`);
    }

    if (role && typeof role === 'string') {
      params.push(role);
      whereClauses.push(`ja.role = $${paramIdx++}`);
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       ${whereSQL}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    params.push(limit);
    const limitIdx = paramIdx++;
    params.push(offset);
    const offsetIdx = paramIdx++;

    const sql = `
      SELECT ja.id, ja.session_id, ja.judge_id, ja.role, ja.status, ja.assignment_window,
             ja.replaces_assignment_id, ja.superseded_by, ja.created_at, ja.updated_at,
             j.first_name, j.last_name, j.email, j.organization, j.kind AS judge_kind,
             s.name AS session_name, s.start_time, s.end_time, s.buffer_minutes, s.competition_id,
             c.name AS competition_name,
             v.name AS venue_name,
             aa.status AS attendance_status, aa.check_in_time, aa.checked_out_at, aa.minutes_late
      FROM judge_assignments ja
      JOIN judges j ON j.id = ja.judge_id
      JOIN sessions s ON s.id = ja.session_id
      JOIN competitions c ON c.id = s.competition_id
      LEFT JOIN venues v ON v.id = s.venue_id
      LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
      ${whereSQL}
      ORDER BY s.start_time ASC, ja.created_at ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const dataRes = await db.query(sql, params);

    res.json({
      assignments: dataRes.rows,
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/assignments
 * Create an assignment. DB exclusion constraint no_double_booking is the ONLY overlap guard.
 */
router.post('/', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const validation = validateAssignmentInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { session_id, judge_id, role } = req.body;
    const assignmentRole = role || 'judge';

    await client.query('BEGIN');

    // Verify session exists
    const sessRes = await client.query(
      `SELECT s.*, c.name AS competition_name
       FROM sessions s
       JOIN competitions c ON c.id = s.competition_id
       WHERE s.id = $1`,
      [session_id]
    );
    if (sessRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessRes.rows[0];

    // Verify judge exists and is active
    const judgeRes = await client.query('SELECT * FROM judges WHERE id = $1', [judge_id]);
    if (judgeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Judge not found' });
    }
    const judge = judgeRes.rows[0];
    if (judge.status === 'inactive' || judge.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot assign an inactive judge' });
    }

    // Check if judge has an accepted invitation for this competition
    const invCheck = await client.query(
      `SELECT status FROM judge_invitations
       WHERE judge_id = $1 AND competition_id = $2 AND status = 'accepted'
       LIMIT 1`,
      [judge_id, session.competition_id]
    );
    // If invitation is already accepted, confirm assignment; else hold it
    const initialStatus = invCheck.rows.length > 0 ? 'confirmed' : 'held';

    // Insert assignment - let DB exclusion constraint no_double_booking guard overlaps!
    let assignment;
    try {
      const insRes = await client.query(
        `INSERT INTO judge_assignments (session_id, judge_id, role, status)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [session_id, judge_id, assignmentRole, initialStatus]
      );
      assignment = insRes.rows[0];
    } catch (dbErr) {
      if (dbErr.code === '23P01') { // exclusion_violation
        await client.query('ROLLBACK');
        let conflictId = null;
        try {
          // Query to find conflicting assignment id using db pool outside the aborted transaction
          const conflictRes = await db.query(
            `SELECT ja.id
             FROM judge_assignments ja
             WHERE ja.judge_id = $1
               AND ja.status <> 'cancelled'
               AND ja.assignment_window && tstzrange(
                 $2::timestamptz - ($4 || ' minutes')::interval,
                 $3::timestamptz + ($4 || ' minutes')::interval,
                 '[]'
               )
             LIMIT 1`,
            [judge_id, session.start_time, session.end_time, session.buffer_minutes || 0]
          );
          conflictId = conflictRes.rows[0]?.id || null;
        } catch {
          // Ignore secondary query failure if any
        }

        return res.status(409).json({
          error: 'overlap',
          message: 'Judge is already assigned to an overlapping session',
          conflicting_assignment_id: conflictId,
        });
      }
      if (dbErr.code === '23505') { // uq_assignment_per_session
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Judge is already assigned to this session',
        });
      }
      throw dbErr;
    }

    // Generate assignment magic link token
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO auth_tokens (
        judge_id, assignment_id, token_hash, purpose, expires_at
      ) VALUES ($1, $2, $3, 'assignment', $4)`,
      [judge_id, assignment.id, tokenHash, expiresAt]
    );

    // Produce outbox row
    const magicLinkUrl = `/j/${rawToken}`;
    const idempotencyKey = `assignment:${assignment.id}:notified`;

    await client.query(
      `INSERT INTO notification_outbox (
        recipient_email, to_email, recipient_name, channel, subject, body,
        payload, template, idempotency_key, status
      ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'assignment_notification', $7, 'pending')`,
      [
        judge.email,
        judge.email,
        `${judge.first_name} ${judge.last_name}`,
        `Judging Assignment: ${session.name} (${session.competition_name})`,
        `Dear ${judge.first_name}, you have been assigned to judge ${session.name}. Please confirm via your link: ${magicLinkUrl}`,
        JSON.stringify({
          assignment_id: assignment.id,
          session_id: session.id,
          session_name: session.name,
          competition_name: session.competition_name,
          role: assignment.role,
          status: assignment.status,
          magic_link: magicLinkUrl,
        }),
        idempotencyKey,
      ]
    );

    await client.query('COMMIT');

    const response = { assignment };
    if (process.env.NODE_ENV !== 'production') {
      response.magicLinkUrl = magicLinkUrl;
      response.rawToken = rawToken;
    }

    res.status(201).json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/assignments/:id
 * Role only. Judge/session change requires delete+recreate to preserve EXCLUDE semantics.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const validation = validateAssignmentPatch(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const check = await db.query('SELECT * FROM judge_assignments WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const updateRes = await db.query(
      `UPDATE judge_assignments
       SET role = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.body.role, id]
    );

    res.json({ assignment: updateRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/assignments/:id
 * Soft delete: sets status = 'cancelled' (never hard delete).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const check = await db.query('SELECT * FROM judge_assignments WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const updateRes = await db.query(
      `UPDATE judge_assignments
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Invalidate assignment tokens
    await db.query(
      `UPDATE auth_tokens SET expires_at = NOW() WHERE assignment_id = $1 AND expires_at > NOW()`,
      [id]
    );

    res.json({
      message: 'Assignment cancelled successfully',
      assignment: updateRes.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/assignments/:id/confirm
 * Admin override: set status = 'confirmed', logged to audit_log with reason.
 */
router.post('/:id/confirm', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const reason = req.body.reason || 'Admin manual override confirmation';

    await client.query('BEGIN');

    const check = await client.query('SELECT * FROM judge_assignments WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const updateRes = await client.query(
      `UPDATE judge_assignments
       SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Log admin override to audit_log
    const actorId = req.session?.user?.id || null;
    await client.query(
      `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
       VALUES ('judge_assignments', $1, 'UPDATE', jsonb_build_object('status', 'confirmed', 'override_reason', $2::text), $3)`,
      [id, reason, actorId]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Assignment confirmed via admin override',
      assignment: updateRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/assignments/:id/replace
 * Replacement workflow.
 * With replacement: new assignment row ('held', replaces_assignment_id=:id), old -> ('replaced', superseded_by=new_id).
 * Without: old -> 'replaced' (vacancy).
 */
router.post('/:id/replace', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const validation = validateReplacementInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { replacement_judge_id, reason } = req.body;

    await client.query('BEGIN');

    const oldRes = await client.query(
      `SELECT ja.*, s.name AS session_name, c.name AS competition_name
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       JOIN competitions c ON c.id = s.competition_id
       WHERE ja.id = $1`,
      [id]
    );
    if (oldRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const oldAssignment = oldRes.rows[0];

    // Case 1: Without replacement (mark vacancy)
    if (!replacement_judge_id) {
      const updateOld = await client.query(
        `UPDATE judge_assignments
         SET status = 'replaced', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      const actorId = req.session?.user?.id || null;
      await client.query(
        `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
         VALUES ('judge_assignments', $1, 'UPDATE', jsonb_build_object('status', 'replaced', 'reason', $2::text), $3)`,
        [id, reason || 'Marked as vacancy', actorId]
      );

      await client.query('COMMIT');
      return res.json({
        message: 'Assignment marked as replaced (vacant)',
        assignment: updateOld.rows[0],
      });
    }

    // Case 2: With replacement judge
    const repJudgeRes = await client.query('SELECT * FROM judges WHERE id = $1', [replacement_judge_id]);
    if (repJudgeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Replacement judge not found' });
    }
    const repJudge = repJudgeRes.rows[0];
    if (repJudge.status === 'inactive' || repJudge.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Replacement judge is inactive' });
    }

    // Insert new replacement assignment row
    let newAssignment;
    try {
      const insNew = await client.query(
        `INSERT INTO judge_assignments (
          session_id, judge_id, role, status, replaces_assignment_id
        ) VALUES ($1, $2, $3, 'held', $4)
        RETURNING *`,
        [oldAssignment.session_id, replacement_judge_id, oldAssignment.role, id]
      );
      newAssignment = insNew.rows[0];
    } catch (dbErr) {
      if (dbErr.code === '23P01') { // exclusion_violation
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'overlap',
          message: 'Replacement judge is already assigned to an overlapping session',
        });
      }
      if (dbErr.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Replacement judge is already assigned to this session',
        });
      }
      throw dbErr;
    }

    // Update old assignment: status = 'replaced', superseded_by = new_id
    const updOld = await client.query(
      `UPDATE judge_assignments
       SET status = 'replaced', superseded_by = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newAssignment.id, id]
    );

    // Produce outbox row
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO auth_tokens (
        judge_id, assignment_id, token_hash, purpose, expires_at
      ) VALUES ($1, $2, $3, 'assignment', $4)`,
      [replacement_judge_id, newAssignment.id, tokenHash, expiresAt]
    );

    const magicLinkUrl = `/j/${rawToken}`;
    const idempotencyKey = `replacement:${newAssignment.id}:${Date.now()}`;

    await client.query(
      `INSERT INTO notification_outbox (
        recipient_email, to_email, recipient_name, channel, subject, body,
        payload, template, idempotency_key, status
      ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'replacement_notification', $7, 'pending')`,
      [
        repJudge.email,
        repJudge.email,
        `${repJudge.first_name} ${repJudge.last_name}`,
        `Urgent Judging Assignment: ${oldAssignment.session_name}`,
        `Dear ${repJudge.first_name}, you have been requested as replacement evaluator for ${oldAssignment.session_name}. Link: ${magicLinkUrl}`,
        JSON.stringify({
          assignment_id: newAssignment.id,
          replaces_assignment_id: id,
          session_id: oldAssignment.session_id,
          reason,
          magic_link: magicLinkUrl,
        }),
        idempotencyKey,
      ]
    );

    // Log to audit_log
    const actorId = req.session?.user?.id || null;
    await client.query(
      `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
       VALUES ('judge_assignments', $1, 'UPDATE', jsonb_build_object('action', 'replace', 'superseded_by', $2::bigint, 'reason', $3::text), $4)`,
      [id, newAssignment.id, reason || 'Replacement assigned', actorId]
    );

    await client.query('COMMIT');

    const response = {
      message: 'Replacement assigned successfully',
      old_assignment: updOld.rows[0],
      replacement_assignment: newAssignment,
    };
    if (process.env.NODE_ENV !== 'production') {
      response.magicLinkUrl = magicLinkUrl;
      response.rawToken = rawToken;
    }

    res.status(201).json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/assignments/:id/replacement-candidates
 * Candidate judges for replacement (delegates to candidate query for that session).
 */
router.get('/:id/replacement-candidates', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const assignRes = await db.query('SELECT session_id FROM judge_assignments WHERE id = $1', [id]);
    if (assignRes.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const candidates = await getSessionCandidates(assignRes.rows[0].session_id);
    if (!candidates) {
      return res.status(404).json({ error: 'Session not found' });
    }
    return res.json({
      assignment_id: Number(id),
      session_id: assignRes.rows[0].session_id,
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/assignments/:id/cancel-replacement
 * 10-minute undo window only: hard delete the replacement, old back to 'confirmed',
 * clear superseded_by, log audit. After window -> 409.
 */
router.post('/:id/cancel-replacement', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    await client.query('BEGIN');

    // Find if :id is the old assignment or the replacement assignment
    const assignRes = await client.query('SELECT * FROM judge_assignments WHERE id = $1', [id]);
    if (assignRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const row = assignRes.rows[0];
    let oldAssignmentId;
    let replacementAssignmentId;

    if (row.superseded_by) {
      oldAssignmentId = row.id;
      replacementAssignmentId = row.superseded_by;
    } else if (row.replaces_assignment_id) {
      oldAssignmentId = row.replaces_assignment_id;
      replacementAssignmentId = row.id;
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Assignment is not part of a replacement relationship' });
    }

    const repRes = await client.query('SELECT * FROM judge_assignments WHERE id = $1', [replacementAssignmentId]);
    if (repRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Replacement assignment not found' });
    }
    const replacementAssignment = repRes.rows[0];

    // Check 10-minute window
    const createdAt = new Date(replacementAssignment.created_at).getTime();
    const ageMinutes = (Date.now() - createdAt) / (1000 * 60);

    if (ageMinutes > 10) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: '10-minute undo window has elapsed; replacement cannot be cancelled',
        age_minutes: Math.round(ageMinutes),
      });
    }

    // Hard-delete the newly created replacement assignment
    await client.query('DELETE FROM judge_assignments WHERE id = $1', [replacementAssignmentId]);

    // Revert old assignment back to 'confirmed' and clear superseded_by
    const reverted = await client.query(
      `UPDATE judge_assignments
       SET status = 'confirmed', superseded_by = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [oldAssignmentId]
    );

    // Audit log
    const actorId = req.session?.user?.id || null;
    await client.query(
      `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
       VALUES ('judge_assignments', $1, 'UPDATE', jsonb_build_object('action', 'cancel_replacement', 'deleted_replacement_id', $2::bigint), $3)`,
      [oldAssignmentId, replacementAssignmentId, actorId]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Replacement cancelled and original assignment restored',
      assignment: reverted.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/assignments/:id/attendance
 * Admin manual correction of attendance. Logs to audit_log.
 */
router.patch('/:id/attendance', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const validation = validateAttendancePatch(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { status, note, notes } = req.body;
    const comment = note || notes || null;

    await client.query('BEGIN');

    const assignCheck = await client.query('SELECT * FROM judge_assignments WHERE id = $1', [id]);
    if (assignCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const actorId = req.session?.user?.id || null;

    // Upsert attendance
    const upsertRes = await client.query(
      `INSERT INTO assignment_attendance (
        assignment_id, status, notes, marked_by, updated_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (assignment_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        marked_by = EXCLUDED.marked_by,
        updated_at = NOW()
      RETURNING *`,
      [id, status, comment, actorId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
       VALUES ('assignment_attendance', $1, 'UPDATE', jsonb_build_object('status', $2::text, 'notes', $3::text), $4)`,
      [upsertRes.rows[0].id, status, comment, actorId]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Attendance record updated successfully',
      attendance: upsertRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
