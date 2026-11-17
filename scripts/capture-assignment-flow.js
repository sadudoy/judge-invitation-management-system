'use strict';
process.env.NODE_ENV = 'test';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { generateToken, hashToken } = require('../server/lib/tokens');

async function main() {
  const pool = db.pool;
  const app = createApp();
  const server = http.createServer(app);

  const port = 3458;
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`Test server listening on port ${port}`);

  const uid = Date.now();
  // 1. Seed dedicated event & competition
  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('CSE Fest Grand Finale 2026', 'grand-finale-${uid}', NOW() + INTERVAL '5 days', NOW() + INTERVAL '7 days')
    RETURNING id;
  `);
  const eventId = evRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug, description, min_judges, max_judges)
    VALUES ($1, 'Autonomous Robotics Grand Prix', 'robotics-grand-prix-${uid}', 'Advanced obstacle navigation, SLAM mapping, and multi-agent coordination.', 2, 4)
    RETURNING id;
  `, [eventId]);
  const compId = compRes.rows[0].id;

  // 2. Create 2 sessions
  const s1Res = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, reporting_at, grace_minutes, status)
    VALUES ($1, 'Preliminary Track Navigation', '2026-11-28 09:00:00+06', '2026-11-28 11:30:00+06', 15, '2026-11-28 08:45:00+06', 15, 'scheduled')
    RETURNING id;
  `, [compId]);
  const session1Id = s1Res.rows[0].id;

  const s2Res = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, reporting_at, grace_minutes, status)
    VALUES ($1, 'Championship Final Elimination', '2026-11-28 13:00:00+06', '2026-11-28 16:00:00+06', 15, '2026-11-28 12:45:00+06', 15, 'scheduled')
    RETURNING id;
  `, [compId]);
  const session2Id = s2Res.rows[0].id;

  // 3. Create judges
  const j1Res = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, designation, kind, is_active, status, expertise)
    VALUES ('Alan', 'Turing', 'alan.turing.${uid}@cambridge.ac.uk', 'Cambridge Robotics', 'Professor', 'academic', true, 'active', ARRAY['Algorithms', 'Automata', 'Robotics'])
    RETURNING id;
  `);
  const judge1Id = j1Res.rows[0].id;

  const j2Res = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, designation, kind, is_active, status, expertise)
    VALUES ('Grace', 'Hopper', 'grace.hopper.${uid}@navy.mil', 'Compilers Lab', 'Director', 'industry', true, 'active', ARRAY['Systems', 'Compilers', 'Hardware'])
    RETURNING id;
  `);
  const judge2Id = j2Res.rows[0].id;

  const j3Res = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, designation, kind, is_active, status, expertise)
    VALUES ('Barbara', 'Liskov', 'barbara.liskov.${uid}@mit.edu', 'MIT EECS', 'Institute Professor', 'academic', true, 'active', ARRAY['Distributed Systems', 'Fault Tolerance'])
    RETURNING id;
  `);
  const judge3Id = j3Res.rows[0].id;

  // 4. Create assignments
  // Judge 1: Head Judge, Confirmed, Checked In
  const a1Res = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'head_judge', 'confirmed')
    RETURNING id;
  `, [session1Id, judge1Id]);
  const assign1Id = a1Res.rows[0].id;

  await pool.query(`
    INSERT INTO assignment_attendance (assignment_id, status, check_in_time, minutes_late, notes)
    VALUES ($1, 'checked_in', NOW() - INTERVAL '15 minutes', 0, 'Arrived early with hardware inspection toolkit')
  `, [assign1Id]);

  // Judge 2: Held assignment (awaiting confirmation)
  const a2Res = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'held')
    RETURNING id;
  `, [session1Id, judge2Id]);
  const assign2Id = a2Res.rows[0].id;

  // Launch Playwright Edge
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  console.log('1. Navigating to Admin Sign-In: http://localhost:' + port);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });

  // Fill in login credentials
  await page.fill('#email', 'admin@csefest.edu');
  await page.fill('#password', 'ChangeMe123!');
  await page.click('#login-btn');

  // Wait for dashboard to show
  await page.waitForSelector('#dashboard-section:not([style*="display: none"])');
  console.log('2. Admin authenticated successfully');

  // Reset console errors array after login check
  consoleErrors.length = 0;

  // Navigate to Assignments & Coverage
  console.log('3. Navigating to Assignments & Coverage page');
  await page.goto(`http://localhost:${port}/assignments.html`, { waitUntil: 'networkidle' });

  // Wait for competition dropdown to populate
  await page.waitForFunction(() => document.querySelectorAll('#select-competition option').length > 1);
  await page.selectOption('#select-competition', String(compId));
  await page.waitForTimeout(600);

  // Select session 1
  await page.waitForFunction(() => document.querySelectorAll('#select-session option').length > 1);
  await page.selectOption('#select-session', String(session1Id));
  await page.waitForTimeout(800);

  // Trigger feasibility sweep check
  await page.click('#btn-check-feasibility');
  await page.waitForTimeout(600);

  // Assign Barbara Liskov (judge3) to the session from the candidates table
  const assignBtn = await page.$(`button.btn-assign[data-judge-id="${judge3Id}"]`);
  if (assignBtn) {
    console.log('4. Assigning candidate Judge Barbara Liskov to session');
    await assignBtn.click();
    await page.waitForTimeout(1000);
  }

  // Ensure screenshots directory exists
  const screenshotDir = path.join(__dirname, '..', 'docs', 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const screenshotPath = path.join(screenshotDir, 'assignment-flow.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot saved to:', screenshotPath);

  // Copy to artifacts directory
  const artifactDir = 'C:\\Users\\sadud\\.gemini\\antigravity\\brain\\8dd7646d-169f-4964-944a-b6231a432c22';
  try {
    fs.copyFileSync(screenshotPath, path.join(artifactDir, 'assignment-flow.png'));
    console.log('Screenshot copied to artifact dir');
  } catch (e) {
    console.warn('Could not copy to artifact dir:', e.message);
  }

  await browser.close();
  server.close();

  if (consoleErrors.length > 0) {
    console.warn('Browser Console Errors Encountered:', consoleErrors);
  } else {
    console.log('Browser Console: Clean (0 errors)');
  }

  console.log('Phase 3 Playwright Browser Flow Complete!');
}

main().catch((err) => {
  console.error('Playwright Script Failed:', err);
  process.exit(1);
});
