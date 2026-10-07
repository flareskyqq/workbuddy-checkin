import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function profileCpu(dir) {
  const out = execSync('ps -A -o %cpu,command', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  let total = 0;
  for (const line of out.split('\n')) if (line.includes(dir)) { const m = line.trim().match(/^([\d.]+)/); if (m) total += parseFloat(m[1]); }
  return Math.round(total * 10) / 10;
}
const avg = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;

const dir = fs.mkdtempSync('/tmp/perfsite-');
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false, channel: 'chrome', viewport: null,
  args: ['--no-first-run', '--no-default-browser-check', '--window-position=-3000,-3000'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

async function sample(secs = 6) {
  const s = [];
  for (let i = 0; i < secs; i++) { await page.waitForTimeout(1000); s.push(profileCpu(dir)); }
  return s;
}

await page.goto('about:blank');
await page.waitForTimeout(3000);
const base = await sample();
console.log(`空页面（浏览器本身）空闲CPU: ${avg(base)}%   [${base.join(', ')}]`);

await page.goto('https://www.workbuddy.cn/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
const site = await sample();
console.log(`打开 WorkBuddy 首页后空闲CPU: ${avg(site)}%   [${site.join(', ')}]`);

const stats = await page.evaluate(() => {
  const rs = performance.getEntriesByType('resource');
  const byHost = {};
  let totalBytes = 0;
  for (const r of rs) {
    let h = 'inline';
    try { h = new URL(r.name).hostname; } catch {}
    byHost[h] = byHost[h] || { n: 0, kb: 0 };
    byHost[h].n++;
    byHost[h].kb += Math.round((r.transferSize || 0) / 1024);
    totalBytes += r.transferSize || 0;
  }
  const top = Object.entries(byHost).sort((a, b) => b[1].kb - a[1].kb).slice(0, 8)
    .map(([h, v]) => `${h}  ${v.n}个请求 / ${v.kb}KB`);
  return { count: rs.length, totalKB: Math.round(totalBytes / 1024), top };
});
console.log(`\n页面请求 ${stats.count} 个，共约 ${stats.totalKB}KB。主要来源：`);
for (const t of stats.top) console.log('  ' + t);
await ctx.close();
