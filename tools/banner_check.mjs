import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext('/tmp/bannerprof-' + Date.now(), {
  headless: true, channel: 'chrome',
  args: ['--no-first-run', '--no-default-browser-check'],
  viewport: { width: 1360, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.workbuddy.cn/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const hits = [];
  const walk = (el) => {
    for (const c of el.children) {
      const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
      const cls = String(c.className || '');
      if (t && t.length < 120 && /Nova|暂无|没有|未开通|不支持|无权限|升级/.test(t) && /banner|notice|tip|alert|toast|top|bar/i.test(cls + ' ' + (c.getAttribute('role') || ''))) {
        hits.push({ tag: c.tagName, cls: cls.slice(0, 60), text: t.slice(0, 100) });
      }
      if (c.children.length) walk(c);
    }
  };
  walk(document.body);
  return {
    title: document.title,
    bodyHits: [...document.body.innerText.matchAll(/[^\n]*(Nova|暂无|没有|未开通|不支持|无权限)[^\n]*/g)].map((m) => m[0].trim()).slice(0, 12),
    bannerHits: hits.slice(0, 10),
  };
});
console.log(JSON.stringify(info, null, 1));
await ctx.close();
