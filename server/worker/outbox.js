'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('../db');
const { generateIcs } = require('../lib/ics');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Cached templates
const templateCache = new Map();

function loadTemplate(name, ext) {
  const key = `${name}.${ext}`;
  if (templateCache.has(key)) {
    return templateCache.get(key);
  }
  const filePath = path.join(TEMPLATES_DIR, key);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    templateCache.set(key, content);
    return content;
  }
  return null;
}

function interpolate(template, data = {}) {
  if (!template) return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return data[key] !== undefined && data[key] !== null ? String(data[key]) : '';
  });
}

/**
 * Creates default Nodemailer transport
 */
function createTransport(customOptions = {}) {
  if (customOptions.transport) {
    return customOptions.transport;
  }

  const host = process.env.SMTP_HOST || 'localhost';
  const port = parseInt(process.env.SMTP_PORT || '1025', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  const transportConfig = {
    host,
    port,
    secure,
    ignoreTLS: !secure,
  };

  if (user && pass) {
    transportConfig.auth = { user, pass };
  }

  return nodemailer.createTransport(transportConfig);
}

/**
 * Run a single deterministic sweep of the outbox.
 * Concurrency-safe: claims rows via SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * @param {Object} [options]
 * @param {Object} [options.transport] - Custom Nodemailer transport for testing
 * @param {number} [options.batchSize] - Batch size (default: 10)
 * @param {Object} [options.client] - Dedicated database client (optional)
 * @returns {Promise<{ processed: number, sent: number, failed: number, retried: number }>}
 */
async function runOutboxSweep(options = {}) {
  const batchSize = options.batchSize || 10;
  const transport = createTransport(options);

  const stats = {
    processed: 0,
    sent: 0,
    failed: 0,
    retried: 0,
  };

  const client = options.client || (await db.pool.connect());
  const shouldRelease = !options.client;

  try {
    await client.query('BEGIN');

    // Concurrency-safe lock: SKIP LOCKED ensures multiple workers don't collide
    const selectSql = `
      SELECT id, recipient_email, to_email, recipient_name, channel,
             subject, body, payload, status, retry_count, scheduled_at,
             template, idempotency_key
      FROM notification_outbox
      WHERE status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED;
    `;

    const res = await client.query(selectSql, [batchSize]);
    const rows = res.rows;

    for (const row of rows) {
      stats.processed++;
      const payload = typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
      const toEmail = row.to_email || row.recipient_email || payload.to_email || payload.recipient_email;
      const recipientName = row.recipient_name || payload.judge_name || 'Valued Judge';

      const templateName = row.template || 'invitation';
      const templateData = {
        judge_name: recipientName,
        judge_email: toEmail,
        competition_name: payload.competition_name || 'CSE Fest Competition',
        session_name: payload.session_name || 'Judging Session',
        role: payload.role || 'judge',
        start_time: payload.start_time || '',
        end_time: payload.end_time || '',
        venue_name: payload.venue_name || 'Campus Venue',
        magic_link_url: payload.magic_link_url || payload.magicLinkUrl || '',
        expires_at: payload.expires_at || '',
        status: payload.status || '',
        reason: payload.reason || '',
        assignment_id: payload.assignment_id || '',
        ...payload,
      };

      const rawTxt = loadTemplate(templateName, 'txt');
      const rawHtml = loadTemplate(templateName, 'html');

      const textBody = rawTxt ? interpolate(rawTxt, templateData) : (row.body || 'CSE Fest Notification');
      const htmlBody = rawHtml ? interpolate(rawHtml, templateData) : undefined;
      const subject = row.subject || `CSE Fest — ${templateName.replace(/_/g, ' ')}`;

      // Prepare mail attachments (e.g. .ics calendar invite for assignments)
      const attachments = [];
      const needsIcs =
        ['assignment_notification', 'replacement_notification', 'reminder_assignment'].includes(templateName) ||
        Boolean(payload.attach_ics || payload.startTime || payload.start_time);

      if (needsIcs && (payload.start_time || payload.startTime) && (payload.end_time || payload.endTime)) {
        try {
          const icsContent = generateIcs({
            uid: `session-${payload.session_id || payload.assignment_id || row.id}@csefest.org`,
            startTime: payload.start_time || payload.startTime,
            endTime: payload.end_time || payload.endTime,
            summary: `CSE Fest: ${templateData.session_name} (${templateData.role})`,
            description: `Session judging assignment for ${templateData.competition_name}`,
            location: templateData.venue_name,
            attendeeName: recipientName,
            attendeeEmail: toEmail,
          });

          attachments.push({
            filename: 'invite.ics',
            content: icsContent,
            contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
          });
        } catch (icsErr) {
          // If ICS fails, we still attempt email delivery
        }
      }

      const mailOptions = {
        from: process.env.EMAIL_FROM || '"CSE Fest Organizing Committee" <no-reply@csefest.org>',
        to: toEmail,
        subject,
        text: textBody,
        html: htmlBody,
        attachments,
      };

      try {
        const info = await transport.sendMail(mailOptions);

        // Mark as sent
        await client.query(
          `UPDATE notification_outbox
           SET status = 'sent', sent_at = NOW(), updated_at = NOW()
           WHERE id = $1;`,
          [row.id]
        );

        // Record successful delivery
        await client.query(
          `INSERT INTO notification_deliveries (notification_id, status, provider_response, delivered_at)
           VALUES ($1, 'success', $2, NOW());`,
          [row.id, JSON.stringify({ messageId: info.messageId, response: info.response })]
        );

        stats.sent++;
      } catch (sendErr) {
        const newRetryCount = (row.retry_count || 0) + 1;
        const maxRetries = 5;

        if (newRetryCount >= maxRetries) {
          // Mark permanently failed
          await client.query(
            `UPDATE notification_outbox
             SET status = 'failed',
                 retry_count = $1,
                 error_message = $2,
                 updated_at = NOW()
             WHERE id = $3;`,
            [newRetryCount, sendErr.message, row.id]
          );

          await client.query(
            `INSERT INTO notification_deliveries (notification_id, status, provider_response, delivered_at)
             VALUES ($1, 'failure', $2, NOW());`,
            [row.id, JSON.stringify({ error: sendErr.message })]
          );

          stats.failed++;
        } else {
          // Exponential backoff: 2^retry_count * 30 seconds
          const delaySeconds = Math.pow(2, newRetryCount) * 30;

          await client.query(
            `UPDATE notification_outbox
             SET retry_count = $1,
                 scheduled_at = NOW() + ($2 || ' seconds')::interval,
                 error_message = $3,
                 updated_at = NOW()
             WHERE id = $4;`,
            [newRetryCount, delaySeconds, sendErr.message, row.id]
          );

          stats.retried++;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }

  return stats;
}

let outboxInterval = null;

function startOutboxWorker(options = {}) {
  if (outboxInterval) return;
  const pollInterval = options.intervalMs || 5000;

  outboxInterval = setInterval(async () => {
    try {
      await runOutboxSweep(options);
    } catch (err) {
      console.error('[OutboxWorker] Error during sweep:', err.message);
    }
  }, pollInterval);
}

function stopOutboxWorker() {
  if (outboxInterval) {
    clearInterval(outboxInterval);
    outboxInterval = null;
  }
}

module.exports = {
  runOutboxSweep,
  startOutboxWorker,
  stopOutboxWorker,
  createTransport,
  interpolate,
};
