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

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create a dedicated rotating user and a viewer user
  const hash = await bcrypt.hash('InitialPass123!', 10);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, is_active)
    VALUES
      ('rotate.user@csefest.edu', $1, 'Rotate Admin', 'admin', true),
      ('viewer@csefest.edu', $1, 'Viewer User', 'viewer', true)
    ON CONFLICT (email) DO NOTHING;
  `, [hash]);

  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'rotate.user@csefest.edu', password: 'InitialPass123!' })
    .expect(200);

  viewerAgent = request.agent(app);
  await viewerAgent
    .post('/api/auth/login')
    .send({ email: 'viewer@csefest.edu', password: 'InitialPass123!' })
    .expect(200);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Security: POST /api/auth/password rejects missing body or short password (400)', async () => {
  const resEmpty = await adminAgent.post('/api/auth/password').send({}).expect(400);
  assert.equal(resEmpty.body.error, 'Current password and new password are required');

  const resShort = await adminAgent
    .post('/api/auth/password')
    .send({ current_password: 'InitialPass123!', new_password: 'short' })
    .expect(400);
  assert.equal(resShort.body.error, 'New password must be at least 8 characters long');
});

test('Security: POST /api/auth/password rejects incorrect current password (401)', async () => {
  const res = await adminAgent
    .post('/api/auth/password')
    .send({ current_password: 'WrongPassword123!', new_password: 'NewStrongPassword123!' })
    .expect(401);
  assert.equal(res.body.error, 'Current password is incorrect');
});

test('Security: POST /api/auth/password updates hash, logs audit, and invalidates user sessions', async () => {
  const res = await adminAgent
    .post('/api/auth/password')
    .send({ current_password: 'InitialPass123!', new_password: 'NewStrongPassword123!' })
    .expect(200);
  assert.ok(res.body.message.includes('Password updated successfully'));

  // Verify that an audit_log record was created
  const auditRes = await pool.query(
    "SELECT * FROM audit_log WHERE table_name = 'users' AND action = 'UPDATE' ORDER BY id DESC LIMIT 1;"
  );
  assert.equal(auditRes.rows.length, 1);

  // Subsequent call with previous session should fail (401) because session was invalidated
  await adminAgent.get('/api/auth/me').expect(401);

  // Old password should fail to login
  const oldLogin = request(app);
  await oldLogin
    .post('/api/auth/login')
    .send({ email: 'rotate.user@csefest.edu', password: 'InitialPass123!' })
    .expect(401);

  // New password should successfully login
  await oldLogin
    .post('/api/auth/login')
    .send({ email: 'rotate.user@csefest.edu', password: 'NewStrongPassword123!' })
    .expect(200);
});

test('Security: All requests receive X-Request-Id correlation header', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.ok(res.headers['x-request-id'], 'Response must include X-Request-Id header');

  // Custom correlation ID is preserved
  const customId = 'corr-id-998877';
  const resCustom = await request(app)
    .get('/health')
    .set('X-Request-Id', customId)
    .expect(200);
  assert.equal(resCustom.headers['x-request-id'], customId);
});

test('Security: Audit Log viewer enforces strict RBAC (admin only)', async () => {
  const unauth = request(app);
  await unauth.get('/api/audit').expect(401);

  // Viewer role must receive 403 Forbidden
  await viewerAgent.get('/api/audit').expect(403);

  // Admin login can access and retrieve audit logs
  const adminReal = request.agent(app);
  await adminReal
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  const resAudit = await adminReal.get('/api/audit?limit=10').expect(200);
  assert.ok(Array.isArray(resAudit.body.entries));
  assert.ok(typeof resAudit.body.total === 'number');
});

test('Security: Public schema strictly maintains exactly 19 tables and 2 materialized views', async () => {
  const tables = await pool.query("SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname = 'public';");
  assert.equal(tables.rows[0].count, 19, 'Public schema table count must remain strictly 19');

  const matviews = await pool.query("SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname;");
  assert.equal(matviews.rows.length, 2);
  assert.equal(matviews.rows[0].matviewname, 'mv_judge_workload');
  assert.equal(matviews.rows[1].matviewname, 'mv_session_coverage');
});
