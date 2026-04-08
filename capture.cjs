const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8081/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu-item[data-tab="cust-list"]');
  await page.click('.menu-item[data-tab="cust-list"]');
  await page.waitForTimeout(2000); // give time for the JS to trigger the override and render the UI
  await page.screenshot({ path: 'C:/Users/cgkan/.gemini/antigravity/brain/4cdf576b-bf59-402f-822f-50fc50850763/artifacts/proof_screenshot.png', fullPage: true });
  await browser.close();
})();
