'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');

let app;
let adminAgent;
let compId;
let judgeAId;
let judgeBId;

before(async () => {
  await setupTestDb();
  app = createApp();

  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  const compRes = await pool.query('SELECT id FROM competitions LIMIT 1;');
  compId = compRes.rows[0].id;

  const ja = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Outbox', 'JudgeA', 'outbox.judgeA@test.com', 'academic', 'active')
    RETURNING id;
  `);
  judgeAId = ja.rows[0].id;

  const jb = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Outbox', 'JudgeB', 'outbox.judgeB@test.com', 'industry', 'active')
    RETURNING id;
  `);
  judgeBId = jb.rows[0].id;
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Outbox: Single invitation produces notification_outbox row with template and idempotency_key', async () => {
  const initialCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  const initialCount = initialCountRes.rows[0].count;

  const res = await adminAgent
    .post('/api/invitations')
    .send({
      judge_id: judgeAId,
      competition_id: compId,
    })
    .expect(201);

  const invId = res.body.invitation.id;

  // Verify exactly 1 row added
  const newCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  assert.equal(newCountRes.rows[0].count, initialCount + 1);

  // Verify row contents
  const outboxRes = await pool.query(
    'SELECT * FROM notification_outbox WHERE idempotency_key LIKE $1',
    [`invite_${invId}_%`]
  );
  assert.equal(outboxRes.rows.length, 1);
  const row = outboxRes.rows[0];
  assert.equal(row.to_email, 'outbox.judgeA@test.com');
  assert.equal(row.template, 'judge_invitation');
  assert.equal(row.status, 'pending');
  assert.strictEqual(row.sent_at, null);
  assert.ok(row.payload);
  assert.equal(typeof row.payload, 'object');
  assert.equal(row.payload.invitation_id, invId);
});

test('Outbox: Bulk invitation produces rows for all newly invited evaluators', async () => {
  const initialCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  const initialCount = initialCountRes.rows[0].count;

  // Create another judge C
  const jc = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Outbox', 'JudgeC', 'outbox.judgeC@test.com', 'industry', 'active')
    RETURNING id;
  `);
  const judgeCId = jc.rows[0].id;

  // Bulk invite judgeB and judgeC
  const res = await adminAgent
    .post('/api/invitations/bulk')
    .send({
      judge_ids: [judgeBId, judgeCId],
      competition_id: compId,
    })
    .expect(201);

  assert.equal(res.body.created_count, 2);

  // Verify exactly 2 rows added
  const newCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  assert.equal(newCountRes.rows[0].count, initialCount + 2);
});

test('Outbox: Idempotency key unique constraint (23505) prevents duplicate message creation', async () => {
  const duplicateKey = 'idempotency_test_duplicate_key_123';

  // First insert succeeds
  await pool.query(`
    INSERT INTO notification_outbox (
      recipient_email, to_email, channel, subject, body, template, idempotency_key, status
    ) VALUES ('test@example.com', 'test@example.com', 'email', 'Subject', 'Body', 'test_template', $1, 'pending');
  `, [duplicateKey]);

  // Second insert with same idempotency_key must fail with 23505
  await assert.rejects(
    async () => {
      await pool.query(`
        INSERT INTO notification_outbox (
          recipient_email, to_email, channel, subject, body, template, idempotency_key, status
        ) VALUES ('test@example.com', 'test@example.com', 'email', 'Subject', 'Body', 'test_template', $1, 'pending');
      `, [duplicateKey]);
    },
    (err) => {
      assert.equal(err.code, '23505', 'Duplicate idempotency_key must trigger 23505 unique violation');
      return true;
    }
  );
});

test('Outbox: Outbox producer only — rows remain pending (no worker consumption in Phase 2)', async () => {
  // Query all pending rows in notification_outbox
  const res = await pool.query('SELECT id, status, sent_at FROM notification_outbox WHERE status = $1', ['pending']);
  assert.ok(res.rows.length >= 3);

  // Confirm none have been marked as sent
  res.rows.forEach((r) => {
    assert.equal(r.status, 'pending');
    assert.strictEqual(r.sent_at, null);
  });
});
