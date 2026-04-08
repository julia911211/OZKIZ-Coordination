const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:8080/index.html');
  await page.click('text=고객 DB');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'C:/Users/cgkan/.gemini/antigravity/brain/4cdf576b-bf59-402f-822f-50fc50850763/proof_screenshot.png' });
  await browser.close();
})();
