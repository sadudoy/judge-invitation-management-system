'use strict';
process.env.NODE_ENV = 'test';

const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { generateToken, hashToken } = require('../server/lib/tokens');

async function main() {
  const pool = db.pool;
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(3456, resolve));
  console.log('Test server listening on port 3456');

  const uid = Date.now();
  // Seed a sample judge, competition, and magic link
  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('National Hackathon 2026', 'national-hackathon-${uid}', NOW() + INTERVAL '14 days', NOW() + INTERVAL '16 days')
    RETURNING id;
  `);
  const eventId = evRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug, description)
    VALUES ($1, 'Software Design Challenge', 'software-design-challenge-${uid}', 'Enterprise-grade microservices and fault-tolerant system architecture evaluation.')
    RETURNING id;
  `, [eventId]);
  const compId = compRes.rows[0].id;

  const judgeRes = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, designation, kind, status, expertise)
    VALUES ('Leslie', 'Lamport', 'leslie.lamport.${uid}@microsoft.com', 'Microsoft Research', 'Principal Researcher', 'industry', 'active', ARRAY['Distributed Systems', 'Consensus', 'Formal Verification'])
    RETURNING id;
  `);
  const judgeId = judgeRes.rows[0].id;

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

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

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  console.log('Navigating to Judge Magic Link Portal: /j/' + rawToken);
  await page.goto(`http://localhost:3456/j/${rawToken}`, { waitUntil: 'networkidle' });

  // Wait for elements to render
  await page.waitForSelector('#btn-accept');

  // Fill in notes
  await page.fill('#rsvp-notes', 'Honored to evaluate. Prefer morning rounds on distributed system architectures.');

  // Add conflict declaration
  await page.click('#add-coi-btn');
  await page.waitForSelector('.coi-entry');
  await page.fill('.coi-name', 'Team Distributed Paxos');
  await page.fill('.coi-kind', 'Former Co-author');
  await page.selectOption('.coi-severity', 'medium');
  await page.fill('.coi-desc', 'Published a paper with team lead 4 years ago.');

  // Click Save Conflicts
  await page.click('#save-coi-btn');
  await page.waitForTimeout(600);

  // Click Accept RSVP
  await page.click('#btn-accept');
  await page.waitForTimeout(800);

  // Take screenshot
  const screenshotPath = path.join(__dirname, '..', 'docs', 'screenshots', 'invitation-flow.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot saved to:', screenshotPath);

  // Also copy to artifacts directory if available
  const artifactDir = 'C:\\Users\\sadud\\.gemini\\antigravity\\brain\\8dd7646d-169f-4964-944a-b6231a432c22';
  try {
    const fs = require('fs');
    fs.copyFileSync(screenshotPath, path.join(artifactDir, 'invitation-flow.png'));
    console.log('Screenshot copied to artifact dir');
  } catch (e) {
    console.warn('Could not copy to artifact dir:', e.message);
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
