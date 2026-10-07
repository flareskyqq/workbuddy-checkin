import { chromium } from 'playwright-core';
const url = process.argv[2] || 'https://www.codebuddy.cn/profile/plan';
const ctx = await chromium.launchPersistentContext('/tmp/priceprof-' + Date.now(), {
  headless: true, channel: 'chrome', viewport: { width: 1360, height: 1000 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
await page.waitForTimeout(9000);
const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
const priceLines = lines.filter((l) => /[¥￥]\s?\d|\d+\s*元|积分|credits|Credits/.test(l)).slice(0, 40);
console.log('URL:', page.url());
console.log('标题:', await page.title());
console.log('--- 含价格/积分的行 ---');
priceLines.forEach((l) => console.log('  ' + l.slice(0, 120)));
await ctx.close();
