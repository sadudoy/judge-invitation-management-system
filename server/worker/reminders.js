'use strict';

const db = require('../db');

/**
 * Helper to get YYYY-MM-DD date string in Asia/Dhaka or UTC
 */
function getDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Run a single sweep of all automated reminder rules.
 * Enqueues messages into notification_outbox using deterministic idempotency keys.
 *
 * @param {Object} [options]
 * @param {Date} [options.now] - Override current timestamp for testing
 * @returns {Promise<{ invitationsEnqueued: number, assignmentsEnqueued: number, lateAlertsEnqueued: number }>}
 */
async function runReminderSweep(options = {}) {
  const now = options.now || new Date();
  const todayStr = getDateString(now);

  const stats = {
    invitationsEnqueued: 0,
    assignmentsEnqueued: 0,
    lateAlertsEnqueued: 0,
  };

  // 1. Pending invitations reminder (3 to 4 days before deadline)
  const pendingInvSql = `
    SELECT ji.id, ji.expires_at, j.first_name, j.last_name, j.email,
           c.name AS competition_name
    FROM judge_invitations ji
    JOIN judges j ON j.id = ji.judge_id
    JOIN competitions c ON c.id = ji.competition_id
    WHERE ji.status IN ('invited', 'sent')
      AND ji.expires_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '4 days';
  `;

  const pendingInvs = await db.query(pendingInvSql);
  for (const inv of pendingInvs.rows) {
    const idempotencyKey = `reminder:invitation:${inv.id}:${todayStr}`;
    const payload = {
      judge_name: `${inv.first_name} ${inv.last_name}`,
      competition_name: inv.competition_name,
      expires_at: inv.expires_at,
    };

    const subject = `Reminder: Please RSVP for ${inv.competition_name}`;
    const insertRes = await db.query(
      `INSERT INTO notification_outbox (
         recipient_email, to_email, recipient_name, channel,
         subject, body, payload, status, idempotency_key, template
       ) VALUES ($1, $1, $2, 'email', $3, $3, $4, 'pending', $5, 'reminder_invitation')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id;`,
      [
        inv.email,
        `${inv.first_name} ${inv.last_name}`,
        subject,
        JSON.stringify(payload),
        idempotencyKey,
      ]
    );

    if (insertRes.rows.length > 0) {
      stats.invitationsEnqueued++;
    }
  }

  // 2. Upcoming assignment reminder (23 to 25 hours before session start)
  const upcomingAssignSql = `
    SELECT ja.id, ja.role, s.id AS session_id, s.name AS session_name,
           s.start_time, s.end_time, v.name AS venue_name,
           j.first_name, j.last_name, j.email, c.name AS competition_name
    FROM judge_assignments ja
    JOIN sessions s ON s.id = ja.session_id
    JOIN competitions c ON c.id = s.competition_id
    JOIN judges j ON j.id = ja.judge_id
    LEFT JOIN venues v ON v.id = s.venue_id
    WHERE ja.status = 'confirmed'
      AND s.start_time BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours';
  `;

  const upcomingAssigns = await db.query(upcomingAssignSql);
  for (const asg of upcomingAssigns.rows) {
    const idempotencyKey = `reminder:assignment:${asg.id}:${todayStr}`;
    const payload = {
      judge_name: `${asg.first_name} ${asg.last_name}`,
      session_name: asg.session_name,
      competition_name: asg.competition_name,
      role: asg.role,
      start_time: asg.start_time,
      end_time: asg.end_time,
      venue_name: asg.venue_name || 'Designated Venue',
      attach_ics: true,
    };

    const subject = `Reminder: Judging Tomorrow — ${asg.session_name}`;
    const insertRes = await db.query(
      `INSERT INTO notification_outbox (
         recipient_email, to_email, recipient_name, channel,
         subject, body, payload, status, idempotency_key, template
       ) VALUES ($1, $1, $2, 'email', $3, $3, $4, 'pending', $5, 'reminder_assignment')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id;`,
      [
        asg.email,
        `${asg.first_name} ${asg.last_name}`,
        subject,
        JSON.stringify(payload),
        idempotencyKey,
      ]
    );

    if (insertRes.rows.length > 0) {
      stats.assignmentsEnqueued++;
    }
  }

  // 3. Late / No-show alert to coordinator (reporting + grace + 5m passed, not arrived)
  const lateAlertSql = `
    SELECT ja.id AS assignment_id, ja.judge_id, s.id AS session_id, s.name AS session_name,
           j.first_name, j.last_name, j.email AS judge_email,
           c.name AS competition_name,
           u.email AS coordinator_email
    FROM judge_assignments ja
    JOIN sessions s ON s.id = ja.session_id
    JOIN competitions c ON c.id = s.competition_id
    JOIN judges j ON j.id = ja.judge_id
    LEFT JOIN assignment_attendance aa ON aa.assignment_id = ja.id
    LEFT JOIN users u ON u.role IN ('coordinator', 'admin') AND u.is_active = true
    WHERE ja.status = 'confirmed'
      AND NOW() >= (s.reporting_at + (s.grace_minutes || ' minutes')::interval + INTERVAL '5 minutes')
      AND NOW() < s.end_time
      AND (aa.id IS NULL OR aa.status = 'not_arrived')
    ORDER BY ja.id ASC
    LIMIT 20;
  `;

  const lateAlerts = await db.query(lateAlertSql);
  for (const late of lateAlerts.rows) {
    const targetEmail = late.coordinator_email || 'coordinator@csefest.edu';
    const idempotencyKey = `reminder:late:${late.assignment_id}:${todayStr}`;
    const payload = {
      judge_name: `${late.first_name} ${late.last_name}`,
      judge_email: late.judge_email,
      session_name: late.session_name,
      competition_name: late.competition_name,
      assignment_id: late.assignment_id,
    };

    const subject = `ALERT: Judge ${late.first_name} ${late.last_name} Not Arrived for ${late.session_name}`;
    const insertRes = await db.query(
      `INSERT INTO notification_outbox (
         recipient_email, to_email, recipient_name, channel,
         subject, body, payload, status, idempotency_key, template
       ) VALUES ($1, $1, 'Event Coordinator', 'email', $2, $2, $3, 'pending', $4, 'assignment_declined')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id;`,
      [
        targetEmail,
        subject,
        JSON.stringify(payload),
        idempotencyKey,
      ]
    );

    if (insertRes.rows.length > 0) {
      stats.lateAlertsEnqueued++;
    }
  }

  return stats;
}

let reminderInterval = null;

function startReminderWorker(options = {}) {
  if (reminderInterval) return;
  // Default sweep interval: once an hour (or every 60s in dev/test if configured)
  const intervalMs = options.intervalMs || 60 * 60 * 1000;

  reminderInterval = setInterval(async () => {
    try {
      await runReminderSweep(options);
    } catch (err) {
      console.error('[ReminderWorker] Error during reminder sweep:', err.message);
    }
  }, intervalMs);
}

function stopReminderWorker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

module.exports = {
  runReminderSweep,
  startReminderWorker,
  stopReminderWorker,
  getDateString,
};
