'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, runInRollback } = require('./helpers/db');

before(async () => {
  await setupTestDb();
});

after(async () => {
  await teardownTestDb();
});

test('Constraint: Overlapping assignments fail with 23P01 (exclusion_violation)', async () => {
  await runInRollback(async (client) => {
    // Create two overlapping sessions for Competition 1
    const s1Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S1-Overlap', '2026-11-25 10:00:00+06', '2026-11-25 11:30:00+06', 0)
      RETURNING id;
    `);
    const s2Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S2-Overlap', '2026-11-25 11:00:00+06', '2026-11-25 12:30:00+06', 0)
      RETURNING id;
    `);

    const s1Id = s1Res.rows[0].id;
    const s2Id = s2Res.rows[0].id;
    const judgeId = 1;

    // First assignment succeeds
    await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge');
    `, [s1Id, judgeId]);

    // Second assignment overlaps (11:00 to 11:30) -> must fail with 23P01
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO judge_assignments (session_id, judge_id, role)
          VALUES ($1, $2, 'judge');
        `, [s2Id, judgeId]);
      },
      (err) => {
        assert.equal(err.code, '23P01', `Expected exclusion_violation (23P01), got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });
});

test('Constraint: Adjacent assignments succeed without conflict', async () => {
  await runInRollback(async (client) => {
    // Create two strictly adjacent sessions (09:00-10:00 and 10:00-11:00, buffer 0)
    const s1Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S1-Adjacent', '2026-11-25 09:00:00+06', '2026-11-25 10:00:00+06', 0)
      RETURNING id;
    `);
    const s2Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S2-Adjacent', '2026-11-25 10:00:00+06', '2026-11-25 11:00:00+06', 0)
      RETURNING id;
    `);

    const s1Id = s1Res.rows[0].id;
    const s2Id = s2Res.rows[0].id;
    const judgeId = 1;

    // First assignment
    const a1 = await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge')
      RETURNING id, assignment_window;
    `, [s1Id, judgeId]);
    assert.ok(a1.rows[0].id);

    // Second adjacent assignment succeeds
    const a2 = await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge')
      RETURNING id, assignment_window;
    `, [s2Id, judgeId]);
    assert.ok(a2.rows[0].id);
  });
});

test('Constraint: Buffer-overlap fails with 23P01 (exclusion_violation)', async () => {
  await runInRollback(async (client) => {
    // S1 has 15-minute buffer: 09:00-10:00 + 15m => effective window [09:00, 10:15)
    const s1Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S1-Buffered', '2026-11-25 09:00:00+06', '2026-11-25 10:00:00+06', 15)
      RETURNING id;
    `);
    // S2 starts at 10:05, which is inside S1 buffer window (10:00 to 10:15)
    const s2Res = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'S2-BufferOverlap', '2026-11-25 10:05:00+06', '2026-11-25 11:00:00+06', 0)
      RETURNING id;
    `);

    const s1Id = s1Res.rows[0].id;
    const s2Id = s2Res.rows[0].id;
    const judgeId = 2;

    await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge');
    `, [s1Id, judgeId]);

    // Second assignment overlaps with buffer -> must fail with 23P01
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO judge_assignments (session_id, judge_id, role)
          VALUES ($1, $2, 'judge');
        `, [s2Id, judgeId]);
      },
      (err) => {
        assert.equal(err.code, '23P01', `Expected exclusion_violation (23P01), got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });
});

test('Constraint: Duplicate live invitations fail with 23505 (unique_violation)', async () => {
  await runInRollback(async (client) => {
    const eventId = 1;
    const judgeId = 8; // Judge 8 has no invitation in initial seed

    // First live invitation
    await client.query(`
      INSERT INTO judge_invitations (event_id, judge_id, invitation_token, status)
      VALUES ($1, $2, 'inv-live-first-test', 'invited');
    `, [eventId, judgeId]);

    // Second live invitation for the same event and judge must fail with 23505
    await assert.rejects(
      async () => {
        await client.query(`
          INSERT INTO judge_invitations (event_id, judge_id, invitation_token, status)
          VALUES ($1, $2, 'inv-live-second-test', 'invited');
        `, [eventId, judgeId]);
      },
      (err) => {
        assert.equal(err.code, '23505', `Expected unique_violation (23505), got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });
});

test('Constraint: Cancelled-then-new invitation succeeds', async () => {
  await runInRollback(async (client) => {
    const eventId = 1;
    const judgeId = 7;

    // Create initial live invitation
    const inv1 = await client.query(`
      INSERT INTO judge_invitations (event_id, judge_id, invitation_token, status)
      VALUES ($1, $2, 'inv-cancel-test-1', 'invited')
      RETURNING id;
    `, [eventId, judgeId]);
    const inv1Id = inv1.rows[0].id;

    // Cancel the invitation
    await client.query(`
      UPDATE judge_invitations
      SET status = 'cancelled', updated_at = now()
      WHERE id = $1;
    `, [inv1Id]);

    // Now creating a new live invitation for the same judge and event succeeds
    const inv2 = await client.query(`
      INSERT INTO judge_invitations (event_id, judge_id, invitation_token, status)
      VALUES ($1, $2, 'inv-cancel-test-2', 'invited')
      RETURNING id;
    `, [eventId, judgeId]);

    assert.ok(inv2.rows[0].id);
  });
});

test('Constraint: UPDATE and DELETE on judge_conflicts fail with 42501 (insufficient_privilege)', async () => {
  // Test UPDATE fails with 42501
  await runInRollback(async (client) => {
    await assert.rejects(
      async () => {
        await client.query(`
          UPDATE judge_conflicts
          SET description = 'Malicious unauthorized modification'
          WHERE id = 1;
        `);
      },
      (err) => {
        assert.equal(err.code, '42501', `Expected insufficient_privilege (42501) on UPDATE, got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });

  // Test DELETE fails with 42501
  await runInRollback(async (client) => {
    await assert.rejects(
      async () => {
        await client.query(`
          DELETE FROM judge_conflicts
          WHERE id = 1;
        `);
      },
      (err) => {
        assert.equal(err.code, '42501', `Expected insufficient_privilege (42501) on DELETE, got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });
});

test('Constraint: Session move re-syncs child assignments and preserves the constraint', async () => {
  await runInRollback(async (client) => {
    // Session A: 09:00 - 10:00
    const sARes = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'Session A', '2026-11-26 09:00:00+06', '2026-11-26 10:00:00+06', 0)
      RETURNING id;
    `);
    const sAId = sARes.rows[0].id;

    // Session B: initially at 14:00 - 15:00 (non-conflicting)
    const sBRes = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'Session B', '2026-11-26 14:00:00+06', '2026-11-26 15:00:00+06', 0)
      RETURNING id;
    `);
    const sBId = sBRes.rows[0].id;

    const judgeId = 3;

    // Assign Judge 3 to Session A
    await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge');
    `, [sAId, judgeId]);

    // Assign Judge 3 to Session B (succeeds, no overlap)
    await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, $2, 'judge');
    `, [sBId, judgeId]);

    // Now move Session B to overlap with Session A (09:30 to 10:30)
    // The trigger resync_assignments_on_session_change updates child assignments,
    // which triggers no_double_booking constraint check and MUST reject with 23P01!
    await assert.rejects(
      async () => {
        await client.query(`
          UPDATE sessions
          SET start_time = '2026-11-26 09:30:00+06',
              end_time = '2026-11-26 10:30:00+06'
          WHERE id = $1;
        `, [sBId]);
      },
      (err) => {
        assert.equal(err.code, '23P01', `Expected exclusion_violation (23P01) on session move, got ${err.code}: ${err.message}`);
        return true;
      }
    );
  });
});

test('Constraint: draft invitations do not collide', async () => {
  await runInRollback(async (client) => {
    const judgeId = 4;
    const competitionId = 1;

    // First draft invitation
    const draft1 = await client.query(`
      INSERT INTO judge_invitations (judge_id, competition_id, invitation_token, status)
      VALUES ($1, $2, 'inv-draft-collide-test-1', 'draft')
      RETURNING id;
    `, [judgeId, competitionId]);
    assert.ok(draft1.rows[0].id);

    // Second draft invitation for the same (judge_id, competition_id) -> must also succeed
    const draft2 = await client.query(`
      INSERT INTO judge_invitations (judge_id, competition_id, invitation_token, status)
      VALUES ($1, $2, 'inv-draft-collide-test-2', 'draft')
      RETURNING id;
    `, [judgeId, competitionId]);
    assert.ok(draft2.rows[0].id);
  });
});
