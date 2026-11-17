'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { generateToken, hashToken } = require('../server/lib/tokens');

let app;
let validRawToken;
let expiredRawToken;
let validInvitationId;
let expiredInvitationId;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create event & competition
  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('Magic Link Fest', 'magic-link-fest', NOW() + INTERVAL '5 days', NOW() + INTERVAL '7 days')
    RETURNING id;
  `);
  const eventId = evRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug)
    VALUES ($1, 'Magic Link Comp', 'magic-link-comp')
    RETURNING id;
  `, [eventId]);
  const compId = compRes.rows[0].id;

  // Create Judge
  const jRes = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, kind, status)
    VALUES ('Norbert', 'Wiener', 'norbert.wiener@mit.edu', 'MIT', 'academic', 'active')
    RETURNING id;
  `);
  const judgeId = jRes.rows[0].id;

  // 1. Create valid active invitation (expires in 48 hours)
  validRawToken = generateToken();
  const validTokenHash = hashToken(validRawToken);
  const invRes = await pool.query(`
    INSERT INTO judge_invitations (
      judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'sent', NOW(), NOW() + INTERVAL '48 hours')
    RETURNING id;
  `, [judgeId, compId, eventId, validTokenHash]);
  validInvitationId = invRes.rows[0].id;

  await pool.query(`
    INSERT INTO auth_tokens (
      judge_id, invitation_id, token_hash, purpose, expires_at
    ) VALUES ($1, $2, $3, 'invitation', NOW() + INTERVAL '48 hours');
  `, [judgeId, validInvitationId, validTokenHash]);

  // 2. Create second competition & expired invitation (expired 2 hours ago)
  const comp2Res = await pool.query(`
    INSERT INTO competitions (event_id, name, slug)
    VALUES ($1, 'Expired Link Comp', 'expired-link-comp')
    RETURNING id;
  `, [eventId]);
  const comp2Id = comp2Res.rows[0].id;

  expiredRawToken = generateToken();
  const expiredTokenHash = hashToken(expiredRawToken);
  const expInvRes = await pool.query(`
    INSERT INTO judge_invitations (
      judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'sent', NOW() - INTERVAL '50 hours', NOW() - INTERVAL '2 hours')
    RETURNING id;
  `, [judgeId, comp2Id, eventId, expiredTokenHash]);
  expiredInvitationId = expInvRes.rows[0].id;

  await pool.query(`
    INSERT INTO auth_tokens (
      judge_id, invitation_id, token_hash, purpose, expires_at
    ) VALUES ($1, $2, $3, 'invitation', NOW() - INTERVAL '2 hours');
  `, [judgeId, expiredInvitationId, expiredTokenHash]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Magic Link: Valid token renders 200 HTML portal', async () => {
  const res = await request(app)
    .get(`/j/${validRawToken}`)
    .expect(200);

  assert.ok(res.text.includes('<!DOCTYPE html>'));
  assert.ok(res.text.includes('Judge Portal'));
});

test('Magic Link: Expired token returns 410 HTML with expiration notice', async () => {
  const res = await request(app)
    .get(`/j/${expiredRawToken}`)
    .expect(410);

  assert.ok(res.text.includes('This Invitation Has Expired'));
  assert.ok(res.text.includes('Link Expired'));
});

test('Magic Link: Invalid token returns 404 HTML', async () => {
  const res = await request(app)
    .get('/j/invalid_token_sample_abc12345678901234567890')
    .expect(404);

  assert.ok(res.text.includes('Invalid Invitation Link'));
});

test('Magic Link: GET /api/j/:token returns JSON details and rate limit headers', async () => {
  const res = await request(app)
    .get(`/api/j/${validRawToken}`)
    .expect(200);

  assert.equal(res.body.judge.first_name, 'Norbert');
  assert.equal(res.body.competition.name, 'Magic Link Comp');
  assert.equal(res.body.invitation.status, 'sent');
  assert.equal(res.body.invitation.is_used, false);

  assert.ok(res.headers['x-ratelimit-limit']);
  assert.ok(res.headers['x-ratelimit-remaining']);
});

test('Magic Link: POST /api/j/:token/view marks status as viewed and preserves token as unused', async () => {
  const res = await request(app)
    .post(`/api/j/${validRawToken}/view`)
    .expect(200);

  assert.equal(res.body.status, 'viewed');

  // Verify invitation row is now 'viewed'
  const invRes = await pool.query('SELECT status FROM judge_invitations WHERE id = $1', [validInvitationId]);
  assert.equal(invRes.rows[0].status, 'viewed');

  // Verify auth_tokens.used_at remains NULL
  const tokenRes = await pool.query('SELECT used_at FROM auth_tokens WHERE invitation_id = $1', [validInvitationId]);
  assert.strictEqual(tokenRes.rows[0].used_at, null);
});

test('Magic Link: POST /api/j/:token/respond marks used_at, updates status, and logs outbox row', async () => {
  const res = await request(app)
    .post(`/api/j/${validRawToken}/respond`)
    .send({ response: 'accepted', note: 'Looking forward to evaluating!' })
    .expect(200);

  assert.equal(res.body.status, 'accepted');

  // Check invitation is accepted
  const invRes = await pool.query('SELECT status FROM judge_invitations WHERE id = $1', [validInvitationId]);
  assert.equal(invRes.rows[0].status, 'accepted');

  // Check invitation_responses table recorded entry
  const respRes = await pool.query('SELECT * FROM invitation_responses WHERE invitation_id = $1', [validInvitationId]);
  assert.equal(respRes.rows.length, 1);
  assert.equal(respRes.rows[0].response, 'accepted');
  assert.equal(respRes.rows[0].response_notes, 'Looking forward to evaluating!');

  // Check auth_tokens.used_at IS NOT NULL
  const tokenRes = await pool.query('SELECT used_at FROM auth_tokens WHERE invitation_id = $1', [validInvitationId]);
  assert.ok(tokenRes.rows[0].used_at !== null);

  // Check outbox row created for coordinator
  const outboxRes = await pool.query(
    'SELECT * FROM notification_outbox WHERE template = $1 AND idempotency_key LIKE $2',
    ['judge_response_notification', `resp_${validInvitationId}_%`]
  );
  assert.equal(outboxRes.rows.length, 1);
});

test('Magic Link: Replay prevention — subsequent response fails with 409', async () => {
  const res = await request(app)
    .post(`/api/j/${validRawToken}/respond`)
    .send({ response: 'declined' })
    .expect(409);

  assert.ok(res.body.error.includes('already been responded to'));
});
