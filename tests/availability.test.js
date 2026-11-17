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
let freshRawToken;
let freshTokenHash;
let olderRawToken;
let olderTokenHash;
let judgeId;
let eventId;

before(async () => {
  await setupTestDb();
  app = createApp();

  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('Avail Fest', 'avail-fest', NOW() + INTERVAL '10 days', NOW() + INTERVAL '12 days')
    RETURNING id;
  `);
  eventId = evRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug)
    VALUES ($1, 'Avail Comp', 'avail-comp')
    RETURNING id;
  `, [eventId]);
  const compId = compRes.rows[0].id;

  const jRes = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Kurt', 'Godel', 'kurt.godel@ias.edu', 'academic', 'active')
    RETURNING id;
  `);
  judgeId = jRes.rows[0].id;

  // 1. Fresh token (created now)
  freshRawToken = generateToken();
  freshTokenHash = hashToken(freshRawToken);

  const inv1 = await pool.query(`
    INSERT INTO judge_invitations (
      judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'sent', NOW(), NOW() + INTERVAL '72 hours')
    RETURNING id;
  `, [judgeId, compId, eventId, freshTokenHash]);

  await pool.query(`
    INSERT INTO auth_tokens (
      judge_id, invitation_id, token_hash, purpose, expires_at, created_at
    ) VALUES ($1, $2, $3, 'invitation', NOW() + INTERVAL '72 hours', NOW());
  `, [judgeId, inv1.rows[0].id, freshTokenHash]);

  // 2. Older token (created 26 hours ago)
  const comp2Res = await pool.query(`
    INSERT INTO competitions (event_id, name, slug)
    VALUES ($1, 'Avail Comp 2', 'avail-comp-2')
    RETURNING id;
  `, [eventId]);

  const j2Res = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Emmy', 'Noether', 'emmy.noether@gottingen.de', 'academic', 'active')
    RETURNING id;
  `);
  const judge2Id = j2Res.rows[0].id;

  olderRawToken = generateToken();
  olderTokenHash = hashToken(olderRawToken);

  const inv2 = await pool.query(`
    INSERT INTO judge_invitations (
      judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'sent', NOW() - INTERVAL '26 hours', NOW() + INTERVAL '48 hours')
    RETURNING id;
  `, [judge2Id, comp2Res.rows[0].id, eventId, olderTokenHash]);

  await pool.query(`
    INSERT INTO auth_tokens (
      judge_id, invitation_id, token_hash, purpose, expires_at, created_at
    ) VALUES ($1, $2, $3, 'invitation', NOW() + INTERVAL '48 hours', NOW() - INTERVAL '26 hours');
  `, [judge2Id, inv2.rows[0].id, olderTokenHash]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Availability: Reject slot where start_time >= end_time with 400', async () => {
  const res = await request(app)
    .post(`/api/j/${freshRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: '2026-11-20T14:00:00Z',
          end_time: '2026-11-20T12:00:00Z', // start is after end
        },
      ],
    })
    .expect(400);

  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some(d => d.includes('strictly before end_time')));
});

test('Availability: Reject more than 10 slots with 400', async () => {
  const elevenSlots = Array.from({ length: 11 }, (_, i) => ({
    start_time: new Date(Date.now() + i * 3600000).toISOString(),
    end_time: new Date(Date.now() + (i + 1) * 3600000).toISOString(),
  }));

  const res = await request(app)
    .post(`/api/j/${freshRawToken}/availability`)
    .send({ slots: elevenSlots })
    .expect(400);

  assert.ok(res.body.errors ? res.body.errors[0].includes('more than 10') : res.body.details[0].includes('more than 10'));
});

test('Availability: Reject conflicting overlapping slots with 400', async () => {
  const baseTime = Date.now() + 86400000;
  const res = await request(app)
    .post(`/api/j/${freshRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: new Date(baseTime).toISOString(),
          end_time: new Date(baseTime + 7200000).toISOString(),
          is_available: true,
        },
        {
          start_time: new Date(baseTime + 3600000).toISOString(),
          end_time: new Date(baseTime + 10800000).toISOString(),
          is_available: false, // conflicting overlap
        },
      ],
    })
    .expect(400);

  assert.ok(res.body.details.some(d => d.includes('Conflicting overlapping availability')));
});

test('Availability: 24h fresh replacement policy replaces prior slots', async () => {
  // First declaration: 2 slots
  const t1 = Date.now() + 100000000;
  await request(app)
    .post(`/api/j/${freshRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: new Date(t1).toISOString(),
          end_time: new Date(t1 + 3600000).toISOString(),
        },
        {
          start_time: new Date(t1 + 7200000).toISOString(),
          end_time: new Date(t1 + 10800000).toISOString(),
        },
      ],
    })
    .expect(200);

  // Check 2 rows exist
  let check = await pool.query('SELECT * FROM judge_availability WHERE judge_id = $1', [judgeId]);
  assert.equal(check.rows.length, 2);

  // Second declaration (within 24 hours): replaces previous slots with 1 new slot
  const res = await request(app)
    .post(`/api/j/${freshRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: new Date(t1 + 14400000).toISOString(),
          end_time: new Date(t1 + 18000000).toISOString(),
        },
      ],
    })
    .expect(200);

  assert.equal(res.body.replaced_prior, true);
  assert.equal(res.body.count, 1);

  // Verify DB now holds ONLY the 1 replacement slot
  check = await pool.query('SELECT * FROM judge_availability WHERE judge_id = $1', [judgeId]);
  assert.equal(check.rows.length, 1);

  // Also verify generated column 'during' matches available_window
  assert.ok(check.rows[0].during);
  assert.equal(check.rows[0].during, check.rows[0].available_window);
});

test('Availability: Token older than 24h appends without deleting prior slots', async () => {
  const t2 = Date.now() + 200000000;

  // Insert initial slot for older token judge
  await request(app)
    .post(`/api/j/${olderRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: new Date(t2).toISOString(),
          end_time: new Date(t2 + 3600000).toISOString(),
        },
      ],
    })
    .expect(200);

  // Query judge2's ID
  const j2 = await pool.query("SELECT id FROM judges WHERE email = 'emmy.noether@gottingen.de'");
  const j2Id = j2.rows[0].id;

  let check = await pool.query('SELECT * FROM judge_availability WHERE judge_id = $1', [j2Id]);
  assert.equal(check.rows.length, 1);

  // Second submission on older token (> 24h)
  const res = await request(app)
    .post(`/api/j/${olderRawToken}/availability`)
    .send({
      slots: [
        {
          start_time: new Date(t2 + 7200000).toISOString(),
          end_time: new Date(t2 + 10800000).toISOString(),
        },
      ],
    })
    .expect(200);

  assert.equal(res.body.replaced_prior, false);
  assert.equal(res.body.count, 1);

  // Verify DB now holds BOTH prior and new slots (2 total)
  check = await pool.query('SELECT * FROM judge_availability WHERE judge_id = $1', [j2Id]);
  assert.equal(check.rows.length, 2);
});
