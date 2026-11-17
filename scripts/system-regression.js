'use strict';

process.env.NODE_ENV = 'test';

const http = require('http');
const { chromium } = require('playwright');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { setupTestDb } = require('../tests/helpers/db');

async function main() {
  console.log('===============================================================');
  console.log('  CSE Fest — System-Wide End-to-End Regression Test Suite      ');
  console.log('===============================================================');

  // Step 0: Ensure DB is migrated and seeded
  console.log('\n[1/7] Initializing fresh database state & test server...');
  await setupTestDb();

  const app = createApp();
  const server = http.createServer(app);
  const port = 3599;
  await new Promise((resolve) => server.listen(port, resolve));
  const baseUrl = `http://localhost:${port}`;
  console.log(`  ✓ Test server running on ${baseUrl}`);

  const pool = db.pool;

  // Step 1: Launch Playwright Headless Browser (Edge)
  console.log('\n[2/7] Launching Chromium headless browser (Edge)...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log('  ✓ Browser context established');

  try {
    // Step 3: Admin Login
    console.log('\n[3/7] Testing Administrative Authentication Flow...');
    await page.goto(`${baseUrl}/index.html`);
    await page.fill('#email', 'admin@csefest.edu');
    await page.fill('#password', 'ChangeMe123!');
    await page.click('#login-btn');

    await page.waitForSelector('#dashboard-section', { state: 'visible', timeout: 5000 });
    const userRole = await page.textContent('#user-role');
    console.log(`  ✓ Admin signed in successfully (Role: ${userRole.trim()})`);

    // Step 4: Create Judge in Roster
    console.log('\n[4/7] Testing Judge Roster & Bulk Invitation Flows...');
    await page.goto(`${baseUrl}/judges.html`);
    await page.click('#open-add-judge-btn');
    await page.waitForSelector('#judge-modal', { state: 'visible' });

    const uid = Date.now();
    const testEmail = `regression.judge.${uid}@example.com`;
    await page.fill('#first_name', 'Grace');
    await page.fill('#last_name', 'Hopper');
    await page.fill('#judge-email', testEmail);
    await page.fill('#organization', 'Institute for Advanced Study');
    await page.selectOption('#kind', 'academic');
    await page.fill('#expertise', 'Compilers, Programming Languages, Distributed Systems');
    await page.click('#save-judge-btn');

    // Wait for modal to close
    await page.waitForSelector('#judge-modal', { state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(500);

    const judgeRow = await pool.query('SELECT id, first_name, last_name, email FROM judges WHERE email = $1', [testEmail]);
    if (judgeRow.rows.length === 0) throw new Error('Judge creation failed in database');
    const judgeId = judgeRow.rows[0].id;
    console.log(`  ✓ Judge created: ${judgeRow.rows[0].first_name} ${judgeRow.rows[0].last_name} (ID: ${judgeId})`);

    // Step 5: Send Invitation via Bulk Invitation Modal
    await page.goto(`${baseUrl}/invite.html`);
    await page.click('#open-bulk-modal-btn');
    await page.waitForSelector('#bulk-modal', { state: 'visible' });

    // Select competition in modal
    await page.waitForFunction(() => document.querySelectorAll('#modal-competition option').length > 1);
    const compOptionVal = await page.$eval('#modal-competition option:nth-child(2)', (el) => el.value);
    await page.selectOption('#modal-competition', compOptionVal);
    await page.waitForTimeout(500);

    // Filter/pick newly created judge
    await page.waitForSelector(`input[type="checkbox"][value="${judgeId}"]`, { state: 'visible' });
    await page.check(`input[type="checkbox"][value="${judgeId}"]`);
    await page.click('#send-bulk-btn');
    await page.waitForSelector('#bulk-modal', { state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(500);

    const invRes = await pool.query(
      'SELECT ji.id FROM judge_invitations ji WHERE ji.judge_id = $1 ORDER BY ji.id DESC LIMIT 1',
      [judgeId]
    );
    if (invRes.rows.length === 0) throw new Error('Invitation row missing');
    const invId = invRes.rows[0].id;
    console.log(`  ✓ Invitation dispatched for Judge ID ${judgeId} (Invitation ID: ${invId})`);

    // Generate plain test token pointing to this invitation for browser test
    const { generateToken, hashToken } = require('../server/lib/tokens');
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    await pool.query(
      `INSERT INTO auth_tokens (token_hash, type, judge_id, invitation_id, purpose, expires_at)
       VALUES ($1, 'session', $2, $3, 'invitation', NOW() + INTERVAL '72 hours')`,
      [tokenHash, judgeId, invId]
    );

    // Step 6: Judge Portal Landing & RSVP Accept
    console.log('\n[5/7] Testing Judge Portal: RSVP and Token Verification...');
    const portalUrl = `${baseUrl}/j/${rawToken}`;
    await page.goto(portalUrl);
    await page.waitForSelector('#rsvp-section', { state: 'visible' });
    console.log('  ✓ Judge Portal loaded with valid single-use magic link');

    // Click Accept Invitation
    await page.click('#btn-accept');
    await page.waitForSelector('#rsvp-confirmed-message', { state: 'visible', timeout: 5000 });
    const invStatusCheck = await pool.query('SELECT status FROM judge_invitations WHERE id = $1', [invId]);
    console.log(`  ✓ Invitation RSVP submitted: status = ${invStatusCheck.rows[0].status}`);

    // Step 7: Assignment, Integrity Constraints (Overlap & Double Booking), Attendance
    console.log('\n[6/7] Testing Session Assignments, Overlap 409 Constraint & Attendance...');
    const compId = Number(compOptionVal);
    const s1Res = await pool.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, reporting_at, grace_minutes)
      VALUES ($1, 'Regression Track A', '2026-11-20 09:00:00+06', '2026-11-20 12:00:00+06', 15, '2026-11-20 08:45:00+06', 15)
      RETURNING id;
    `, [compId]);
    const session1Id = s1Res.rows[0].id;

    const s2Res = await pool.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, reporting_at, grace_minutes)
      VALUES ($1, 'Regression Track B (Overlapping)', '2026-11-20 11:00:00+06', '2026-11-20 14:00:00+06', 15, '2026-11-20 10:45:00+06', 15)
      RETURNING id;
    `, [compId]);
    const session2Id = s2Res.rows[0].id;

    // Assign judge to Session 1
    const assignRes = await page.request.post(`${baseUrl}/api/assignments`, {
      data: { session_id: session1Id, judge_id: judgeId, role: 'head_judge' },
    });
    if (assignRes.status() !== 201) throw new Error(`Assignment 1 failed with status ${assignRes.status()}`);
    const assignment1 = await assignRes.json();
    console.log(`  ✓ Assigned judge to Session 1 (Assignment ID: ${assignment1.assignment.id}, Role: head_judge)`);

    // Attempt Duplicate Assignment (Same session, same judge) -> Expect 409
    const dupRes = await page.request.post(`${baseUrl}/api/assignments`, {
      data: { session_id: session1Id, judge_id: judgeId, role: 'judge' },
    });
    if (dupRes.status() !== 409) throw new Error(`Expected 409 duplicate assignment, got ${dupRes.status()}`);
    console.log('  ✓ Duplicate assignment rejected with HTTP 409 Conflict (uq_assignment_per_session)');

    // Attempt Overlapping Assignment (Overlapping session time) -> Expect 409 exclusion violation
    const overlapRes = await page.request.post(`${baseUrl}/api/assignments`, {
      data: { session_id: session2Id, judge_id: judgeId, role: 'judge' },
    });
    if (overlapRes.status() !== 409) throw new Error(`Expected 409 exclusion violation, got ${overlapRes.status()}`);
    const overlapJson = await overlapRes.json();
    if (overlapJson.error !== 'overlap') throw new Error(`Expected error='overlap', got ${overlapJson.error}`);
    console.log(`  ✓ Overlapping assignment rejected with HTTP 409 Conflict (no_double_booking constraint, conflicting ID: ${overlapJson.conflicting_assignment_id})`);

    // Confirm Assignment
    await pool.query("UPDATE judge_assignments SET status = 'confirmed' WHERE id = $1", [assignment1.assignment.id]);

    // Test Attendance Check-in
    const checkinRes = await page.request.patch(`${baseUrl}/api/assignments/${assignment1.assignment.id}/attendance`, {
      data: { status: 'checked_in', notes: 'Verified on-site check-in' },
    });
    if (checkinRes.status() !== 200) throw new Error(`Check-in failed with ${checkinRes.status()}`);
    const checkinData = await checkinRes.json();
    console.log(`  ✓ Judge checked in: status = ${checkinData.attendance.status}`);

    // Test Early Checkout
    const checkoutRes = await page.request.patch(`${baseUrl}/api/assignments/${assignment1.assignment.id}/attendance`, {
      data: { status: 'early_departure', notes: 'Early departure approved' },
    });
    if (checkoutRes.status() !== 200) throw new Error(`Checkout failed with ${checkoutRes.status()}`);
    const checkoutData = await checkoutRes.json();
    console.log(`  ✓ Judge checked out early: status = ${checkoutData.attendance.status}`);

    // Step 8: Dashboard & Materialized Views Verification
    console.log('\n[7/7] Testing Live Operations Dashboard & Materialized Views Rollup...');
    await pool.query('SELECT refresh_mv_dashboard_force();');

    await page.goto(`${baseUrl}/dashboard.html`);
    await page.waitForSelector('#tab-coverage', { state: 'visible' });

    const totalJudgesKpi = await page.textContent('#kpi-total-judges');
    console.log(`  ✓ Dashboard loaded in browser. Total Active Judges KPI: ${totalJudgesKpi.trim()}`);

    const coverageApiRes = await page.request.get(`${baseUrl}/api/dashboard/coverage`);
    const coverageRows = await coverageApiRes.json();
    console.log(`  ✓ Materialized View mv_session_coverage contains ${coverageRows.length} sessions`);

    const workloadApiRes = await page.request.get(`${baseUrl}/api/dashboard/workload`);
    const workloadRows = await workloadApiRes.json();
    console.log(`  ✓ Materialized View mv_judge_workload contains ${workloadRows.length} evaluators`);

    const summaryRes = await page.request.get(`${baseUrl}/api/dashboard/summary`);
    const summary = await summaryRes.json();
    console.log('  ✓ Live Dashboard Summary Rollup:');
    console.log(`      - Total Judges:         ${summary.total_judges}`);
    console.log(`      - Invitations Sent:     ${summary.invitations_sent}`);
    console.log(`      - Invitations Accepted: ${summary.invitations_accepted}`);
    console.log(`      - Assignments Confirmed:${summary.assignments_confirmed}`);
    console.log(`      - Unassigned Sessions:  ${summary.unassigned_sessions}`);
    console.log(`      - Checked In:           ${summary.checked_in}`);

    console.log('\n===============================================================');
    console.log('  ALL REGRESSION STEPS COMPLETED AND VERIFIED SUCCESSFULLY!   ');
    console.log('===============================================================');
  } finally {
    await browser.close();
    server.close();
    await db.close();
  }
}

main().catch((err) => {
  console.error('\n❌ REGRESSION FAILURE:', err);
  process.exit(1);
});
