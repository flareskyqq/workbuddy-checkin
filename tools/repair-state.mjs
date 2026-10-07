#!/usr/bin/env node
/**
 * 修复账号登录态：node tools/repair-state.mjs [账号名 ...]
 *
 * 背景（2026-09-27 定位）：
 *   登录流程在「检测到登录成功」的瞬间就抓取了 Cookie，但那一刻业务会话
 *   session / session_2 还没完成页面 JS 的「静默续期」。结果是：
 *     · 在浏览器里用（同一份 Cookie）→ 正常
 *     · 用纯 HTTP 带这份 Cookie 调接口 → 网关一直返回 401
 *   症状表现为「刚登录成功，马上就显示登录已过期」，而且重新扫码也没用。
 *
 *   本脚本不重新登录，只做一件事：把已保存的 Cookie 灌进无头浏览器、加载一次
 *   站点、等页面 JS 把会话刷成最终值，然后重新抓取并覆盖保存。实测可把 401 修回 200。
 *
 * 用法：
 *   node tools/repair-state.mjs 账号E 账号D     # 修指定账号
 *   node tools/repair-state.mjs                        # 修全部账号
 *   node tools/repair-state.mjs --max-age 5            # 主动保活：超过 5 天没续期就续一次
 *
 * --max-age <天>（或环境变量 REPAIR_MAX_AGE_DAYS）：
 *   WorkBuddy 的业务会话只有 7 天有效期。默认只在 401 时才修（被动）；
 *   加上 --max-age 5 就变成主动保活 —— 即使当前还能用，只要距上次续期超过 5 天就主动续一次，
 *   这样永远不会等到失效。daily-checkin.sh 默认用 --max-age 5。
 *
 * 注意：修复前后都会用纯 HTTP 实调一次接口验证，没修好的账号**不会被改动**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const ACCOUNTS_DIR = process.env.WBC_ACCOUNTS_DIR || path.join(ROOT, 'accounts');
const CONFIG_PATH = process.env.WBC_CONFIG || path.join(ROOT, 'config.json');

const CACHED_CHROMIUM = path.join(
  process.env.HOME || '',
  'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/' +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const SETTLE_MS = Number(process.env.REPAIR_SETTLE_MS || 10000);

function launchOpts() {
  const opts = {
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-infobars'],
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--enable-automation'],
  };
  const want = process.env.WBC_BROWSER || 'edge';
  const hasChrome = fs.existsSync('/Applications/Google Chrome.app');
  const hasEdge = fs.existsSync('/Applications/Microsoft Edge.app');
  const pick =
    want === 'edge' && hasEdge ? 'msedge' :
    want === 'chrome' && hasChrome ? 'chrome' :
    want === 'chromium' ? 'chromium' :
    hasChrome ? 'chrome' : hasEdge ? 'msedge' : 'chromium';
  if (pick === 'chrome') opts.channel = 'chrome';
  else if (pick === 'msedge') opts.channel = 'msedge';
  else if (fs.existsSync(CACHED_CHROMIUM)) opts.executablePath = CACHED_CHROMIUM;
  return opts;
}

/** 用保存的 Cookie 走纯 HTTP 实调一次接口，判断是否真的可用 */
async function verify(cookies, base) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: base,
    Referer: base + '/',
    Cookie: (cookies || []).map((c) => `${c.name}=${c.value}`).join('; '),
  };
  try {
    const r = await fetch(base + '/v2/billing/meter/checkin-activity-status', { method: 'POST', headers, body: '{}' });
    const t = await r.text();
    return r.status === 200 && t.includes('"code":0');
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
/** --max-age N：主动保活阈值（天）。0 = 关闭，只在 401 时才修 */
function parseMaxAge() {
  const i = argv.indexOf('--max-age');
  const v = i >= 0 ? argv[i + 1] : process.env.REPAIR_MAX_AGE_DAYS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
const MAX_AGE_DAYS = parseMaxAge();

function targetNames() {
  const skip = new Set(['--max-age', String(MAX_AGE_DAYS)]);
  const args = argv.filter((a) => !a.startsWith('-') && !skip.has(a));
  if (args.length) return args;
  let cfg = { accounts: [] };
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return (cfg.accounts || []).filter((a) => a.enabled !== false).map((a) => a.name);
}

const slug = (n) => String(n).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'account';

const names = targetNames();
if (!names.length) {
  console.log('没有要处理的账号。用法：node tools/repair-state.mjs [账号名 ...]');
  process.exit(0);
}

let fixed = 0, skipped = 0, failed = 0;

for (const name of names) {
  const file = path.join(ACCOUNTS_DIR, `${slug(name)}.state.json`);
  if (!fs.existsSync(file)) {
    console.log(`⚪️ ${name}：没有登录态文件，跳过（需要先 node checkin.mjs login ${name}）`);
    skipped++;
    continue;
  }
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = String(old.baseUrl || 'https://www.workbuddy.cn').replace(/\/+$/, '');

  /* 主动保活判定：业务会话 7 天到期，所以「距上次续期超过阈值」就提前续，不等 401 */
  const savedAt = Number(old.savedAt) || 0;
  const ageDays = savedAt ? (Date.now() - savedAt) / 86400000 : Infinity;
  const working = await verify(old.cookies, base);
  const stale = MAX_AGE_DAYS > 0 && ageDays >= MAX_AGE_DAYS;

  if (working && !stale) {
    const ageText = Number.isFinite(ageDays) ? `${ageDays.toFixed(1)} 天前续期` : '续期时间未知';
    console.log(`✅ ${name}：登录态正常（${ageText}），不用修`);
    skipped++;
    continue;
  }

  if (working) {
    console.log(`🔄 ${name}：登录态还能用，但已 ${ageDays.toFixed(1)} 天未续期（阈值 ${MAX_AGE_DAYS} 天），主动续期…`);
  } else {
    console.log(`🔧 ${name}：当前 401，正在用无头浏览器重新续期…`);
  }
  let st = null;
  try {
    const browser = await chromium.launch(launchOpts());
    const ctx = await browser.newContext({ userAgent: UA });
    await ctx.addCookies(old.cookies);
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);          // 等页面 JS 完成静默续期
    st = await ctx.storageState();
    await browser.close();
  } catch (e) {
    console.log(`❌ ${name}：浏览器续期失败 —— ${e.message}`);
    failed++;
    continue;
  }

  if (!(await verify(st.cookies, base))) {
    console.log(`❌ ${name}：续期后仍然 401（可能是登录态真的失效了，需要重新登录）—— 原文件未改动`);
    failed++;
    continue;
  }

  const { expiredAt, ...rest } = old;   // 修好了就清掉「已过期」标记
  fs.writeFileSync(file, JSON.stringify({
    ...rest,
    ...st,
    uid: old.uid || '',
    baseUrl: base,
    loginUrl: old.loginUrl || base,
    savedAt: Date.now(),
  }, null, 2) + '\n');
  try { fs.chmodSync(file, 0o600); } catch {}
  console.log(`✅ ${name}：已修复（Cookie ${old.cookies.length} → ${st.cookies.length} 个）`);
  fixed++;
}

console.log(`\n—— 修复 ${fixed} 个，跳过 ${skipped} 个，失败 ${failed} 个 ——`);
process.exit(failed ? 1 : 0);
