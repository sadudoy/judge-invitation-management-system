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
let rawToken;
let tokenHash;
let judgeId;
let compId;

before(async () => {
  await setupTestDb();
  app = createApp();

  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('COI Fest', 'coi-fest', NOW() + INTERVAL '10 days', NOW() + INTERVAL '12 days')
    RETURNING id;
  `);
  const eventId = evRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug)
    VALUES ($1, 'COI Comp', 'coi-comp')
    RETURNING id;
  `, [eventId]);
  compId = compRes.rows[0].id;

  const jRes = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Barbara', 'Liskov', 'barbara.liskov@mit.edu', 'academic', 'active')
    RETURNING id;
  `);
  judgeId = jRes.rows[0].id;

  rawToken = generateToken();
  tokenHash = hashToken(rawToken);

  const invRes = await pool.query(`
    INSERT INTO judge_invitations (
      judge_id, competition_id, event_id, invitation_token, status, sent_at, expires_at
    ) VALUES ($1, $2, $3, $4, 'sent', NOW(), NOW() + INTERVAL '72 hours')
    RETURNING id;
  `, [judgeId, compId, eventId, tokenHash]);

  await pool.query(`
    INSERT INTO auth_tokens (
      judge_id, invitation_id, token_hash, purpose, expires_at
    ) VALUES ($1, $2, $3, 'invitation', NOW() + INTERVAL '72 hours');
  `, [judgeId, invRes.rows[0].id, tokenHash]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('COI: Reject conflict declaration with missing or short description (400)', async () => {
  const res = await request(app)
    .post(`/api/j/${rawToken}/conflicts`)
    .send({
      conflicts: [
        { subject_name: 'Team Alpha', description: 'ab' }, // min 3 chars
      ],
    })
    .expect(400);

  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some(d => d.includes('min 3 chars')));
});

test('COI: Declare conflict of interest items (200)', async () => {
  const res = await request(app)
    .post(`/api/j/${rawToken}/conflicts`)
    .send({
      conflicts: [
        {
          subject_name: 'Team Alpha',
          subject_kind: 'Former Advisee',
          description: 'Team lead is a recent graduate student from my research group.',
          severity: 'high',
        },
      ],
    })
    .expect(200);

  assert.equal(res.body.count, 1);
  assert.equal(res.body.conflicts[0].subject_name, 'Team Alpha');
  assert.equal(res.body.conflicts[0].severity, 'high');

  // Verify stored in judge_conflicts
  const check = await pool.query('SELECT * FROM judge_conflicts WHERE judge_id = $1', [judgeId]);
  assert.equal(check.rows.length, 1);
  assert.equal(check.rows[0].severity, 'high');
  assert.strictEqual(check.rows[0].superseded_by, null);
});

test('COI: Supersede earlier declaration updates predecessor superseded_by pointer', async () => {
  // Find initial conflict
  const initial = await pool.query('SELECT id FROM judge_conflicts WHERE judge_id = $1 LIMIT 1', [judgeId]);
  const initialId = initial.rows[0].id;

  // Submit revised conflict superseding initialId
  const res = await request(app)
    .post(`/api/j/${rawToken}/conflicts`)
    .send({
      conflicts: [
        {
          subject_name: 'Team Alpha',
          subject_kind: 'Former Advisee',
          description: 'Team lead graduated 3 years ago; low current contact.',
          severity: 'medium',
          supersedes_id: initialId,
        },
      ],
    })
    .expect(200);

  const newId = res.body.conflicts[0].id;

  // Verify predecessor row's superseded_by is now set to newId
  const predCheck = await pool.query('SELECT * FROM judge_conflicts WHERE id = $1', [initialId]);
  assert.equal(predCheck.rows[0].superseded_by, newId);
  // Verify predecessor content remains unchanged
  assert.equal(predCheck.rows[0].severity, 'high');
});

test('COI: Database immutability — direct UPDATE on content or DELETE fails with 42501', async () => {
  const row = await pool.query('SELECT id FROM judge_conflicts WHERE judge_id = $1 LIMIT 1', [judgeId]);
  const id = row.rows[0].id;

  // Direct content update attempt -> 42501
  await assert.rejects(
    async () => {
      await pool.query("UPDATE judge_conflicts SET description = 'Tampered text' WHERE id = $1", [id]);
    },
    (err) => {
      assert.equal(err.code, '42501', 'Direct content UPDATE on judge_conflicts must fail with 42501');
      return true;
    }
  );

  // Direct delete attempt -> 42501
  await assert.rejects(
    async () => {
      await pool.query('DELETE FROM judge_conflicts WHERE id = $1', [id]);
    },
    (err) => {
      assert.equal(err.code, '42501', 'Direct DELETE on judge_conflicts must fail with 42501');
      return true;
    }
  );
});

test('COI: Strict blinding — portal responses never leak participant rosters', async () => {
  const res = await request(app)
    .get(`/api/j/${rawToken}`)
    .expect(200);

  // Verify conflicts array returns judge-declared texts
  assert.ok(Array.isArray(res.body.conflicts));
  assert.ok(res.body.conflicts.length >= 2);

  // Assert blinding: no team_id, participant_id, score, or roster structure is leaked
  res.body.conflicts.forEach((c) => {
    assert.strictEqual(c.participant_id, undefined);
    assert.strictEqual(c.team_id, undefined);
    assert.strictEqual(c.roster, undefined);
  });
});
