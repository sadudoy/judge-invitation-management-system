'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const db = require('../server/db');
const { runOutboxSweep } = require('../server/worker/outbox');

before(async () => {
  await setupTestDb();
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Outbox Worker: Successfully delivers pending notification and logs delivery row', async () => {
  // Insert a test pending notification
  const insertRes = await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, recipient_name, channel,
      subject, body, payload, status, idempotency_key, template
    ) VALUES (
      'worker.test@example.com', 'worker.test@example.com', 'Test Worker Judge', 'email',
      'Invitation Test', 'Body text', '{"competition_name": "Hackathon", "magic_link_url": "http://localhost/j/test"}',
      'pending', 'worker_test_1', 'invitation'
    ) RETURNING id;
  `);
  const notifId = insertRes.rows[0].id;

  const sentMails = [];
  const mockTransport = {
    sendMail: async (mailOptions) => {
      sentMails.push(mailOptions);
      return { messageId: 'msg-12345', response: '250 OK' };
    },
  };

  const stats = await runOutboxSweep({ transport: mockTransport });
  assert.ok(stats.sent >= 1);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, 'worker.test@example.com');
  assert.ok(sentMails[0].text.includes('Hackathon'));

  // Check outbox row updated to sent
  const outboxCheck = await pool.query('SELECT status, sent_at FROM notification_outbox WHERE id = $1', [notifId]);
  assert.equal(outboxCheck.rows[0].status, 'sent');
  assert.ok(outboxCheck.rows[0].sent_at !== null);

  // Check notification_deliveries row inserted
  const delCheck = await pool.query('SELECT status, provider_response FROM notification_deliveries WHERE notification_id = $1', [notifId]);
  assert.equal(delCheck.rows.length, 1);
  assert.equal(delCheck.rows[0].status, 'success');
  assert.ok(JSON.stringify(delCheck.rows[0].provider_response).includes('msg-12345'));
});

test('Outbox Worker: Generates and attaches .ics file for assignment notifications', async () => {
  const payload = {
    judge_name: 'Dr. Calendar Judge',
    competition_name: 'AI Challenge',
    session_name: 'Final Round',
    role: 'head_judge',
    start_time: '2026-11-20T10:00:00Z',
    end_time: '2026-11-20T13:00:00Z',
    venue_name: 'Lab 401',
    magic_link_url: 'http://localhost/j/calendar_test',
  };

  await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, recipient_name, channel,
      subject, body, payload, status, idempotency_key, template
    ) VALUES (
      'calendar.judge@example.com', 'calendar.judge@example.com', 'Dr. Calendar Judge', 'email',
      'Judging Assignment', 'Assignment details enclosed', $1, 'pending', 'worker_test_ics', 'assignment_notification'
    );
  `, [JSON.stringify(payload)]);

  const sentMails = [];
  const mockTransport = {
    sendMail: async (mailOptions) => {
      sentMails.push(mailOptions);
      return { messageId: 'msg-ics-1', response: '250 OK' };
    },
  };

  await runOutboxSweep({ transport: mockTransport });

  const mail = sentMails.find((m) => m.to === 'calendar.judge@example.com');
  assert.ok(mail, 'Expected email to calendar.judge@example.com');
  assert.ok(mail.attachments && mail.attachments.length > 0, 'Email should include attachments');

  const icsAttachment = mail.attachments.find((a) => a.filename === 'invite.ics');
  assert.ok(icsAttachment, 'Expected invite.ics attachment');
  assert.ok(icsAttachment.content.includes('BEGIN:VCALENDAR'));
  assert.ok(icsAttachment.content.includes('SUMMARY:CSE Fest: Final Round (head_judge)'));
});

test('Outbox Worker: Handles delivery failure with exponential backoff', async () => {
  const insertRes = await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, recipient_name, channel,
      subject, body, payload, status, retry_count, idempotency_key, template
    ) VALUES (
      'fail.test@example.com', 'fail.test@example.com', 'Fail Judge', 'email',
      'Fail Test', 'Body', '{}', 'pending', 0, 'worker_test_backoff', 'invitation'
    ) RETURNING id;
  `);
  const notifId = insertRes.rows[0].id;

  const failingTransport = {
    sendMail: async () => {
      throw new Error('SMTP connection refused: connect ECONNREFUSED 127.0.0.1:1025');
    },
  };

  const stats = await runOutboxSweep({ transport: failingTransport });
  assert.ok(stats.retried >= 1);

  const check = await pool.query(
    'SELECT status, retry_count, error_message, scheduled_at > NOW() AS future_scheduled FROM notification_outbox WHERE id = $1',
    [notifId]
  );
  assert.equal(check.rows[0].status, 'pending');
  assert.equal(check.rows[0].retry_count, 1);
  assert.ok(check.rows[0].future_scheduled, 'Retry should be scheduled in the future via exponential backoff');
  assert.ok(check.rows[0].error_message.includes('ECONNREFUSED'));
});

test('Outbox Worker: Marks notification as failed after reaching 5 attempts', async () => {
  const insertRes = await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, recipient_name, channel,
      subject, body, payload, status, retry_count, scheduled_at, idempotency_key, template
    ) VALUES (
      'max.retries@example.com', 'max.retries@example.com', 'Max Retries Judge', 'email',
      'Max Retry Test', 'Body', '{}', 'pending', 4, NOW() - INTERVAL '1 minute', 'worker_test_max_retry', 'invitation'
    ) RETURNING id;
  `);
  const notifId = insertRes.rows[0].id;

  const failingTransport = {
    sendMail: async () => {
      throw new Error('550 User mailbox unavailable');
    },
  };

  const stats = await runOutboxSweep({ transport: failingTransport });
  assert.ok(stats.failed >= 1);

  const check = await pool.query(
    'SELECT status, retry_count, error_message FROM notification_outbox WHERE id = $1',
    [notifId]
  );
  assert.equal(check.rows[0].status, 'failed');
  assert.equal(check.rows[0].retry_count, 5);
  assert.ok(check.rows[0].error_message.includes('550 User mailbox unavailable'));

  const delCheck = await pool.query(
    'SELECT status, provider_response FROM notification_deliveries WHERE notification_id = $1',
    [notifId]
  );
  assert.equal(delCheck.rows.length, 1);
  assert.equal(delCheck.rows[0].status, 'failure');
  assert.ok(JSON.stringify(delCheck.rows[0].provider_response).includes('550 User mailbox unavailable'));
});

test('Outbox Worker: FOR UPDATE SKIP LOCKED provides concurrency safety', async () => {
  // Insert row to be locked
  const insertRes = await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, recipient_name, channel,
      subject, body, payload, status, scheduled_at, idempotency_key, template
    ) VALUES (
      'concurrent@example.com', 'concurrent@example.com', 'Concurrent Judge', 'email',
      'Concurrent Test', 'Body', '{}', 'pending', NOW(), 'worker_test_skip_locked', 'invitation'
    ) RETURNING id;
  `);
  const notifId = insertRes.rows[0].id;

  // Open first transaction and lock the row with FOR UPDATE
  const client1 = await pool.connect();
  await client1.query('BEGIN');
  const lockedRes = await client1.query(
    'SELECT id FROM notification_outbox WHERE id = $1 FOR UPDATE;',
    [notifId]
  );
  assert.equal(lockedRes.rows.length, 1);

  // Client 2 attempts to query with SKIP LOCKED - should skip the locked row and find 0 rows
  const client2 = await pool.connect();
  await client2.query('BEGIN');
  const skipRes = await client2.query(
    'SELECT id FROM notification_outbox WHERE id = $1 FOR UPDATE SKIP LOCKED;',
    [notifId]
  );
  assert.equal(skipRes.rows.length, 0, 'Second worker must skip the locked row without blocking');

  await client2.query('ROLLBACK');
  client2.release();

  await client1.query('ROLLBACK');
  client1.release();
});
