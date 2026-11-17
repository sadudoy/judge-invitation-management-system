'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateJudgeInput, validateJudgePatch, isInteger } = require('../lib/validate');

// All judge management routes require authentication and admin/coordinator role
router.use(requireAuth, requireRole('admin', 'coordinator'));

/**
 * GET /api/judges
 * Search, filter, and paginate judges.
 */
router.get('/', async (req, res, next) => {
  try {
    const { q, kind, status, organization, expertise, sort_by, order } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);

    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    if (isNaN(offset) || offset < 0) offset = 0;

    const whereClauses = [];
    const params = [];
    let paramIdx = 1;

    // Trigram or text search on name, email, organization
    if (q && typeof q === 'string' && q.trim().length > 0) {
      const searchTerm = q.trim();
      params.push(`%${searchTerm}%`);
      whereClauses.push(`(
        (first_name || ' ' || last_name) ILIKE $${paramIdx} OR
        email ILIKE $${paramIdx} OR
        organization ILIKE $${paramIdx}
      )`);
      paramIdx++;
    }

    if (kind && typeof kind === 'string') {
      params.push(kind);
      whereClauses.push(`kind = $${paramIdx}`);
      paramIdx++;
    }

    if (status && typeof status === 'string') {
      params.push(status);
      whereClauses.push(`status = $${paramIdx}`);
      paramIdx++;
    }

    if (organization && typeof organization === 'string' && organization.trim().length > 0) {
      params.push(`%${organization.trim()}%`);
      whereClauses.push(`organization ILIKE $${paramIdx}`);
      paramIdx++;
    }

    if (expertise) {
      const expertiseList = Array.isArray(expertise) ? expertise : [expertise];
      params.push(expertiseList);
      whereClauses.push(`expertise && $${paramIdx}`);
      paramIdx++;
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Sorting
    const allowedSortFields = {
      name: "first_name || ' ' || last_name",
      created_at: 'created_at',
      status: 'status',
      organization: 'organization',
    };
    const sortField = allowedSortFields[sort_by] || 'created_at';
    const sortOrder = (order && order.toLowerCase() === 'asc') ? 'ASC' : 'DESC';

    // Count query
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM judges ${whereSQL}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    // Data query
    params.push(limit);
    const limitIdx = paramIdx++;
    params.push(offset);
    const offsetIdx = paramIdx++;

    const dataResult = await db.query(
      `SELECT id, first_name, last_name, email, phone, organization, designation,
              expertise, bio, kind, status, is_active, created_at, updated_at
       FROM judges
       ${whereSQL}
       ORDER BY ${sortField} ${sortOrder}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({
      judges: dataResult.rows,
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/judges
 * Create a new judge.
 */
router.post('/', async (req, res, next) => {
  try {
    const validation = validateJudgeInput(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { first_name, last_name, email, phone, organization, designation, expertise, bio, kind, status } = req.body;

    // Case-insensitive email collision check
    const existing = await db.query(
      'SELECT id FROM judges WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Judge with this email already exists' });
    }

    const insertResult = await db.query(
      `INSERT INTO judges (
        first_name, last_name, email, phone, organization, designation,
        expertise, bio, kind, status, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        first_name.trim(),
        last_name.trim(),
        email.trim().toLowerCase(),
        phone ? phone.trim() : null,
        organization ? organization.trim() : null,
        designation ? designation.trim() : null,
        expertise || [],
        bio ? bio.trim() : null,
        kind || 'academic',
        status || 'active',
        (status === undefined || status === 'active'),
      ]
    );

    res.status(201).json({ judge: insertResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Judge with this email already exists' });
    }
    next(err);
  }
});

/**
 * GET /api/judges/:id
 * Retrieve judge details.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid judge ID' });
    }

    const result = await db.query('SELECT * FROM judges WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    res.json({ judge: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/judges/:id
 * Partial update of judge fields.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid judge ID' });
    }

    const validation = validateJudgePatch(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    // Check judge exists
    const checkJudge = await db.query('SELECT id, email FROM judges WHERE id = $1', [id]);
    if (checkJudge.rows.length === 0) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    const data = req.body;

    // Check email uniqueness if email provided
    if (data.email) {
      const emailCollision = await db.query(
        'SELECT id FROM judges WHERE LOWER(email) = LOWER($1) AND id <> $2',
        [data.email.trim(), id]
      );
      if (emailCollision.rows.length > 0) {
        return res.status(409).json({ error: 'Judge with this email already exists' });
      }
    }

    const allowedFields = ['first_name', 'last_name', 'email', 'phone', 'organization', 'designation', 'expertise', 'bio', 'kind', 'status'];
    const updateClauses = [];
    const params = [id];
    let paramIdx = 2;

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        let val = data[field];
        if (typeof val === 'string') val = val.trim();
        if (field === 'email') val = val.toLowerCase();
        params.push(val);
        updateClauses.push(`${field} = $${paramIdx}`);
        paramIdx++;
      }
    }

    if (data.status !== undefined) {
      params.push(data.status === 'active');
      updateClauses.push(`is_active = $${paramIdx}`);
      paramIdx++;
    }

    updateClauses.push('updated_at = NOW()');

    const sql = `UPDATE judges SET ${updateClauses.join(', ')} WHERE id = $1 RETURNING *`;
    const updateResult = await db.query(sql, params);

    res.json({ judge: updateResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Judge with this email already exists' });
    }
    next(err);
  }
});

/**
 * POST /api/judges/:id/deactivate
 * Guarded deactivation against confirmed future assignments.
 */
router.post('/:id/deactivate', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid judge ID' });
    }

    // Check judge exists
    const checkJudge = await db.query('SELECT id, status FROM judges WHERE id = $1', [id]);
    if (checkJudge.rows.length === 0) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    // Guard: check for confirmed or active future assignments
    const futureAssignments = await db.query(
      `SELECT ja.id, s.start_time, s.end_time, c.name AS competition_name
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       JOIN competitions c ON c.id = s.competition_id
       WHERE ja.judge_id = $1
         AND ja.status IN ('confirmed', 'assigned')
         AND s.end_time > NOW()
       LIMIT 1;`,
      [id]
    );

    if (futureAssignments.rows.length > 0) {
      const conflict = futureAssignments.rows[0];
      return res.status(409).json({
        error: 'Cannot deactivate judge with active or confirmed future assignments',
        conflict: {
          assignment_id: conflict.id,
          competition: conflict.competition_name,
          start_time: conflict.start_time,
          end_time: conflict.end_time,
        },
      });
    }

    // Update status to inactive
    const result = await db.query(
      `UPDATE judges
       SET status = 'inactive', is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    res.json({
      message: 'Judge successfully deactivated',
      judge: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/judges/:id/history
 * Complete history of past invitations, assignments, availability, and conflicts.
 */
router.get('/:id/history', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid judge ID' });
    }

    const judgeResult = await db.query('SELECT * FROM judges WHERE id = $1', [id]);
    if (judgeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    const invitations = await db.query(
      `SELECT ji.id, ji.status, ji.sent_at, ji.expires_at, ji.created_at,
              c.id AS competition_id, c.name AS competition_name,
              e.id AS event_id, e.name AS event_name
       FROM judge_invitations ji
       JOIN competitions c ON c.id = ji.competition_id
       LEFT JOIN events e ON e.id = ji.event_id
       WHERE ji.judge_id = $1
       ORDER BY ji.created_at DESC`,
      [id]
    );

    const assignments = await db.query(
      `SELECT ja.id, ja.status, ja.role, ja.assignment_window,
              s.id AS session_id, s.name AS session_name, s.start_time, s.end_time,
              c.name AS competition_name, v.name AS venue_name
       FROM judge_assignments ja
       JOIN sessions s ON s.id = ja.session_id
       JOIN competitions c ON c.id = s.competition_id
       LEFT JOIN venues v ON v.id = s.venue_id
       WHERE ja.judge_id = $1
       ORDER BY s.start_time DESC`,
      [id]
    );

    const availability = await db.query(
      `SELECT id, available_window, during, status, notes, created_at
       FROM judge_availability
       WHERE judge_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    const conflicts = await db.query(
      `SELECT id, subject_kind, subject_name, severity, description, superseded_by, created_at
       FROM judge_conflicts
       WHERE judge_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      judge: judgeResult.rows[0],
      invitations: invitations.rows,
      assignments: assignments.rows,
      availability: availability.rows,
      conflicts: conflicts.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
