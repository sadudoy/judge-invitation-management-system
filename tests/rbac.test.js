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

before(async () => {
  await setupTestDb();
  app = createApp();

  // Insert viewer user with bcrypt cost 12
  const viewerPassword = 'ViewerPassword123!';
  const passwordHash = await bcrypt.hash(viewerPassword, 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, is_active)
    VALUES ('viewer@csefest.edu', $1, 'Test Viewer', 'viewer', true)
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash, role = 'viewer';
  `, [passwordHash]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('RBAC: Unauthenticated call to /api/admin/only returns 401', async () => {
  const res = await request(app)
    .get('/api/admin/only')
    .expect(401);

  assert.equal(res.body.error, 'Unauthorized: login required');
});

test('RBAC: Viewer user receives 403 on /api/admin/only', async () => {
  const agent = request.agent(app);

  // Login as viewer
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'viewer@csefest.edu', password: 'ViewerPassword123!' })
    .expect(200);

  assert.equal(loginRes.body.user.role, 'viewer');

  // Attempt to access admin-only route
  const res = await agent
    .get('/api/admin/only')
    .expect(403);

  assert.equal(res.body.error, 'Forbidden: insufficient permissions');
});

test('RBAC: Admin user receives 200 on /api/admin/only', async () => {
  const agent = request.agent(app);

  // Login as admin
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  assert.equal(loginRes.body.user.role, 'admin');

  // Access admin-only route
  const res = await agent
    .get('/api/admin/only')
    .expect(200);

  assert.equal(res.body.ok, true);
});
