import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext('/tmp/pricedump-' + Date.now(), {
  headless: true, channel: 'chrome', viewport: { width: 1440, height: 1200 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.workbuddy.cn/pricing/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);
const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
console.log(txt.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 90).join('\n'));
await ctx.close();
