'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcrypt');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');

let app;
let adminAgent;
let viewerAgent;
let competitionId;
let judge1Id;
let judge2Id;
let judge3Id;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create viewer user
  const hash = await bcrypt.hash('ViewerPass123!', 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, is_active)
    VALUES ('viewer_inv@csefest.edu', $1, 'Viewer User', 'viewer', true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer';
  `, [hash]);

  // Login agents
  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  viewerAgent = request.agent(app);
  await viewerAgent
    .post('/api/auth/login')
    .send({ email: 'viewer_inv@csefest.edu', password: 'ViewerPass123!' })
    .expect(200);

  // Get a competition ID from seed
  const compRes = await pool.query('SELECT id FROM competitions LIMIT 1;');
  competitionId = compRes.rows[0].id;

  // Create 3 active judges for testing
  const j1 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('InvJudge1', 'Test', 'inv.judge1@example.com', 'academic', 'active')
    RETURNING id;
  `);
  judge1Id = j1.rows[0].id;

  const j2 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('InvJudge2', 'Test', 'inv.judge2@example.com', 'industry', 'active')
    RETURNING id;
  `);
  judge2Id = j2.rows[0].id;

  const j3 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('InvJudge3', 'Test', 'inv.judge3@example.com', 'alumni', 'active')
    RETURNING id;
  `);
  judge3Id = j3.rows[0].id;
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Invitations: Unauthenticated requests return 401', async () => {
  const res = await request(app).get('/api/invitations').expect(401);
  assert.equal(res.body.error, 'Unauthorized: login required');
});

test('Invitations: Viewer receives 403', async () => {
  const res = await viewerAgent.get('/api/invitations').expect(403);
  assert.equal(res.body.error, 'Forbidden: insufficient permissions');
});

test('Invitations: Single invitation creates invitation, auth_token, and outbox row', async () => {
  const res = await adminAgent
    .post('/api/invitations')
    .send({
      judge_id: judge1Id,
      competition_id: competitionId,
    })
    .expect(201);

  assert.ok(res.body.invitation);
  assert.equal(res.body.invitation.status, 'sent');
  assert.equal(res.body.invitation.judge_id, judge1Id);

  // Magic link exposed in dev/test
  assert.ok(res.body.magicLinkUrl);

  // Check auth_token exists
  const tokenRes = await pool.query(
    'SELECT * FROM auth_tokens WHERE invitation_id = $1',
    [res.body.invitation.id]
  );
  assert.equal(tokenRes.rows.length, 1);
  assert.equal(tokenRes.rows[0].judge_id, judge1Id);
  assert.equal(tokenRes.rows[0].purpose, 'invitation');

  // Check notification_outbox row exists
  const outboxRes = await pool.query(
    'SELECT * FROM notification_outbox WHERE idempotency_key LIKE $1',
    [`invite_${res.body.invitation.id}_%`]
  );
  assert.equal(outboxRes.rows.length, 1);
  assert.equal(outboxRes.rows[0].template, 'judge_invitation');
  assert.equal(outboxRes.rows[0].status, 'pending');
});

test('Invitations: Duplicate live invitation fails with 409', async () => {
  const res = await adminAgent
    .post('/api/invitations')
    .send({
      judge_id: judge1Id,
      competition_id: competitionId,
    })
    .expect(409);

  assert.ok(res.body.error.includes('active invitation'));
});

test('Invitations: Bulk invite skips judges with live invitations', async () => {
  // judge1 already has live invitation, judge2 and judge3 do not
  const res = await adminAgent
    .post('/api/invitations/bulk')
    .send({
      judge_ids: [judge1Id, judge2Id, judge3Id],
      competition_id: competitionId,
      deadline_hours: 48,
    })
    .expect(201);

  assert.equal(res.body.created_count, 2);
  assert.equal(res.body.skipped_count, 1);
  assert.equal(res.body.skipped[0].judge_id, Number(judge1Id));
  assert.ok(res.body.skipped[0].reason.includes('active invitation'));
});

test('Invitations: Strict Security — magicLinkUrl omitted in production', async () => {
  const origEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';

    // Create a new fresh judge
    const jNew = await pool.query(`
      INSERT INTO judges (first_name, last_name, email, kind, status)
      VALUES ('ProdJudge', 'Sec', 'prod.judge@example.com', 'industry', 'active')
      RETURNING id;
    `);

    // Create a second competition
    const cNew = await pool.query(`
      INSERT INTO competitions (event_id, name, slug)
      VALUES ((SELECT id FROM events LIMIT 1), 'Prod Comp', 'prod-comp')
      RETURNING id;
    `);

    const res = await adminAgent
      .post('/api/invitations')
      .send({
        judge_id: jNew.rows[0].id,
        competition_id: cNew.rows[0].id,
      })
      .expect(201);

    assert.ok(res.body.invitation);
    assert.strictEqual(res.body.magicLinkUrl, undefined, 'magicLinkUrl must be omitted in production');
    assert.strictEqual(res.body.rawToken, undefined, 'rawToken must be omitted in production');
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

test('Invitations: Resend invitation generates fresh token and outbox reminder', async () => {
  // Find judge2's invitation
  const invRes = await pool.query(
    'SELECT id FROM judge_invitations WHERE judge_id = $1 AND competition_id = $2',
    [judge2Id, competitionId]
  );
  const invId = invRes.rows[0].id;

  const res = await adminAgent
    .post(`/api/invitations/${invId}/resend`)
    .expect(200);

  assert.equal(res.body.message, 'Invitation resent successfully');

  // Verify outbox reminder row exists
  const outboxRes = await pool.query(
    'SELECT * FROM notification_outbox WHERE template = $1 AND idempotency_key LIKE $2',
    ['judge_invitation_reminder', `resend_${invId}_%`]
  );
  assert.equal(outboxRes.rows.length, 1);
});

test('Invitations: Cancel invitation updates status and expires token', async () => {
  // Find judge3's invitation
  const invRes = await pool.query(
    'SELECT id FROM judge_invitations WHERE judge_id = $1 AND competition_id = $2',
    [judge3Id, competitionId]
  );
  const invId = invRes.rows[0].id;

  const res = await adminAgent
    .post(`/api/invitations/${invId}/cancel`)
    .expect(200);

  assert.equal(res.body.invitation.status, 'cancelled');

  // Verify active token is now expired (expires_at <= now())
  const tokenRes = await pool.query(
    'SELECT * FROM auth_tokens WHERE invitation_id = $1',
    [invId]
  );
  assert.ok(new Date(tokenRes.rows[0].expires_at).getTime() <= Date.now() + 5000);
});

test('Invitations: Cannot cancel or resend already accepted/declined invitation (409)', async () => {
  // Create an invitation and simulate accepted status
  const invRes = await pool.query(`
    INSERT INTO judge_invitations (judge_id, competition_id, invitation_token, status)
    VALUES ($1, (SELECT id FROM competitions WHERE id <> $2 LIMIT 1), 'token_accepted_test_1', 'accepted')
    RETURNING id;
  `, [judge1Id, competitionId]);
  const acceptedInvId = invRes.rows[0].id;

  // Attempt cancel -> 409
  await adminAgent
    .post(`/api/invitations/${acceptedInvId}/cancel`)
    .expect(409);

  // Attempt resend -> 409
  await adminAgent
    .post(`/api/invitations/${acceptedInvId}/resend`)
    .expect(409);
});
