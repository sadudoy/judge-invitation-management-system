'use strict';

const path = require('path');
const { chromium } = require('playwright');

async function verifyBrowserLogin() {
  const screenshotPath = path.join(__dirname, '..', 'docs', 'screenshots', 'admin-post-login.png');
  const consoleLogs = [];
  const pageErrors = [];

  // Launch browser using installed Chrome or default chromium
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const preLoginLogs = [];
  const postLoginLogs = [];
  let isLoggedIn = false;

  // Listen to console events and page errors
  page.on('console', (msg) => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    if (isLoggedIn) {
      postLoginLogs.push(entry);
    } else {
      preLoginLogs.push(entry);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  console.log('Navigating to http://localhost:3000/...');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });

  console.log('Filling login credentials...');
  await page.fill('#email', 'admin@csefest.edu');
  await page.fill('#password', 'ChangeMe123!');

  console.log('Clicking login button...');
  isLoggedIn = true;
  await page.click('#login-btn');

  // Wait for post-login dashboard section to be visible
  await page.waitForSelector('#dashboard-section', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('#user-email', { state: 'visible' });

  const userEmailText = await page.textContent('#user-email');
  const userRoleText = await page.textContent('#user-role');
  const userFullNameText = await page.textContent('#user-fullname');

  console.log(`Rendered User Full Name: ${userFullNameText}`);
  console.log(`Rendered User Email: ${userEmailText}`);
  console.log(`Rendered User Role: ${userRoleText}`);

  // Capture screenshot
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved to: ${screenshotPath}`);

  // Retrieve session cookie
  const cookies = await context.cookies('http://localhost:3000');
  const sessionCookie = cookies.find((c) => c.name === 'connect.sid');

  await browser.close();

  return {
    screenshotPath,
    userEmailText,
    userRoleText,
    userFullNameText,
    preLoginLogs,
    postLoginLogs,
    pageErrors,
    sessionCookie: sessionCookie ? sessionCookie.value : null,
  };
}

verifyBrowserLogin()
  .then((result) => {
    console.log('\n--- BROWSER VERIFICATION SUMMARY ---');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Browser verification failed:', err);
    process.exit(1);
  });
