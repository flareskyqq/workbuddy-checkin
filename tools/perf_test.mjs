import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CACHED = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const URL = 'https://www.workbuddy.cn/';

/** 只统计属于我们这个测试 profile 的进程，避免把用户自己开的 Chrome 算进来 */
function profileCpu(dir) {
  try {
    const out = execSync(`ps -A -o %cpu,command`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    let total = 0, n = 0, rss = 0;
    for (const line of out.split('\n')) {
      if (!line.includes(dir)) continue;
      const m = line.trim().match(/^([\d.]+)/);
      if (m) { total += parseFloat(m[1]); n++; }
    }
    return { total: Math.round(total * 10) / 10, procs: n };
  } catch { return { total: 0, procs: 0 }; }
}

async function run(label, { channel, executablePath }) {
  const dir = fs.mkdtempSync('/tmp/perfprof-');
  const opts = { headless: false, args: ['--no-first-run', '--no-default-browser-check', '--window-position=-3000,-3000'] };
  if (channel) opts.channel = channel;
  if (executablePath) opts.executablePath = executablePath;
  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(dir, { ...opts, viewport: null });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const navStart = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const dom = Date.now() - navStart;
  await page.waitForTimeout(9000);
  const samples = [];
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(1000); samples.push(profileCpu(dir).total); }
  const nav = await page.evaluate(() => {
    const t = performance.timing;
    return {
      loadMs: t.loadEventEnd ? t.loadEventEnd - t.navigationStart : -1,
      resources: performance.getEntriesByType('resource').length,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      gpu: (() => { try { const gl = document.createElement('canvas').getContext('webgl');
        const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'none'; } catch { return 'err'; } })(),
    };
  }).catch(() => ({}));
  const procs = profileCpu(dir).procs;
  await ctx.close();
  const avg = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;
  console.log(`${label}\n  启动 ${Date.now() - t0}ms | DOM就绪 ${dom}ms | 整页load ${nav.loadMs}ms | 请求 ${nav.resources} | JS堆 ${nav.heapMB}MB | 进程数 ${procs}`);
  console.log(`  空闲CPU均值 ${avg}%  采样 [${samples.join(', ')}]`);
  console.log(`  渲染器 ${nav.gpu}\n`);
}

await run('A. Chrome for Testing（原先用的）', { executablePath: CACHED });
await run('B. 系统 Google Chrome（打算换的）', { channel: 'chrome' });
