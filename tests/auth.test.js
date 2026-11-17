'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { setupTestDb, teardownTestDb } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');

let app;

before(async () => {
  await setupTestDb();
  app = createApp();
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('POST /api/auth/login fails with invalid credentials (wrong password)', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'WrongPassword999!' })
    .expect(401);

  assert.equal(res.body.error, 'Invalid email or password');
});

test('POST /api/auth/login fails with non-existent user', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'unknown@csefest.edu', password: 'AnyPassword123!' })
    .expect(401);

  assert.equal(res.body.error, 'Invalid email or password');
});

test('POST /api/auth/login fails with missing body fields', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu' })
    .expect(400);

  assert.equal(res.body.error, 'Email and password are required');
});

test('GET /api/auth/me fails when unauthenticated', async () => {
  const res = await request(app)
    .get('/api/auth/me')
    .expect(401);

  assert.equal(res.body.error, 'Unauthorized: login required');
});

test('Full auth lifecycle: login -> get /me -> logout -> get /me returns 401', async () => {
  const agent = request.agent(app);

  // 1. Login ok
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  assert.equal(loginRes.body.message, 'Login successful');
  assert.equal(loginRes.body.user.email, 'admin@csefest.edu');
  assert.equal(loginRes.body.user.role, 'admin');

  // 2. Access /api/auth/me with active session
  const meRes = await agent
    .get('/api/auth/me')
    .expect(200);

  assert.equal(meRes.body.user.email, 'admin@csefest.edu');
  assert.equal(meRes.body.user.role, 'admin');

  // 3. Logout
  const logoutRes = await agent
    .post('/api/auth/logout')
    .expect(200);

  assert.equal(logoutRes.body.message, 'Logged out successfully');

  // 4. Access /api/auth/me after logout -> 401
  const meAfterLogoutRes = await agent
    .get('/api/auth/me')
    .expect(401);

  assert.equal(meAfterLogoutRes.body.error, 'Unauthorized: login required');
});

test('Session: login regenerates session ID and persists session row into session table', async () => {
  const agent = request.agent(app);

  // 1. Pre-login request: GET /api/auth/me
  const preRes = await agent.get('/api/auth/me').expect(401);
  const preCookies = preRes.headers['set-cookie'];
  let preSid = null;
  if (preCookies && preCookies.length > 0) {
    const match = preCookies[0].match(/connect\.sid=([^;]+)/);
    if (match) preSid = match[1];
  }

  // 2. Login with valid credentials
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  const postCookies = loginRes.headers['set-cookie'];
  assert.ok(postCookies, 'Expected Set-Cookie header on successful login');
  const postMatch = postCookies[0].match(/connect\.sid=([^;]+)/);
  assert.ok(postMatch, 'Expected connect.sid in Set-Cookie header');
  const postSid = postMatch[1];

  // If a pre-login session cookie was set, the post-login cookie must differ (regeneration)
  if (preSid) {
    assert.notEqual(preSid, postSid, 'Session ID must be regenerated upon authentication');
  }

  // Verify that session row is inserted in PostgreSQL session table
  const sessionDbRes = await db.query('SELECT sid, sess, expire FROM "session";');
  assert.ok(sessionDbRes.rows.length >= 1, 'Expected at least one session stored in database');

  // Verify subsequent request reuses the authenticated session
  const meRes = await agent.get('/api/auth/me').expect(200);
  assert.equal(meRes.body.user.email, 'admin@csefest.edu');
});
