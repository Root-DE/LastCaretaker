// run-tests.js — Headless browser test runner for CI
// Uses Playwright to open tests.html and check results

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Collect console output
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));

  await page.goto('http://localhost:8080/tests.html');

  // Wait for the summary element to have content (tests complete)
  await page.waitForFunction(
    () => document.getElementById('summary').textContent.trim().length > 0,
    { timeout: 30000 }
  );

  const summary = await page.$eval('#summary', el => el.textContent.trim());
  const failCount = await page.$$eval('.fail', els => els.length);

  console.log('Test results:', summary);
  if (logs.length > 0) {
    console.log('Console output:', logs.join('\n'));
  }

  await browser.close();

  if (failCount > 0) {
    console.error(`FAILED: ${failCount} test(s) failed`);
    process.exit(1);
  }

  console.log('All tests passed');
  process.exit(0);
})();
