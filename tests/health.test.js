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

test('GET /health returns 200 with status "ok" and db "ok"', async () => {
  const res = await request(app)
    .get('/health')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.db, 'ok');
  assert.ok(res.body.timestamp);
  assert.ok(typeof res.body.uptime === 'number');
});
