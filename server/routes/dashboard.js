'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isInteger } = require('../lib/validate');

// Dashboard routes require authentication
router.use(requireAuth);

/**
 * GET /api/dashboard/summary
 * Aggregated KPI metrics for dashboard cards.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const [
      judgesRes,
      invitationsRes,
      assignmentsRes,
      coverageRes,
      conflictsRes,
      arrivalsRes,
      attendanceRes,
      replacementsRes,
    ] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS count FROM judges WHERE is_active = true"),
      db.query(`
        SELECT
          COUNT(CASE WHEN status IN ('sent', 'viewed') THEN 1 END)::int AS sent,
          COUNT(CASE WHEN status = 'accepted' THEN 1 END)::int AS accepted,
          COUNT(CASE WHEN status = 'declined' THEN 1 END)::int AS declined,
          COUNT(CASE WHEN status IN ('invited', 'sent', 'viewed') THEN 1 END)::int AS pending
        FROM judge_invitations;
      `),
      db.query(`
        SELECT
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END)::int AS confirmed,
          COUNT(CASE WHEN status = 'held' THEN 1 END)::int AS held
        FROM judge_assignments;
      `),
      db.query(`
        SELECT
          COALESCE(SUM(missing), 0)::int AS total_missing,
          COUNT(CASE WHEN status = 'understaffed' THEN 1 END)::int AS unassigned_sessions
        FROM mv_session_coverage;
      `),
      db.query("SELECT COUNT(*)::int AS count FROM judge_conflicts WHERE superseded_by IS NULL"),
      db.query(`
        SELECT COUNT(DISTINCT ja.id)::int AS count
        FROM judge_assignments ja
        JOIN sessions s ON s.id = ja.session_id
        WHERE DATE(s.start_time AT TIME ZONE 'Asia/Dhaka') = CURRENT_DATE
          AND ja.status IN ('confirmed', 'held');
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM assignment_attendance
        WHERE status IN ('checked_in', 'late');
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM judge_assignments
        WHERE status IN ('replaced', 'held') AND superseded_by IS NULL;
      `),
    ]);

    const inv = invitationsRes.rows[0] || {};
    const asg = assignmentsRes.rows[0] || {};
    const cov = coverageRes.rows[0] || {};

    res.json({
      total_judges: judgesRes.rows[0]?.count || 0,
      invitations_sent: inv.sent || 0,
      invitations_accepted: inv.accepted || 0,
      invitations_declined: inv.declined || 0,
      invitations_pending: inv.pending || 0,
      assignments_confirmed: asg.confirmed || 0,
      assignments_held: asg.held || 0,
      unassigned_sessions: cov.unassigned_sessions || 0,
      scheduling_conflicts: conflictsRes.rows[0]?.count || 0,
      expected_arrivals_today: arrivalsRes.rows[0]?.count || 0,
      checked_in: attendanceRes.rows[0]?.count || 0,
      missing: cov.total_missing || 0,
      replacements_open: replacementsRes.rows[0]?.count || 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/coverage
 * Filterable session coverage read directly from mv_session_coverage.
 */
router.get('/coverage', async (req, res, next) => {
  try {
    const { status, competition_id } = req.query;
    const conditions = [];
    const values = [];

    if (status && typeof status === 'string' && status.trim().length > 0) {
      values.push(status.trim().toLowerCase());
      conditions.push(`status = $${values.length}`);
    }

    if (competition_id && isInteger(competition_id)) {
      values.push(parseInt(competition_id, 10));
      conditions.push(`competition_id = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT session_id, session_name, competition_id, competition_name,
             start_time, end_time, session_status, required_judges, confirmed_count,
             total_assigned, has_head, missing, status
      FROM mv_session_coverage
      ${whereClause}
      ORDER BY start_time ASC, session_id ASC;
    `;

    const result = await db.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/workload
 * Judge workload leaderboard read directly from mv_judge_workload.
 */
router.get('/workload', async (req, res, next) => {
  try {
    const { order = 'desc', limit = '20', kind } = req.query;
    const sortDir = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const conditions = [];
    const values = [];

    if (kind && typeof kind === 'string' && kind.trim().length > 0) {
      values.push(kind.trim());
      conditions.push(`kind = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT judge_id, full_name, email, organization, kind,
             confirmed_count, held_count, assigned_count, total_assignments,
             no_show_rate, last_assignment_at
      FROM mv_judge_workload
      ${whereClause}
      ORDER BY confirmed_count ${sortDir}, judge_id ASC
      LIMIT $${values.length + 1};
    `;

    const result = await db.query(sql, [...values, parsedLimit]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/feasibility
 * Event-level peak concurrency feasibility.
 */
router.get('/feasibility', async (req, res, next) => {
  try {
    let eventId = req.query.event_id;
    if (!eventId || !isInteger(eventId)) {
      const defaultEvent = await db.query('SELECT id FROM events ORDER BY id ASC LIMIT 1');
      if (defaultEvent.rows.length === 0) {
        return res.json({
          event_id: null,
          event_name: 'No Events',
          session_count: 0,
          peak: 0,
          available: 0,
          feasible: true,
          deficit: 0,
        });
      }
      eventId = defaultEvent.rows[0].id;
    }

    const eventRes = await db.query('SELECT id, name FROM events WHERE id = $1', [eventId]);
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const sessRes = await db.query(
      `SELECT s.id, s.name, s.start_time, s.end_time, s.buffer_minutes,
              c.min_judges
       FROM sessions s
       JOIN competitions c ON c.id = s.competition_id
       WHERE c.event_id = $1 AND s.status <> 'cancelled'
       ORDER BY s.start_time ASC`,
      [eventId]
    );

    const sessions = sessRes.rows;
    const points = [];
    for (const s of sessions) {
      const demand = s.min_judges || 2;
      const bufferMs = (s.buffer_minutes || 0) * 60000;
      const startMs = new Date(s.start_time).getTime() - bufferMs;
      const endMs = new Date(s.end_time).getTime() + bufferMs;

      points.push({ time: startMs, delta: demand });
      points.push({ time: endMs, delta: -demand });
    }

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

    const judgesCountRes = await db.query(
      'SELECT COUNT(*)::int AS count FROM judges WHERE is_active = true'
    );
    const activeJudges = judgesCountRes.rows[0]?.count || 0;
    const isFeasible = activeJudges >= peakDemand;

    res.json({
      event_id: Number(eventId),
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

module.exports = router;
