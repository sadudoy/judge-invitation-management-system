'use strict';

const path = require('path');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashToken } = require('../lib/tokens');
const { createRateLimiter } = require('../middleware/rate-limiter');
const {
  validateResponseInput,
  validateAvailabilityInput,
  validateConflictsInput,
  validateAssignmentResponse,
  isInteger,
} = require('../lib/validate');

// In-memory rate limiter on judge portal endpoints (60 requests per minute)
const portalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests to judge portal, please try again shortly.',
});

router.use(portalLimiter);

/**
 * Helper: Resolve and validate token record.
 * Throws 400, 404, or 410 appropriately.
 */
async function resolveTokenRecord(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length < 16) {
    const err = new Error('Invalid or missing token format');
    err.status = 404;
    throw err;
  }

  const tokenHash = hashToken(rawToken.trim());

  const query = `
    SELECT t.id AS token_id, t.judge_id, t.invitation_id, t.expires_at, t.used_at,
           t.created_at AS token_created_at, t.purpose, t.assignment_id,
           j.first_name, j.last_name, j.email, j.organization, j.kind, j.is_active,
           ji.status AS invitation_status,
           COALESCE(ji.competition_id, s.competition_id) AS competition_id,
           COALESCE(ji.event_id, comp.event_id) AS event_id,
           COALESCE(c.name, comp.name) AS competition_name,
           COALESCE(c.description, comp.description) AS competition_description,
           COALESCE(e.name, ev.name) AS event_name,
           COALESCE(e.start_date, ev.start_date) AS event_start_date,
           COALESCE(e.end_date, ev.end_date) AS event_end_date
    FROM auth_tokens t
    JOIN judges j ON j.id = t.judge_id
    LEFT JOIN judge_invitations ji ON ji.id = t.invitation_id
    LEFT JOIN competitions c ON c.id = ji.competition_id
    LEFT JOIN events e ON e.id = ji.event_id
    LEFT JOIN judge_assignments ja ON ja.id = t.assignment_id
    LEFT JOIN sessions s ON s.id = ja.session_id
    LEFT JOIN competitions comp ON comp.id = s.competition_id
    LEFT JOIN events ev ON ev.id = comp.event_id
    WHERE t.token_hash = $1
    LIMIT 1;
  `;

  const result = await db.query(query, [tokenHash]);
  if (result.rows.length === 0) {
    const err = new Error('Invitation link not found or invalid');
    err.status = 404;
    throw err;
  }

  const record = result.rows[0];
  const now = new Date();
  const expiresAt = new Date(record.expires_at);

  if (now > expiresAt) {
    const err = new Error('This invitation link has expired');
    err.status = 410; // Gone / Expired
    err.expired = true;
    throw err;
  }

  return record;
}

/**
 * GET /j/:token
 * Serves the judge portal HTML page or returns clean expired/invalid HTML.
 */
router.get('/j/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    await resolveTokenRecord(token);

    const portalPath = path.join(__dirname, '..', '..', 'client', 'j.html');
    res.sendFile(portalPath);
  } catch (err) {
    const status = err.status || 500;
    if (status === 404 || status === 410) {
      const isExpired = status === 410;
      return res.status(status).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${isExpired ? 'Invitation Expired' : 'Invalid Link'} - CSE Fest</title>
          <link rel="stylesheet" href="/style.css">
        </head>
        <body class="public-portal-body">
          <main class="portal-card error-card">
            <div class="portal-badge ${isExpired ? 'badge-warning' : 'badge-danger'}">
              ${isExpired ? 'Link Expired' : 'Link Invalid'}
            </div>
            <h2>${isExpired ? 'This Invitation Has Expired' : 'Invalid Invitation Link'}</h2>
            <p>
              ${
                isExpired
                  ? 'The deadline to respond via this link has passed. Please contact the CSE Fest event coordinators if you believe this is in error.'
                  : 'We could not find a valid invitation matching this link. Please check that you copied the complete URL from your email.'
              }
            </p>
            <p class="text-muted">CSE Fest &bull; Judge Management System</p>
          </main>
        </body>
        </html>
      `);
    }
    next(err);
  }
});

/**
 * GET /api/j/:token
 * Returns invitation, competition details, and existing declarations.
 */
router.get('/api/j/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    // Query declared availability for this judge & event
    const availRes = await db.query(
      `SELECT id, available_window, during, status, notes, created_at
       FROM judge_availability
       WHERE judge_id = $1 AND event_id = $2
       ORDER BY created_at ASC`,
      [record.judge_id, record.event_id]
    );

    // Query declared conflicts (strictly blinded: only judge's own free-text entries)
    const conflictsRes = await db.query(
      `SELECT id, subject_kind, subject_name, severity, description, superseded_by, created_at
       FROM judge_conflicts
       WHERE judge_id = $1 AND competition_id = $2
       ORDER BY created_at ASC`,
      [record.judge_id, record.competition_id]
    );

    // Query active assignments for this judge
    const assignmentsRes = await db.query(
      `SELECT ja.id, ja.session_id, ja.role, ja.status, ja.assignment_window,
              s.name AS session_name, s.start_time, s.end_time, s.reporting_at, s.grace_minutes,
              c.name AS competition_name, v.name AS venue_name,
              aa.status AS attendance_status, aa.check_in_time, aa.checked_out_at, aa.minutes_late
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       JOIN competitions c ON c.id = s.competition_id
       LEFT JOIN venues v ON v.id = s.venue_id
       LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
       WHERE ja.judge_id = $1 AND ja.status <> 'cancelled'
       ORDER BY s.start_time ASC`,
      [record.judge_id]
    );

    res.json({
      judge: {
        first_name: record.first_name,
        last_name: record.last_name,
        email: record.email,
        organization: record.organization,
        kind: record.kind,
      },
      competition: {
        id: record.competition_id,
        name: record.competition_name,
        description: record.competition_description,
      },
      event: {
        id: record.event_id,
        name: record.event_name,
        start_date: record.event_start_date,
        end_date: record.event_end_date,
      },
      invitation: {
        id: record.invitation_id,
        status: record.invitation_status,
        expires_at: record.expires_at,
        is_used: Boolean(record.used_at),
      },
      availability: availRes.rows,
      conflicts: conflictsRes.rows,
      assignments: assignmentsRes.rows,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, expired: Boolean(err.expired) });
    }
    next(err);
  }
});

/**
 * POST /api/j/:token/view
 * Idempotently mark invitation as viewed.
 */
router.post('/api/j/:token/view', async (req, res, next) => {
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    if (record.invitation_status === 'sent') {
      await db.query(
        "UPDATE judge_invitations SET status = 'viewed', updated_at = NOW() WHERE id = $1",
        [record.invitation_id]
      );
      record.invitation_status = 'viewed';
    }

    res.json({
      message: 'Invitation viewed',
      status: record.invitation_status,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/j/:token/respond
 * Submit RSVP response (accepted, declined, tentative). Single-use.
 */
router.post('/api/j/:token/respond', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    // Validation
    const validation = validateResponseInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { response, reason, note } = req.body;
    const comment = reason || note || null;

    // Single-use check: reject if token already used or invitation already in terminal/decided state
    if (record.used_at !== null || ['accepted', 'declined'].includes(record.invitation_status)) {
      return res.status(409).json({
        error: 'This invitation has already been responded to and cannot be resubmitted',
      });
    }

    await client.query('BEGIN');

    // Update invitation status
    await client.query(
      'UPDATE judge_invitations SET status = $1, updated_at = NOW() WHERE id = $2',
      [response, record.invitation_id]
    );

    // Record response in audit/history table
    const ipAddress = req.ip || req.connection.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    await client.query(
      `INSERT INTO invitation_responses (
        invitation_id, response, response_notes, ip_address, user_agent, responded_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [record.invitation_id, response, comment, ipAddress, userAgent]
    );

    // Mark auth_tokens as used
    await client.query(
      'UPDATE auth_tokens SET used_at = NOW() WHERE id = $1',
      [record.token_id]
    );

    // Produce outbox row for coordinator notification
    const idempotencyKey = `resp_${record.invitation_id}_${response}_${Date.now()}`;
    await client.query(
      `INSERT INTO notification_outbox (
        recipient_email, to_email, recipient_name, channel, subject, body,
        payload, template, idempotency_key, status
      ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_response_notification', $7, 'pending')`,
      [
        'admin@csefest.edu',
        'admin@csefest.edu',
        'CSE Fest Coordinators',
        `Judge Response: ${record.first_name} ${record.last_name} [${response.toUpperCase()}]`,
        `Judge ${record.first_name} ${record.last_name} has responded with: ${response}.`,
        JSON.stringify({
          invitation_id: record.invitation_id,
          judge_id: record.judge_id,
          judge_name: `${record.first_name} ${record.last_name}`,
          competition_name: record.competition_name,
          response,
          comment,
        }),
        idempotencyKey,
      ]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Response recorded successfully',
      status: response,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/j/:token/availability
 * Declare availability windows.
 * 24h replacement policy: replaces prior declarations if within 24h of token creation,
 * otherwise appends.
 */
router.post('/api/j/:token/availability', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    const validation = validateAvailabilityInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const slots = req.body.slots || req.body.windows || [];
    if (slots.length === 0) {
      return res.status(400).json({ error: 'At least one slot is required' });
    }

    await client.query('BEGIN');

    // 24h fresh replacement policy vs append-only
    const tokenAgeMs = Date.now() - new Date(record.token_created_at).getTime();
    const isWithin24h = tokenAgeMs <= 24 * 60 * 60 * 1000;

    if (isWithin24h) {
      // Clean replace prior availability for this judge and event
      await client.query(
        'DELETE FROM judge_availability WHERE judge_id = $1 AND event_id = $2',
        [record.judge_id, record.event_id]
      );
    }

    const insertedRows = [];
    for (const slot of slots) {
      const isAvailable = slot.is_available !== false && slot.status !== 'unavailable';
      const status = isAvailable ? 'available' : 'unavailable';
      const notes = slot.notes ? String(slot.notes).slice(0, 500) : null;

      const ins = await client.query(
        `INSERT INTO judge_availability (
          judge_id, event_id, available_window, status, notes
        ) VALUES ($1, $2, tstzrange($3, $4, '[]'), $5, $6)
        RETURNING id, available_window, during, status, notes, created_at`,
        [record.judge_id, record.event_id, slot.start_time, slot.end_time, status, notes]
      );
      insertedRows.push(ins.rows[0]);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Availability declared successfully',
      replaced_prior: isWithin24h,
      count: insertedRows.length,
      availability: insertedRows,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/j/:token/conflicts
 * Declare conflict of interest items.
 * Append-only with predecessor pointer update (superseded_by).
 * Strict blinding: Never exposes participant rosters or matched names.
 */
router.post('/api/j/:token/conflicts', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    const validation = validateConflictsInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const conflicts = req.body.conflicts;

    await client.query('BEGIN');

    const inserted = [];
    for (const item of conflicts) {
      const subjectKind = item.subject_kind ? String(item.subject_kind).slice(0, 100) : null;
      const subjectName = item.subject_name ? String(item.subject_name).slice(0, 200) : null;
      const description = String(item.description).trim();
      const severity = ['low', 'medium', 'high'].includes(item.severity) ? item.severity : 'medium';
      const conflictType = ['student_supervision', 'co_author', 'institutional', 'personal', 'other'].includes(item.conflict_type)
        ? item.conflict_type
        : 'other';

      // Insert new conflict row (append-only)
      const insRes = await client.query(
        `INSERT INTO judge_conflicts (
          judge_id, competition_id, conflict_type, subject_kind, subject_name, description, severity
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, subject_kind, subject_name, description, severity, created_at`,
        [record.judge_id, record.competition_id, conflictType, subjectKind, subjectName, description, severity]
      );
      const newConflict = insRes.rows[0];

      // If supersedes a prior conflict
      if (item.supersedes_id) {
        // Exercise column-level UPDATE (superseded_by) on predecessor row
        await client.query(
          `UPDATE judge_conflicts
           SET superseded_by = $1
           WHERE id = $2 AND judge_id = $3`,
          [newConflict.id, item.supersedes_id, record.judge_id]
        );
      }

      inserted.push(newConflict);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Conflicts declared successfully',
      count: inserted.length,
      conflicts: inserted,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/j/:token/assignment/:assignment_id/respond
 * Submit assignment response (accepted -> confirmed, declined -> declined).
 * Single-use token: token is tied to assignment (or token is verified for judge_id).
 */
router.post('/api/j/:token/assignment/:assignment_id/respond', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token, assignment_id } = req.params;
    if (!isInteger(assignment_id)) {
      return res.status(400).json({ error: 'Invalid assignment ID' });
    }

    const record = await resolveTokenRecord(token);

    // Replay check on token
    if (record.used_at !== null) {
      return res.status(409).json({ error: 'This token has already been used and cannot be replayed' });
    }

    const validation = validateAssignmentResponse(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { response, reason, note } = req.body;
    const comment = reason || note || null;

    await client.query('BEGIN');

    // Retrieve assignment
    const assignRes = await client.query(
      `SELECT ja.*, s.name AS session_name, c.name AS competition_name
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       JOIN competitions c ON c.id = s.competition_id
       WHERE ja.id = $1`,
      [assignment_id]
    );

    if (assignRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignRes.rows[0];

    // Check wrong judge token -> 403
    if (Number(assignment.judge_id) !== Number(record.judge_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden: token does not match the judge assigned to this session' });
    }

    // Check wrong assignment token if token has assignment_id bound
    if (record.assignment_id && Number(record.assignment_id) !== Number(assignment.id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden: token does not match this assignment' });
    }

    // Check if already in terminal state
    if (['confirmed', 'declined'].includes(assignment.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Assignment has already been responded to' });
    }

    const newStatus = (response === 'accepted' || response === 'confirmed') ? 'confirmed' : 'declined';

    // Update assignment status
    await client.query(
      `UPDATE judge_assignments SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, assignment_id]
    );

    // Insert assignment response history
    await client.query(
      `INSERT INTO assignment_responses (
        assignment_id, response, reason, responded_at
      ) VALUES ($1, $2, $3, NOW())`,
      [assignment_id, newStatus, comment]
    );

    // Mark token as used
    await client.query(
      `UPDATE auth_tokens SET used_at = NOW() WHERE id = $1`,
      [record.token_id]
    );

    // If declined, alert coordinator via outbox
    if (newStatus === 'declined') {
      const idempotencyKey = `declined_alert:${assignment.id}:${Date.now()}`;
      await client.query(
        `INSERT INTO notification_outbox (
          recipient_email, to_email, recipient_name, channel, subject, body,
          payload, template, idempotency_key, status
        ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_declined_assignment_alert', $7, 'pending')`,
        [
          'coordinator@csefest.edu',
          'coordinator@csefest.edu',
          'CSE Fest Coordinator',
          `Judge Declined Assignment: ${record.first_name} ${record.last_name}`,
          `Judge ${record.first_name} ${record.last_name} has declined assignment #${assignment.id} for session ${assignment.session_name}. Reason: ${comment || 'No reason provided'}.`,
          JSON.stringify({
            assignment_id: assignment.id,
            session_id: assignment.session_id,
            judge_id: record.judge_id,
            reason: comment,
          }),
          idempotencyKey,
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Assignment response recorded successfully',
      status: newStatus,
      assignment_id: Number(assignment_id),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message, expired: Boolean(err.expired) });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/j/:token/checkin
 * Judge self-checkin.
 * Computes minutes_late vs (reporting_at + grace_minutes); status='checked_in'|'late'
 */
router.post('/api/j/:token/checkin', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    if (record.used_at !== null && record.purpose === 'checkin') {
      return res.status(409).json({ error: 'This check-in link has already been used' });
    }

    await client.query('BEGIN');

    let assignmentId = req.body?.assignment_id || record.assignment_id;
    let assignment;

    if (assignmentId) {
      const aRes = await client.query(
        `SELECT ja.*, s.name AS session_name, s.start_time, s.end_time, s.reporting_at, s.grace_minutes
         FROM judge_assignments ja
         JOIN sessions s ON s.id = ja.session_id
         WHERE ja.id = $1`,
        [assignmentId]
      );
      if (aRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Assignment not found' });
      }
      assignment = aRes.rows[0];
      if (Number(assignment.judge_id) !== Number(record.judge_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden: assignment does not belong to this judge' });
      }
    } else {
      // Find current or upcoming assignment
      const aRes = await client.query(
        `SELECT ja.*, s.name AS session_name, s.start_time, s.end_time, s.reporting_at, s.grace_minutes
         FROM judge_assignments ja
         JOIN sessions s ON s.id = ja.session_id
         WHERE ja.judge_id = $1 AND ja.status IN ('confirmed', 'assigned', 'held')
         ORDER BY s.start_time ASC
         LIMIT 1`,
        [record.judge_id]
      );
      if (aRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No active judging assignment found for check-in' });
      }
      assignment = aRes.rows[0];
    }

    // Calculate reporting deadline & grace
    const reportingTime = assignment.reporting_at
      ? new Date(assignment.reporting_at)
      : new Date(new Date(assignment.start_time).getTime() - 15 * 60000);
    const graceMinutes = assignment.grace_minutes !== undefined && assignment.grace_minutes !== null
      ? assignment.grace_minutes
      : 15;
    const graceDeadline = new Date(reportingTime.getTime() + graceMinutes * 60000);

    const now = new Date();
    let status;
    let minutesLate = 0;

    if (now.getTime() <= graceDeadline.getTime()) {
      status = 'checked_in';
      minutesLate = 0;
    } else {
      status = 'late';
      minutesLate = Math.max(1, Math.ceil((now.getTime() - graceDeadline.getTime()) / 60000));
    }

    const note = req.body?.notes || req.body?.note || null;

    // Upsert assignment_attendance
    const attRes = await client.query(
      `INSERT INTO assignment_attendance (
        assignment_id, status, check_in_time, minutes_late, notes, updated_at
      ) VALUES ($1, $2, NOW(), $3, $4, NOW())
      ON CONFLICT (assignment_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        check_in_time = COALESCE(assignment_attendance.check_in_time, EXCLUDED.check_in_time),
        minutes_late = EXCLUDED.minutes_late,
        notes = COALESCE(EXCLUDED.notes, assignment_attendance.notes),
        updated_at = NOW()
      RETURNING *`,
      [assignment.id, status, minutesLate, note]
    );

    if (record.purpose === 'checkin') {
      await client.query('UPDATE auth_tokens SET used_at = NOW() WHERE id = $1', [record.token_id]);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Checked in successfully',
      status,
      minutes_late: minutesLate,
      attendance: attRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message, expired: Boolean(err.expired) });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/j/:token/checkout
 * Judge checkout: status='early_departure' if now < session.end_time
 */
router.post('/api/j/:token/checkout', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { token } = req.params;
    const record = await resolveTokenRecord(token);

    await client.query('BEGIN');

    let assignmentId = req.body?.assignment_id || record.assignment_id;
    let assignment;

    if (assignmentId) {
      const aRes = await client.query(
        `SELECT ja.*, s.name AS session_name, s.start_time, s.end_time
         FROM judge_assignments ja
         JOIN sessions s ON s.id = ja.session_id
         WHERE ja.id = $1`,
        [assignmentId]
      );
      if (aRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Assignment not found' });
      }
      assignment = aRes.rows[0];
      if (Number(assignment.judge_id) !== Number(record.judge_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden: assignment does not belong to this judge' });
      }
    } else {
      const aRes = await client.query(
        `SELECT ja.*, s.name AS session_name, s.start_time, s.end_time
         FROM judge_assignments ja
         JOIN sessions s ON s.id = ja.session_id
         WHERE ja.judge_id = $1 AND ja.status IN ('confirmed', 'assigned', 'held')
         ORDER BY s.start_time ASC
         LIMIT 1`,
        [record.judge_id]
      );
      if (aRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No active judging assignment found for check-out' });
      }
      assignment = aRes.rows[0];
    }

    const now = new Date();
    const sessionEndTime = new Date(assignment.end_time);
    const isEarly = now.getTime() < sessionEndTime.getTime();
    const checkoutStatus = isEarly ? 'early_departure' : 'checked_in';

    const note = req.body?.notes || req.body?.note || null;

    const attRes = await client.query(
      `INSERT INTO assignment_attendance (
        assignment_id, status, checked_out_at, notes, updated_at
      ) VALUES ($1, $2, NOW(), $3, NOW())
      ON CONFLICT (assignment_id)
      DO UPDATE SET
        status = CASE WHEN $2 = 'early_departure' THEN 'early_departure' ELSE assignment_attendance.status END,
        checked_out_at = NOW(),
        notes = COALESCE(EXCLUDED.notes, assignment_attendance.notes),
        updated_at = NOW()
      RETURNING *`,
      [assignment.id, checkoutStatus, note]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Checked out successfully',
      status: attRes.rows[0].status,
      early_departure: isEarly,
      attendance: attRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) {
      return res.status(err.status).json({ error: err.message, expired: Boolean(err.expired) });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
