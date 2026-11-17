'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isInteger } = require('../lib/validate');

// All coverage and feasibility endpoints require authentication
router.use(requireAuth);

/**
 * Helper: Find candidate judges for a given session.
 */
async function getSessionCandidates(sessionId) {
  const check = await db.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
  if (check.rows.length === 0) {
    return null;
  }

  const sql = `
    WITH sess AS (
      SELECT s.id, s.competition_id,
             tstzrange(s.start_time, s.end_time + (s.buffer_minutes || ' minutes')::interval, '[)') AS window
      FROM sessions s
      WHERE s.id = $1
    )
    SELECT j.id, j.first_name, j.last_name, j.email, j.organization, j.kind, j.expertise
    FROM judges j
    CROSS JOIN sess
    WHERE j.is_active = true
      -- (a) No overlapping assignment
      AND NOT EXISTS (
        SELECT 1 FROM judge_assignments ja
        WHERE ja.judge_id = j.id
          AND ja.status <> 'cancelled'
          AND ja.assignment_window && sess.window
      )
      -- (b) No COI declared directly on this competition
      AND NOT EXISTS (
        SELECT 1 FROM judge_conflicts jc
        WHERE jc.judge_id = j.id
          AND jc.competition_id = sess.competition_id
      )
      -- (c) Not marked unavailable
      AND NOT EXISTS (
        SELECT 1 FROM judge_availability ja
        WHERE ja.judge_id = j.id
          AND ja.status = 'unavailable'
          AND ja.available_window && sess.window
      )
      -- (d) Available per judge_availability (or general active pool if no restrictions)
      AND (
        EXISTS (
          SELECT 1 FROM judge_availability ja
          WHERE ja.judge_id = j.id
            AND ja.status = 'available'
            AND ja.available_window && sess.window
        )
        OR NOT EXISTS (
          SELECT 1 FROM judge_availability ja
          WHERE ja.judge_id = j.id
        )
      )
    ORDER BY j.last_name ASC, j.first_name ASC
    LIMIT 50;
  `;

  const candidatesRes = await db.query(sql, [sessionId]);
  return candidatesRes.rows;
}

/**
 * GET /api/sessions/:id/coverage
 * Required vs confirmed judges, missing head, gaps list.
 */
router.get('/sessions/:id/coverage', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const sessRes = await db.query(
      `SELECT s.*, c.name AS competition_name, c.min_judges, c.max_judges
       FROM sessions s
       JOIN competitions c ON c.id = s.competition_id
       WHERE s.id = $1`,
      [id]
    );

    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessRes.rows[0];

    // Query assignments for this session
    const assignRes = await db.query(
      `SELECT ja.*, j.first_name, j.last_name, j.email, j.organization
       FROM judge_assignments ja
       JOIN judges j ON j.id = ja.judge_id
       WHERE ja.session_id = $1 AND ja.status <> 'cancelled'`,
      [id]
    );

    const assignments = assignRes.rows;
    const requiredJudges = session.min_judges || 2;
    const confirmedJudges = assignments.filter((a) => a.status === 'confirmed').length;
    const totalAssigned = assignments.length;
    const hasHeadJudge = assignments.some(
      (a) => a.role === 'head_judge' && ['confirmed', 'held', 'assigned'].includes(a.status)
    );

    const gaps = [];
    if (!hasHeadJudge) {
      gaps.push('Missing head judge');
    }
    if (confirmedJudges < requiredJudges) {
      const missingCount = requiredJudges - confirmedJudges;
      gaps.push(`Need ${missingCount} more confirmed judge${missingCount > 1 ? 's' : ''}`);
    }

    res.json({
      session_id: Number(id),
      session_name: session.name,
      competition_name: session.competition_name,
      required_judges: requiredJudges,
      confirmed_judges: confirmedJudges,
      total_assigned: totalAssigned,
      missing_head: !hasHeadJudge,
      missing_judges: Math.max(0, requiredJudges - confirmedJudges),
      is_covered: gaps.length === 0,
      gaps,
      assignments,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/competitions/:id/coverage
 * Rollup coverage across all sessions of the competition.
 */
router.get('/competitions/:id/coverage', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid competition ID' });
    }

    const compRes = await db.query(
      `SELECT c.id, c.name, c.min_judges, c.max_judges
       FROM competitions c
       WHERE c.id = $1`,
      [id]
    );
    if (compRes.rows.length === 0) {
      return res.status(404).json({ error: 'Competition not found' });
    }
    const competition = compRes.rows[0];

    const sessRes = await db.query(
      `SELECT s.id, s.name, s.start_time, s.end_time, s.buffer_minutes, s.status
       FROM sessions s
       WHERE s.competition_id = $1
       ORDER BY s.start_time ASC`,
      [id]
    );

    const sessions = sessRes.rows;
    const requiredPerSession = competition.min_judges || 2;

    const sessionCoverage = [];
    let totalRequired = 0;
    let totalConfirmed = 0;
    let fullyCoveredSessions = 0;

    for (const s of sessions) {
      totalRequired += requiredPerSession;

      const assignRes = await db.query(
        `SELECT role, status
         FROM judge_assignments
         WHERE session_id = $1 AND status <> 'cancelled'`,
        [s.id]
      );

      const confirmedCount = assignRes.rows.filter((a) => a.status === 'confirmed').length;
      totalConfirmed += confirmedCount;

      const hasHead = assignRes.rows.some((a) => a.role === 'head_judge' && a.status === 'confirmed');
      const isSessionCovered = confirmedCount >= requiredPerSession && hasHead;
      if (isSessionCovered) fullyCoveredSessions++;

      sessionCoverage.push({
        session_id: s.id,
        session_name: s.name,
        start_time: s.start_time,
        end_time: s.end_time,
        required_judges: requiredPerSession,
        confirmed_judges: confirmedCount,
        has_head_judge: hasHead,
        is_covered: isSessionCovered,
      });
    }

    res.json({
      competition_id: Number(id),
      competition_name: competition.name,
      total_sessions: sessions.length,
      fully_covered_sessions: fullyCoveredSessions,
      total_required_judges: totalRequired,
      total_confirmed_judges: totalConfirmed,
      coverage_percentage: totalRequired > 0 ? Math.round((totalConfirmed / totalRequired) * 100) : 100,
      sessions: sessionCoverage,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/events/:id/feasibility
 * Peak-concurrency sweep algorithm:
 * Sum +1 / -1 at each interval edge, compute max concurrent required vs active judges.
 */
router.get('/events/:id/feasibility', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }

    const eventRes = await db.query('SELECT id, name FROM events WHERE id = $1', [id]);
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Query all sessions for this event
    const sessRes = await db.query(
      `SELECT s.id, s.name, s.start_time, s.end_time, s.buffer_minutes,
              c.min_judges
       FROM sessions s
       JOIN competitions c ON c.id = s.competition_id
       WHERE c.event_id = $1 AND s.status <> 'cancelled'
       ORDER BY s.start_time ASC`,
      [id]
    );

    const sessions = sessRes.rows;

    // Peak-concurrency sweep
    // Points array: { time, delta }
    const points = [];
    for (const s of sessions) {
      const demand = s.min_judges || 2;
      const bufferMs = (s.buffer_minutes || 0) * 60000;
      const startMs = new Date(s.start_time).getTime() - bufferMs;
      const endMs = new Date(s.end_time).getTime() + bufferMs;

      points.push({ time: startMs, delta: demand });
      points.push({ time: endMs, delta: -demand });
    }

    // Sort points: chronologically; if equal time, process delta < 0 (session end) before delta > 0 (session start)
    points.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      return a.delta - b.delta;
    });

    let currentDemand = 0;
    let peakDemand = 0;

    for (const pt of points) {
      currentDemand += pt.delta;
      if (currentDemand > peakDemand) {
        peakDemand = currentDemand;
      }
    }

    // Count available active judges
    const judgesCountRes = await db.query(
      "SELECT COUNT(*)::int AS count FROM judges WHERE is_active = true"
    );
    const activeJudges = judgesCountRes.rows[0]?.count || 0;

    const isFeasible = activeJudges >= peakDemand;

    res.json({
      event_id: Number(id),
      event_name: eventRes.rows[0].name,
      session_count: sessions.length,
      peak: peakDemand,
      available: activeJudges,
      feasible: isFeasible,
      deficit: isFeasible ? 0 : peakDemand - activeJudges,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sessions/:id/candidates
 * ACTIVE judges with no overlapping assignment, no COI match, available.
 */
router.get('/sessions/:id/candidates', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const candidates = await getSessionCandidates(id);
    if (!candidates) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      session_id: Number(id),
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sessions/:id/attendance
 * Per-assignment attendance state for that session (admin/coordinator).
 */
router.get('/sessions/:id/attendance', requireRole('admin', 'coordinator'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const sessRes = await db.query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sql = `
      SELECT ja.id AS assignment_id, ja.judge_id, ja.role, ja.status AS assignment_status,
             j.first_name, j.last_name, j.email, j.organization,
             aa.id AS attendance_id,
             COALESCE(aa.status, 'not_arrived') AS attendance_status,
             aa.check_in_time, aa.checked_out_at, aa.minutes_late, aa.notes
      FROM judge_assignments ja
      JOIN judges j ON j.id = ja.judge_id
      LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
      WHERE ja.session_id = $1 AND ja.status <> 'cancelled'
      ORDER BY j.last_name ASC, j.first_name ASC
    `;

    const result = await db.query(sql, [id]);

    res.json({
      session_id: Number(id),
      session: sessRes.rows[0],
      attendance: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sessions/:id/flag-absent
 * Marks remaining not_arrived -> absent after reporting_at + grace + 5min. Outbox to coordinator.
 */
router.post('/sessions/:id/flag-absent', requireRole('admin', 'coordinator'), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    if (!isInteger(id)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    await client.query('BEGIN');

    const sessRes = await client.query(
      `SELECT s.*, c.name AS competition_name
       FROM sessions s
       JOIN competitions c ON c.id = s.competition_id
       WHERE s.id = $1`,
      [id]
    );
    if (sessRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessRes.rows[0];

    // Find assignments in this session where judge has not checked in
    const missingRes = await client.query(
      `SELECT ja.id AS assignment_id, ja.judge_id, j.first_name, j.last_name, j.email
       FROM judge_assignments ja
       JOIN judges j ON j.id = ja.judge_id
       LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
       WHERE ja.session_id = $1
         AND ja.status IN ('confirmed', 'assigned', 'held')
         AND (aa.id IS NULL OR aa.status IN ('not_arrived'))`,
      [id]
    );

    const absentJudges = [];
    const actorId = req.session?.user?.id || null;

    for (const row of missingRes.rows) {
      // Upsert into assignment_attendance as absent
      const attRes = await client.query(
        `INSERT INTO assignment_attendance (
          assignment_id, status, notes, marked_by, updated_at
        ) VALUES ($1, 'absent', 'Auto-flagged absent past reporting window', $2, NOW())
        ON CONFLICT (assignment_id)
        DO UPDATE SET
          status = 'absent',
          notes = 'Auto-flagged absent past reporting window',
          marked_by = EXCLUDED.marked_by,
          updated_at = NOW()
        RETURNING *`,
        [row.assignment_id, actorId]
      );

      // Audit log
      await client.query(
        `INSERT INTO audit_log (table_name, record_id, action, new_values, actor_id)
         VALUES ('assignment_attendance', $1, 'UPDATE', jsonb_build_object('status', 'absent', 'flagged_by', 'flag-absent'), $2)`,
        [attRes.rows[0].id, actorId]
      );

      // Outbox alert to coordinator
      const idempotencyKey = `absent_alert:${row.assignment_id}:${Date.now()}`;
      await client.query(
        `INSERT INTO notification_outbox (
          recipient_email, to_email, recipient_name, channel, subject, body,
          payload, template, idempotency_key, status
        ) VALUES ($1, $2, $3, 'email', $4, $5, $6, 'judge_absent_alert', $7, 'pending')`,
        [
          'coordinator@csefest.edu',
          'coordinator@csefest.edu',
          'CSE Fest Coordinator',
          `Alert: Judge Absent — ${row.first_name} ${row.last_name}`,
          `Judge ${row.first_name} ${row.last_name} did not arrive for session ${session.name}. Immediate replacement required.`,
          JSON.stringify({
            session_id: session.id,
            session_name: session.name,
            competition_name: session.competition_name,
            assignment_id: row.assignment_id,
            judge_id: row.judge_id,
            judge_name: `${row.first_name} ${row.last_name}`,
          }),
          idempotencyKey,
        ]
      );

      absentJudges.push({
        assignment_id: row.assignment_id,
        judge_id: row.judge_id,
        name: `${row.first_name} ${row.last_name}`,
        email: row.email,
      });
    }

    await client.query('COMMIT');

    res.json({
      message: `Flagged ${absentJudges.length} judge(s) as absent`,
      flagged_count: absentJudges.length,
      absent_judges: absentJudges,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Attach helper to router so other modules can invoke candidate queries
router.handleSessionCandidates = async (req, res, next) => {
  try {
    const candidates = await getSessionCandidates(req.params.id);
    if (!candidates) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({
      session_id: Number(req.params.id),
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = router;
module.exports.getSessionCandidates = getSessionCandidates;
