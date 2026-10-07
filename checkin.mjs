#!/usr/bin/env node
/**
 * WorkBuddy 每日自动签到 + 积分统计采集（国内版，支持多账号）
 *
 *   node checkin.mjs add <账号名>           新增账号并登录（每个账号只需一次）
 *   node checkin.mjs login <账号名>         重新登录
 *   node checkin.mjs checkin [账号名 ...]   批量签到（不带账号 = 全部）
 *   node checkin.mjs status [账号名 ...]    只看状态，不领取
 *   node checkin.mjs stats [账号名 ...]     只采集积分/用量数据（不签到）
 *   node checkin.mjs list                   账号列表
 *   node checkin.mjs report [天数]          状态统计（各状态占比 / 失败趋势）
 *   node checkin.mjs doctor [账号名 ...]    排查登录/接口
 *
 * 可视化看板：node dashboard.mjs
 *
 * 参数：--dry-run  --mode http|browser|auto  --headed  --notify  --json
 *      --site cn|intl   登录站点（默认 cn 国内版）
 *      --params <curl>  用抓包内容调用（兜底）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { runTrae, discoverTraeAccounts, loadTraeConfig } from './trae.mjs';
import { writeJsonAtomic, acquireSingleInstanceLock } from './lib/safe-io.mjs';
import { notify, loadNotifyConfig } from './lib/notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

const CONFIG_PATH = env('WBC_CONFIG', path.join(ROOT, 'config.json'));
const ACCOUNTS_DIR = env('WBC_ACCOUNTS_DIR', path.join(ROOT, 'accounts'));
const PROFILES_DIR = env('WBC_PROFILES_DIR', path.join(ROOT, 'profiles'));
const LOGS_DIR = env('WBC_LOGS_DIR', path.join(ROOT, 'logs'));
const DATA_DIR = env('WBC_DATA_DIR', path.join(ROOT, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SITE_CN = 'https://www.workbuddy.cn';
const SITE_INTL = 'https://www.workbuddy.ai';

const API = {
  status: '/billing/meter/checkin-activity-status',
  claim: '/billing/meter/daily-checkin',
  summary: '/billing/meter/get-user-resource-summary',
  free: '/billing/meter/get-user-resource-free-packages',
  paid: '/billing/meter/get-user-resource-paid-packages',
  accounts: '/console/accounts',
};

/* 套餐包代码（取自客户端枚举） */
const FREE_CODES = [
  'TCACA_code_001_PqouKr6QWV', 'TCACA_code_008_cfWoLwvjU4', 'TCACA_code_035_ArVxJcGDsm',
  'TCACA_code_006_DbXS0lrypC', 'TCACA_code_039_KRcQj7wUat', 'TCACA_code_040_mi9rCYg46x',
  'TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_028_NtpWi0jzXs', 'TCACA_code_037_WxOD3MpI2o',
  'TCACA_code_029_6wCGEWquYy', 'TCACA_code_030_BjSt89qTvr',
];
const PAID_CODES = [
  'TCACA_code_002_AkiJS3ZHF5', 'TCACA_code_005_maRGyrHhw1', 'TCACA_code_003_FAnt7lcmRT',
  'TCACA_code_023_4xbGhMrE6q', 'TCACA_code_026_BaESVICNoi', 'TCACA_code_027_0FCGVA6vSa',
  'TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr', 'TCACA_code_036_lupO5WgNdG',
];
const PACKAGE_LABEL = {
  'TCACA_code_001_PqouKr6QWV': '每日免费额度',
  'TCACA_code_008_cfWoLwvjU4': '免费月包',
  'TCACA_code_035_ArVxJcGDsm': '免费月包(国际)',
  'TCACA_code_006_DbXS0lrypC': '赠送包',
  'TCACA_code_007_nzdH5h4Nl0': '活动赠送',
  'TCACA_code_028_NtpWi0jzXs': '权益赠送',
  'TCACA_code_029_6wCGEWquYy': '权益赠送',
  'TCACA_code_030_BjSt89qTvr': '权益赠送',
  'TCACA_code_037_WxOD3MpI2o': '权益赠送(国际)',
  'TCACA_code_039_KRcQj7wUat': 'Pro 试用月包',
  'TCACA_code_040_mi9rCYg46x': 'Pro 试用年包',
  'TCACA_code_002_AkiJS3ZHF5': 'Pro 月包',
  'TCACA_code_005_maRGyrHhw1': 'Pro Plus 月包',
  'TCACA_code_003_FAnt7lcmRT': 'Pro 年包',
  'TCACA_code_009_0XmEQc2xOf': '加量包',
  'TCACA_code_038_OhvqZtiPKr': '加量包',
  'TCACA_code_036_lupO5WgNdG': '加量包(国际)',
  'TCACA_code_023_4xbGhMrE6q': '青春版',
  'TCACA_code_026_BaESVICNoi': '高级版',
  'TCACA_code_027_0FCGVA6vSa': '旗舰版',
};

const DEFAULT_CONFIG = {
  baseUrl: SITE_CN,
  /* 积分折算人民币的单价（官方标价口径：标准版 ¥99/4000 积分 ≈ ¥0.02/积分） */
  creditToYuan: 0.02,
  baseCandidates: [SITE_CN, SITE_INTL],
  /* 直接开登录页：实测比走官网首页少 60% 请求、CPU 从 25% 降到 5% */
  loginUrl: SITE_CN + '/login/',
  accounts: [],
  /* 第二个站点：TraeWork CN（复用 TRAE 桌面客户端登录态，纯 HTTP，无需浏览器） */
  traework: { enabled: true, label: 'TraeWork', storages: [], disabled: [] },
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const CACHED_CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/' +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

/* ============================================================== 参数 & 基础 */

const rawArgs = process.argv.slice(2);
const ARGV = { _: [], json: false, mode: 'auto' };
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--dry-run') ARGV.dryRun = true;
  else if (a === '--headed') ARGV.headed = true;
  else if (a === '--notify') ARGV.notify = true;
  else if (a === '--json') ARGV.json = true;
  else if (a === '--mode') ARGV.mode = rawArgs[++i];
  else if (a === '--timeout') ARGV.timeout = Number(rawArgs[++i]);
  else if (a === '--params') ARGV.params = rawArgs[++i];
  else if (a === '--site') ARGV.site = rawArgs[++i];
  else if (a === '--qr') ARGV.qr = true;            // 无窗口扫码模式：二维码写到 data/ 由看板显示
  else if (a === '--window') ARGV.window = true;    // 强制用浏览器窗口登录
  else ARGV._.push(a);
}
const CMD = ARGV._.shift() || 'help';

function ensureDirs() {
  for (const d of [ACCOUNTS_DIR, PROFILES_DIR, LOGS_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });
}

function loadConfig() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  return { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
}
const saveConfig = (cfg) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');

const slug = (name) =>
  String(name).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'account';

const statePath = (name) => path.join(ACCOUNTS_DIR, `${slug(name)}.state.json`);
const profilePath = (name) => path.join(PROFILES_DIR, slug(name));
const readState = (name) => {
  try {
    return JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
  } catch {
    return null;
  }
};
const writeState = (name, data) => {
  /* 原子写：临时文件 + rename，避免写到一半崩溃留下半截 JSON */
  writeJsonAtomic(statePath(name), data, { mode: 0o600 });
};

/* 统计数据库 */
function readDb() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { updatedAt: null, accounts: {}, runs: [] };
  }
}
function writeDb(db) {
  ensureDirs();
  db.updatedAt = new Date().toISOString();
  /* 原子写：多个账号依次 upsert，中途崩溃不能留下半截 JSON */
  writeJsonAtomic(STATE_FILE, db);
}
function upsertStats(name, patch) {
  const db = readDb();
  const key = slug(name);
  const prev = db.accounts[key] || { name, history: [] };
  const merged = { ...prev, ...patch, name: prev.name || name, updatedAt: new Date().toISOString() };
  db.accounts[key] = merged;
  writeDb(db);
  return merged;
}

/**
 * 页面在 Keycloak 跳转 / SPA 重载时执行脚本会报
 * "Execution context was destroyed" —— 自动等页面稳定后重试，
 * 解决"扫码完成但积分读不出来"的问题。
 */
async function evalRetry(page, fn, arg, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await page.evaluate(fn, arg);   // ← 这里必须调用原始 API，不能递归
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/Execution context was destroyed|Cannot find context|Target closed|frame was detached|navigat/i.test(msg)) throw e;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

const UID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** WorkBuddy(Keycloak) 的用户 ID 藏在 KC 的 Cookie 里，用它判断"是不是同一个账号" */
function uidFromCookies(cookies) {
  for (const c of cookies || []) {
    if (!/keycloak|auth_session/i.test(String(c.name || ''))) continue;
    const m = UID_RE.exec(String(c.value || ''));
    if (m) return m[0];
  }
  return '';
}
/** 桌面客户端当前登录的账号（用它来判断"是不是被客户端顶着"） */
function desktopAccounts() {
  const out = [];
  const files = [
    [path.join(os.homedir(), '.workbuddy/storage/skeleton/account-snapshot.json'), 'WorkBuddy 桌面端'],
    [path.join(os.homedir(), '.workbuddy-ai/storage/skeleton/account-snapshot.json'), 'WorkBuddy AI 桌面端'],
  ];
  for (const [f, app] of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const pr = d?.primary;
      if (pr?.uid) out.push({ uid: pr.uid, nickname: pr.nickname || '', app });
    } catch {}
  }
  return out;
}
/** 这个 uid 是否正被桌面客户端占用 */
const desktopHolders = (uid) => (uid ? desktopAccounts().filter((d) => d.uid === uid) : []);

const stateUid = (name) => {
  const st = readState(name);
  return st?.uid || uidFromCookies(st?.cookies) || '';
};
/** 返回配置里其它「同一账号」的条目名 */
function duplicatesOf(name, uid, cfg) {
  if (!uid) return [];
  return (cfg?.accounts || [])
    .filter((a) => a.name !== name && stateUid(a.name) === uid)
    .map((a) => a.name);
}

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  if (!ARGV.json) console.log(msg);
  try {
    ensureDirs();
    fs.appendFileSync(path.join(LOGS_DIR, `checkin-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
  } catch {}
}

/** 把一次运行的结果按状态归类（结构化统计用）。
 *  优先用结果自带的 state（trae.mjs 会给），否则从 ok/already/needsLogin 反推。 */
function countStates(list = []) {
  const out = {};
  for (const r of list) {
    const s = r.state || (r.ok ? (r.already ? 'already' : 'ok') : (r.needsLogin ? 'auth' : 'failed'));
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

function notifyAccount(title, message) {
  try {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
  } catch {}
}

const findAccounts = (cfg, names) => {
  if (!names.length) return cfg.accounts.filter((a) => a.enabled !== false);
  return names.map((n) => {
    const hit = cfg.accounts.find((a) => a.name === n || slug(a.name) === slug(n));
    if (!hit) throw new Error(`配置里找不到账号：${n}`);
    return hit;
  });
};

/* ============================================================== 传输层 */

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

function cookieHeaderFor(cookies, baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return '';
  }
  return (cookies || [])
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      return d && (host === d || host.endsWith('.' + d));
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 轻量传输：直接带 Cookie / 令牌发请求 */
function httpTransport({ base, cookies, headers }) {
  const root = base.replace(/\/+$/, '');
  const cookie = cookieHeaderFor(cookies, root);
  const once = async (apiPath, body = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await fetch(root + apiPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          origin: root,
          referer: root + '/',
          'user-agent': UA,
          ...(cookie ? { cookie } : {}),
          ...(headers || {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { httpStatus: res.status, json, text: text.slice(0, 300) };
    } catch (e) {
      return { httpStatus: 0, json: null, text: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };
  /* 网络抖动（刚唤醒 / DNS 未就绪）自动重试，避免一次断网导致全部账号失败 */
  const call = async (apiPath, body = {}) => {
    let r = await once(apiPath, body);
    for (let i = 0; i < 3 && r.httpStatus === 0; i++) {
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      r = await once(apiPath, body);
    }
    return r;
  };
  return { kind: 'http', base: root, call, close: async () => {} };
}

/** cURL 抓包传输 */
function paramsTransport(spec) {
  let text = spec;
  if (fs.existsSync(spec)) text = fs.readFileSync(spec, 'utf8');
  const url = text.match(/curl\s+(['"])(.*?)\1/)?.[2] || text.match(/https?:\/\/\S+/)?.[0] || '';
  const headers = {};
  for (const m of text.matchAll(/-H\s+(['"])(.*?)\1/gs)) {
    const i = m[2].indexOf(':');
    if (i > 0) headers[m[2].slice(0, i).trim()] = m[2].slice(i + 1).trim();
  }
  const cookie = text.match(/-b\s+(['"])(.*?)\1/s);
  if (cookie) headers.cookie = cookie[2];
  const root = originOf(url) || SITE_CN;
  const call = async (apiPath, body = {}) => {
    try {
      const res = await fetch(root + apiPath, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const t = await res.text();
      let json = null;
      try {
        json = JSON.parse(t);
      } catch {}
      return { httpStatus: res.status, json, text: t.slice(0, 300) };
    } catch (e) {
      return { httpStatus: 0, json: null, text: String(e?.message || e) };
    }
  };
  return { kind: 'params', base: root, call, close: async () => {} };
}

/** 统一的启动参数：优先用系统已安装的 Chrome / Edge（启动更快、与系统输入法/字体更贴合） */
/**
 * 官网首页很重（117 请求 / 25% CPU），登录页极轻（42 请求 / 0.1% CPU）。
 * 配置里若写的是站点根地址，这里自动换成 /login/。
 */
function normalizeLoginUrl(url) {
  const u = String(url || '').trim();
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/login/';
      return parsed.toString();
    }
  } catch {}
  return u;
}

/** 选浏览器：config.browser = auto | chrome | edge | chromium（环境变量 WBC_BROWSER 优先） */
function preferredBrowser(cfgBrowser) {
  if (process.env.WBC_BROWSER) return process.env.WBC_BROWSER;
  return cfgBrowser || 'auto';
}

function launchOpts(headless, cfgBrowser) {
  const opts = {
    headless,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
    chromiumSandbox: true,
    // 连同 --enable-automation 一起忽略，Chrome 顶部就不会再出现"正受到自动测试软件控制"
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--enable-automation'],
  };
  const want = preferredBrowser(cfgBrowser);
  const hasChrome = fs.existsSync('/Applications/Google Chrome.app');
  const hasEdge = fs.existsSync('/Applications/Microsoft Edge.app');
  const pick =
    want === 'edge' && hasEdge ? 'msedge' :
    want === 'chrome' && hasChrome ? 'chrome' :
    want === 'chromium' ? 'chromium' :
    hasChrome ? 'chrome' :
    hasEdge ? 'msedge' : 'chromium';
  if (pick === 'chrome') opts.channel = 'chrome';
  else if (pick === 'msedge') opts.channel = 'msedge';
  else if (fs.existsSync(CACHED_CHROMIUM)) opts.executablePath = CACHED_CHROMIUM;
  return opts;
}

/**
 * 登录页会加载一堆广告/埋点脚本（实测让浏览器空闲时也占 ~25% CPU），
 * 这些跟登录无关，登录/采集时直接屏蔽，页面明显更跟手。
 * 万一平台风控需要它们，设 WBC_ALLOW_TRACKERS=1 即可放行。
 */
const TRACKER_HOSTS = [
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'googlesyndication.com',
  'galileotelemetry.tencent.com',
  'ping.cloud.tencent.com',
  'hm.baidu.com',
];
async function blockTrackers(ctx) {
  if (process.env.WBC_ALLOW_TRACKERS === '1') return;
  for (const host of TRACKER_HOSTS) {
    await ctx.route(`**://*.${host}/**`, (r) => r.abort()).catch(() => {});
  }
}

/** 浏览器传输：同源调用，自动携带完整登录态 */
async function withBrowser(account, { startUrl, headless, cfg }, fn) {
  const dir = profilePath(account.name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    ...launchOpts(headless, cfg?.browser),
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    userAgent: UA,
  });
  await blockTrackers(ctx);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (startUrl) {
      await page
        .goto(String(startUrl).replace(/\/+$/, '') + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => {});
    }
    const makeTransport = (base) => {
      const root = base.replace(/\/+$/, '');
      return {
        kind: 'browser',
        base: root,
        async call(apiPath, body = {}, extraHeaders = {}) {
          if (originOf(page.url()) !== root) {
            await page.goto(root + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          }
          return evalRetry(page, 
            async ({ u, b, h }) => {
              try {
                const r = await fetch(u, {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', ...h },
                  body: JSON.stringify(b ?? {}),
                });
                const t = await r.text();
                let j = null;
                try {
                  j = JSON.parse(t);
                } catch {}
                return { httpStatus: r.status, json: j, text: t.slice(0, 300) };
              } catch (e) {
                return { httpStatus: 0, json: null, text: String(e?.message || e) };
              }
            },
            { u: root + apiPath, b: body, h: extraHeaders }
          );
        },
        async callRaw(method, apiPath, extraHeaders = {}) {
          const url = root + apiPath;
          if (originOf(page.url()) !== root) {
            await page.goto(root + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          }
          return evalRetry(page, 
            async ({ u, m, h }) => {
              try {
                const r = await fetch(u, { method: m, credentials: 'include', headers: { accept: 'application/json', ...h } });
                const t = await r.text();
                let j = null;
                try {
                  j = JSON.parse(t);
                } catch {}
                return { httpStatus: r.status, json: j, text: t.slice(0, 300) };
              } catch (e) {
                return { httpStatus: 0, json: null, text: String(e?.message || e) };
              }
            },
            { u: url, m: method, h: extraHeaders }
          );
        },
      };
    };
    return await fn(makeTransport, page, ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** 从页面存储里找 JWT，用作 Authorization: Bearer */
async function findTokens(page) {
  return page
    .evaluate(() => {
      const out = new Set();
      const jwtLike = /^ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./;
      const scan = (store) => {
        for (let i = 0; i < store.length; i++) {
          const v = store.getItem(store.key(i)) || '';
          if (jwtLike.test(v.trim())) {
            out.add(v.trim());
            continue;
          }
          try {
            const walk = (o, d) => {
              if (!o || d > 4) return;
              if (typeof o === 'string') {
                if (jwtLike.test(o.trim())) out.add(o.trim());
              } else if (typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], d + 1);
            };
            walk(JSON.parse(v), 0);
          } catch {}
        }
      };
      try {
        scan(window.localStorage);
      } catch {}
      try {
        scan(window.sessionStorage);
      } catch {}
      return [...out].slice(0, 5);
    })
    .catch(() => []);
}

/* ============================================================== 接口封装 */

const isAuthed = (r) => !!(r && r.httpStatus === 200 && r.json && (r.json.code === 0 || r.json.data));
const isAuthError = (r) => !!(r && (r.httpStatus === 401 || r.httpStatus === 403));
const okOf = (r) => r?.httpStatus === 200 && r.json && r.json.code === 0;

/** 带 /v2 前缀回退的 POST */
async function apiPost(tr, apiPath, body = {}, headers = {}) {
  const first = await tr.call('/v2' + apiPath, body, headers);
  if (first.httpStatus === 404 || first.httpStatus === 405) return tr.call(apiPath, body, headers);
  return first;
}

async function apiGet(tr, apiPath, headers = {}) {
  if (tr.kind !== 'browser') {
    try {
      const r = await fetch(tr.base + '/v2' + apiPath, { headers: { accept: 'application/json', ...headers } });
      const t = await r.text();
      let j = null;
      try {
        j = JSON.parse(t);
      } catch {}
      return { httpStatus: r.status, json: j, text: t.slice(0, 300) };
    } catch (e) {
      return { httpStatus: 0, json: null, text: String(e?.message || e) };
    }
  }
  const first = await tr.callRaw('GET', '/v2' + apiPath, headers);
  if (first.httpStatus === 404) return tr.callRaw('GET', apiPath, headers);
  return first;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/* ============================================================== 数据采集 */

async function collectAccountData(tr, account) {
  const out = { name: account.name };
  const status = await apiPost(tr, API.status, {});
  if (!isAuthed(status)) return { ...out, authFailed: true, status };
  const d = status.json?.data || {};
  out.todayCheckedIn = !!d.today_checked_in;
  out.streakDays = num(d.streak_days);
  out.dailyCredit = num(d.daily_credit);
  out.checkinDates = Array.isArray(d.checkin_dates) ? d.checkin_dates : [];
  out.activityName = d.activity_name || '';
  out.themeName = d.theme_name || '';
  out.season = d.season || '';
  out.activityStart = d.start_time || '';
  out.activityEnd = d.end_time || '';
  out.todayCredit = num(d.today_credit);
  out.weekCheckinDays = num(d.week_checkin_days);
  out.weekProgress = Array.isArray(d.week_progress) ? d.week_progress : [];
  out.nextStreakDay = num(d.next_streak_day);
  out.streakBonusCredit = num(d.streak_bonus_credit);
  out.claimButtonText = d.claim_button_text || '';
  if (typeof d.total_credits === 'number') out.totalCredits = num(d.total_credits);

  /* 余额 / 用量总览 */
  const sum = await apiPost(tr, API.summary, {});
  if (okOf(sum) && sum.json.data) {
    const packages = (sum.json.data.Packages || []).map((p) => ({
      code: p.PackageCode || '',
      label: PACKAGE_LABEL[p.PackageCode] || p.PackageCode || '其他',
      total: num(p.CycleTotalCapacity),
      remain: num(p.CycleRemainCapacity),
      used: num(p.CycleUsedCapacity),
    }));
    const r2 = (x) => Math.round(x * 100) / 100;
    out.packages = packages;
    out.balance = r2(packages.reduce((s, p) => s + p.remain, 0));
    out.used = r2(packages.reduce((s, p) => s + p.used, 0));
    out.quotaTotal = r2(packages.reduce((s, p) => s + p.total, 0));
    out.isPaidUser = !!sum.json.data.IsPaidUser;
    out.subscriptionCode = sum.json.data.SubscriptionPackageCode || '';
  }

  /* 免费/付费包明细（拿不到就跳过，不影响主流程） */
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (dt) =>
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const slice = {
    SlicePeriodStartTime: fmt(new Date(now.setHours(0, 0, 0, 0))),
    SlicePeriodEndTime: fmt(new Date(new Date().setHours(23, 59, 59, 0))),
  };
  const detail = [];
  for (const [apiPath, codes, extra] of [
    [API.free, FREE_CODES, slice],
    [API.paid, PAID_CODES, { NeedRenewInfo: true }],
  ]) {
    const r = await apiPost(tr, apiPath, {
      PageNumber: 1,
      PageSize: 200,
      PackageCodes: codes,
      Status: [0, 3],
      ...extra,
    });
    if (!okOf(r)) continue;
    for (const item of r.json.data?.Accounts || []) {
      const total = num(item.CycleCapacitySizePrecise ?? item.CycleTotalCapacity);
      const remain = num(item.CycleCapacityRemainPrecise ?? item.CycleRemainCapacity);
      detail.push({
        code: item.PackageCode || '',
        label: PACKAGE_LABEL[item.PackageCode] || item.PackageCode || '其他',
        total,
        remain,
        used: Math.max(0, total - remain),
        startAt: item.CycleStartTime || item.StartTime || '',
        endAt: item.CycleEndTime || item.DeductionEndTime || item.ExpireTime || '',
        status: item.Status,
      });
    }
  }
  if (detail.length) out.packageDetails = detail;

  /* 账号资料 */
  const acc = await apiGet(tr, API.accounts);
  if (okOf(acc) && Array.isArray(acc.json.data?.accounts)) {
    const list = acc.json.data.accounts;
    const me = list[0] || {};
    out.nickname = me.nickname || me.name || '';
    out.uid = me.uid || '';
    out.editionType = me.editionType || '';
    out.isPro = !!(me.isPro ?? me.is_pro);
    out.enterpriseId = me.enterpriseId || '';
  }
  return out;
}

function mergeStats(account, data, extra = {}) {
  const prev = readDb().accounts[slug(account.name)] || {};
  const today = new Date().toISOString().slice(0, 10);
  const history = Array.isArray(prev.history) ? prev.history.slice(-364) : [];
  const point = {
    date: today,
    at: new Date().toISOString(),
    balance: data.balance ?? prev.balance ?? null,
    used: data.used ?? prev.used ?? null,
    credit: extra.credit ?? 0,
    checkedIn: data.todayCheckedIn ?? prev.todayCheckedIn ?? false,
  };
  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) history[idx] = { ...history[idx], ...point, credit: (history[idx].credit || 0) + (extra.credit || 0) };
  else history.push(point);

  const uid = stateUid(account.name);
  return upsertStats(account.name, {
    ...prev,
    ...data,
    ...extra,
    ...(uid ? { uid, desktopConflict: desktopHolders(uid).length > 0 } : {}),
    history,
    lastRunAt: new Date().toISOString(),
  });
}

/* ============================================================== 单账号流程 */

async function processAccount(account, cfg, { dryRun = false, statsOnly = false } = {}) {
  const result = { name: account.name, ok: false, already: false, credit: 0, text: '', mode: '' };
  const saved = readState(account.name);
  const loginStart = normalizeLoginUrl(saved?.loginUrl || account.loginUrl || cfg.loginUrl || cfg.baseUrl);
  const candidates = () =>
    [...new Set([saved?.baseUrl, account.baseUrl, cfg.baseUrl, ...(cfg.baseCandidates || [])].filter(Boolean))];

  const finish = async (tr, mode) => {
    const data = await collectAccountData(tr, account);
    if (data.authFailed) {
      return { ok: false, needsLogin: true, text: `登录已过期（HTTP ${data.status?.httpStatus}），需要重新登录`, mode, data: null };
    }
    if (statsOnly || dryRun) {
      const parts = [data.todayCheckedIn ? '今日已签到' : '今日未签到'];
      if (data.streakDays) parts.push(`连续 ${data.streakDays} 天`);
      if (data.balance !== undefined) parts.push(`余额 ${data.balance}`);
      if (data.used !== undefined) parts.push(`已用 ${data.used}`);
      mergeStats(account, data, {});
      return { ok: true, already: data.todayCheckedIn, credit: 0, text: `【查询】${parts.join('，')}`, mode, data };
    }
    const claim = await apiPost(tr, API.claim, {});
    const c = describeClaim(claim);
    // 领取后重新取一次余额，拿到最新数字
    const after = await collectAccountData(tr, account);
    const dataFinal = after.authFailed ? data : after;
    mergeStats(account, dataFinal, { credit: c.credit || 0, lastCheckinOk: c.ok });
    return { ok: c.ok, already: c.already, credit: c.credit || 0, text: c.text, mode, data: dataFinal };
  };

  try {
    /* 抓包模式 */
    if (ARGV.params) {
      const tr = paramsTransport(ARGV.params);
      if (statsOnly || dryRun) {
        const r = await finish(tr, 'params');
        return { ...result, ...r };
      }
      return { ...result, ...(await finish(tr, 'params')) };
    }

    /* 轻量模式 */
    const headers = { ...(saved?.headers || {}), ...(account.headers || {}) };
    if (ARGV.mode !== 'browser' && (saved?.cookies?.length || Object.keys(headers).length)) {
      for (const base of candidates()) {
        const tr = httpTransport({ base, cookies: saved?.cookies || [], headers });
        const probe = await apiPost(tr, API.status, {});
        if (isAuthError(probe)) continue;
        if (!isAuthed(probe)) {
          result.text = `接口异常：HTTP ${probe.httpStatus} ${probe.text}`;
          return result;
        }
        if (saved) writeState(account.name, { ...saved, baseUrl: base });
        return { ...result, ...(await finish(tr, 'http')) };
      }
      if (ARGV.mode === 'http')
        return { ...result, needsLogin: true, text: loginExpiredText(account, cfg) };
    }

    if (ARGV.mode === 'http') return { ...result, text: '未配置可用的登录态' };

    /* 浏览器模式 */
    return await withBrowser(account, { startUrl: loginStart, headless: !ARGV.headed, cfg }, async (makeTransport, page, ctx) => {
      let tr = null;
      let usedHeaders = {};
      await page.waitForTimeout(1500).catch(() => {});
      for (const base of [...new Set([originOf(page.url()), ...candidates()].filter(Boolean))]) {
        const cand = makeTransport(base);
        const probe = await apiPost(cand, API.status, {});
        if (isAuthed(probe)) {
          tr = cand;
          break;
        }
        for (const token of await findTokens(page)) {
          const retry = await apiPost(cand, API.status, {}, { authorization: `Bearer ${token}` });
          if (isAuthed(retry)) {
            tr = { ...cand, kind: 'browser', call: (p, b, h = {}) => cand.call(p, b, { authorization: `Bearer ${token}`, ...h }) };
            usedHeaders = { authorization: `Bearer ${token}` };
            break;
          }
        }
        if (tr) break;
      }
      if (!tr) {
        const cookiesNow = (await ctx.cookies().catch(() => [])).map((c) => `${c.name}@${String(c.domain).replace(/^\./, '')}`);
        const diag = { cookies: cookiesNow, keys: await evalRetry(page, () => Object.keys(window.localStorage)).catch(() => []) };
        return { ...result, needsLogin: true, diag, text: `登录已过期，需要重新登录：双击「登录账号.command」或执行 node checkin.mjs login ${account.name}` };
      }
      try {
        const st = await ctx.storageState();
        writeState(account.name, { ...st, baseUrl: tr.base, loginUrl: originOf(page.url()) || loginStart, headers: usedHeaders, savedAt: Date.now() });
      } catch {}
      return { ...result, ...(await finish(tr, 'browser')) };
    });
  } catch (e) {
    return { ...result, text: `异常：${e?.message || e}` };
  }
}

function describeClaim(r) {
  if (r?.httpStatus === 200 && r.json?.code === 0) {
    const d = r.json.data || {};
    const credit = num(d.credit ?? d.today_credit ?? 0);
    const streak = d.streak_days ? `，连续 ${d.streak_days} 天` : '';
    const bonus = d.is_streak_day ? '（含连签奖励）' : '';
    return { ok: true, already: false, credit, text: `签到成功${credit ? `，+${credit} 积分` : ''}${streak}${bonus}` };
  }
  const msg = r?.json?.msg || r?.text || '未知错误';
  if (/已签到|已经签到|重复|already|claimed/i.test(String(msg))) return { ok: true, already: true, credit: 0, text: '今天已经签到过了' };
  return { ok: false, already: false, credit: 0, text: `签到失败：${msg}` };
}

/** 登录失效时的说明：能识别出"同一账号重复添加"就给出具体原因 */
function loginExpiredText(account, cfg) {
  const uid = stateUid(account.name);
  const dups = duplicatesOf(account.name, uid, cfg);
  const cmd = `双击「登录账号.command」或执行 node checkin.mjs login ${account.name}`;
  const holders = desktopHolders(uid);
  if (dups.length) {
    return `登录已失效：它和「${dups.join('、')}」是同一个 WorkBuddy 账号，会互相顶掉登录态（同一个账号只能添加一次）。处理办法：删掉重复条目，或只保留一个并重登。`;
  }
  if (holders.length) {
    return `登录已失效：这个账号正被「${holders.map((h) => h.app).join('、')}」占着，同一账号多处登录会互相顶掉。处理办法：先在桌面客户端退出该账号，再重登；或不要添加它。`;
  }
  return `登录已过期，需要重新登录：${cmd}`;
}

/** 扫码模式：把二维码截图写到 data/qr-<账号>.png，供看板网页显示 */
const qrFile = (name) => path.join(DATA_DIR, `qr-${slug(name)}.png`);
function clearQr(name) {
  try { fs.unlinkSync(qrFile(name)); } catch {}
}

/* ============================================================== 登录 */

async function loginAccount(account, cfg) {
  const dir = profilePath(account.name);
  fs.mkdirSync(dir, { recursive: true });
  const timeoutMs = (ARGV.timeout || 600) * 1000;
  const started = Date.now();
  const useQr = !ARGV.window && (ARGV.qr || env('WBC_LOGIN_QR', '') === '1');
  const headless = useQr || env('WBC_LOGIN_HEADLESS', '') === '1';
  const site = normalizeLoginUrl(account.loginUrl || cfg.loginUrl || cfg.baseUrl);
  if (useQr) {
    log(`🔐 扫码登录【${account.name}】：二维码会显示在看板页面上（不打开浏览器窗口）`);
  } else {
    log(`🔐 打开浏览器，请登录【${account.name}】：${site}`);
    log('   （扫码/输密码都行，登录完成后这个窗口会自动关闭；别手动关掉它）');
  }
  clearQr(account.name);

  const ctx = await chromium.launchPersistentContext(dir, {
    ...launchOpts(headless, cfg?.browser),
    viewport: headless ? { width: 1280, height: 900 } : null,
  });
  await blockTrackers(ctx);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(String(site).replace(/\/+$/, '') + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    let found = null;
    let triedOther = false;
    let lastProbe = null;
    let lastBeat = 0;
    /* 扫码模式：先点掉「同意」，再抓取微信登录 iframe 里的二维码 */
    let lastQrAt = 0;
    let qrWarned = false;
    if (useQr) {
      /* 等「同意」按钮渲染出来再点（页面是 SPA，点早了没用） */
      let clicked = false;
      for (let i = 0; i < 25 && !clicked; i++) {
        clicked = await page
          .evaluate(() => {
            const el = [...document.querySelectorAll('button,a,div,span')].find((e) => /^同意$/.test((e.textContent || '').trim()));
            if (el) { el.click(); return true; }
            return false;
          })
          .catch(() => false);
        if (!clicked) await new Promise((r) => setTimeout(r, 1000));
      }
      log(clicked ? '   ✔ 已同意协议，正在获取二维码…' : '   ⚠️ 没找到「同意」按钮，可能页面结构变了');
      await new Promise((r) => setTimeout(r, 3000));
    }

    let tick = 0;
    while (Date.now() - started < timeoutMs) {
      /* 二维码每 10 秒重新截一次（微信二维码会过期自动刷新） */
      if (useQr && Date.now() - lastQrAt > 10000) {
        lastQrAt = Date.now();
        try {
          let frame = await page.$('#wechat-iframe');
          if (!frame) {
            /* 兼容：微信 iframe 可能换 id，退而求其次找 open.weixin 域名的 iframe */
            frame = await page.$('iframe[src*="open.weixin.qq.com"]');
          }
          if (!frame) {
            if (!qrWarned) { qrWarned = true; log('   ⏳ 二维码还没出现，稍后自动重试…'); }
            lastQrAt = Date.now() - 5000;   // 5 秒后重试
          }
          const shot = frame ? await frame.screenshot().catch(() => null) : null;
          if (shot && shot.length > 2000) {
            const tmp = qrFile(account.name) + '.tmp';
            fs.writeFileSync(tmp, shot);
            fs.renameSync(tmp, qrFile(account.name));
            log(`QR_READY ${qrFile(account.name)}`);
          }
        } catch (e) {
          log(`   （二维码抓取失败，稍后重试：${String(e.message).split('\n')[0]}）`);
        }
      }
      const origin = originOf(page.url());
      /* 轮询策略：先读 Cookie（不执行页面脚本，开销极低），
         只有出现登录痕迹、或每 8 轮，才去校验一次接口，避免自己给页面添卡 */
      const cookieNamesNow = (await ctx.cookies().catch(() => [])).map((c) => c.name);
      const looksLoggedIn = cookieNamesNow.some((n) => /^(session|keycloak|auth_session)/i.test(n));
      const shouldProbe = looksLoggedIn || tick % 8 === 0;
      tick++;
      if (origin && shouldProbe) {
        const r = await evalRetry(page, 
          async ({ u }) => {
            try {
              const res = await fetch(u, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: '{}',
              });
              const t = await res.text();
              let j = null;
              try {
                j = JSON.parse(t);
              } catch {}
              return { httpStatus: res.status, json: j, text: t.slice(0, 200) };
            } catch (e) {
              return { httpStatus: 0, json: null, text: String(e?.message || e) };
            }
          },
          { u: origin + '/v2' + API.status }
        );
        lastProbe = r;
        if (isAuthed(r)) {
          found = { base: origin };
          break;
        }
      }
      const names = cookieNamesNow;
      if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        const waited = Math.round((Date.now() - started) / 1000);
        const hint = names.length ? `已出现 Cookie（${names.slice(0, 3).join(', ')}…）` : '尚未检测到登录';
        log(`   ⏳ 等待中 ${waited}s｜当前页面：${originOf(page.url()) || '未打开'}｜${hint}`);
      }
      if (names.some((n) => /^session/i.test(n)) && !triedOther) {
        triedOther = true;
        for (const other of (cfg.baseCandidates || []).filter((b) => originOf(b) !== origin)) {
          const r = await page
            .evaluate(
              async ({ u }) => {
                try {
                  const res = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
                  let j = null;
                  try {
                    j = JSON.parse(await res.text());
                  } catch {}
                  return { httpStatus: res.status, json: j };
                } catch (e) {
                  return { httpStatus: 0, json: null };
                }
              },
              { u: originOf(other) + '/v2' + API.status }
            )
            .catch(() => null);
          if (r && isAuthed(r)) {
            found = { base: originOf(other) };
            break;
          }
        }
      }
      if (found) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (found) {
      clearQr(account.name);

      /* ⚠️ 关键修复（2026-09-27）：登录成功的那一刻，业务会话 session / session_2
         还没完成「静默续期」，此时抓下来的 Cookie 会一直 401。
         实测：登录瞬间立刻 storageState() → 存下来的 Cookie 每次都 401；
               让页面重新加载一次并等 JS 把会话刷成最终值再抓 → 正常可用。
         所以这里必须先重新加载站点并等待，再保存。 */
      try {
        await page.goto(found.base.replace(/\/+$/, '') + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch {}
      await new Promise((r) => setTimeout(r, 10000));

      const st = await ctx.storageState();
      const uid = uidFromCookies(st.cookies);
      writeState(account.name, {
        ...st,
        uid,
        baseUrl: found.base,
        loginUrl: originOf(page.url()) || found.base,
        savedAt: Date.now(),
      });
      /* 稳定性复验：登录后等 12 秒再验一次，能提前发现"刚登上就被别处顶掉" */
      try {
        await new Promise((r) => setTimeout(r, 12000));
        const recheck = await evalRetry(
          page,
          async ({ u }) => {
            try {
              const res = await fetch(u, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: '{}',
              });
              const t = await res.text();
              let j = null;
              try { j = JSON.parse(t); } catch {}
              return { httpStatus: res.status, json: j };
            } catch (e) {
              return { httpStatus: 0, json: null };
            }
          },
          { u: found.base.replace(/\/+$/, '') + '/v2' + API.status }
        ).catch(() => null);
        if (recheck && !isAuthed(recheck)) {
          log('⚠️ 登录成功 12 秒后这个会话就失效了 —— 说明该账号在别处还有登录（桌面客户端 / 手机 / 其它浏览器），');
          log('   或者短时间内被反复登录触发了平台风控。建议：先在别处退出该账号，隔 10 分钟再重试一次。');
        } else if (recheck) {
          /* 复验通过后再抓一次，确保存下来的是续期后的最终会话 */
          try {
            const st2 = await ctx.storageState();
            writeState(account.name, {
              ...st2,
              uid: uidFromCookies(st2.cookies) || uid,
              baseUrl: found.base,
              loginUrl: originOf(page.url()) || found.base,
              savedAt: Date.now(),
            });
          } catch {}
          log('   ✔ 会话稳定性检查通过');
        }
      } catch {}

      const holders = desktopHolders(uid);
      if (holders.length) {
        log(`🚫 重要：这个账号正是「${holders.map((h) => h.app).join('、')}」当前登录的账号${holders[0].nickname ? `（${holders[0].nickname}）` : ''}。`);
        log('   同一个账号在多处登录会互相顶掉：桌面端一刷新，网页这边就会被踢下线（通常几十秒内失效）。');
        log('   要让这个号自动签到，请先在桌面客户端里退出该账号；否则它无法稳定使用。');
      }
      const dups = duplicatesOf(account.name, uid, cfg);
      if (dups.length) {
        log(`⚠️ 注意：这个账号和「${dups.join('、')}」其实是【同一个 WorkBuddy 账号】（用户ID ${uid.slice(0, 8)}…）。`);
        log('   同一个账号只能添加一次，两个条目会互相顶掉登录状态 —— 建议删掉重复的那个。');
      }
      const db = readDb();
      upsertStats(account.name, { ...(db.accounts[slug(account.name)] || {}), site: found.base, loggedIn: true });
      log(`✅ 登录成功：${account.name}（${found.base}）`);

      // 趁着当前浏览器窗口会话活跃且已鉴权，立即同步完整积分数据，避免关闭后无头采集时差
      try {
        const root = found.base.replace(/\/+$/, '');
        const tr = {
          kind: 'browser',
          base: root,
          async call(apiPath, body = {}, h = {}) {
            return evalRetry(page, 
              async ({ u, b, headers }) => {
                try {
                  const r = await fetch(u, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', ...headers },
                    body: JSON.stringify(b ?? {}),
                  });
                  const t = await r.text();
                  let j = null;
                  try { j = JSON.parse(t); } catch {}
                  return { httpStatus: r.status, json: j, text: t.slice(0, 300) };
                } catch (e) {
                  return { httpStatus: 0, json: null, text: String(e?.message || e) };
                }
              },
              { u: root + apiPath, b: body, headers: h }
            );
          },
          async callRaw(method, apiPath, h = {}) {
            return evalRetry(page, 
              async ({ u, m, headers }) => {
                try {
                  const r = await fetch(u, { method: m, credentials: 'include', headers: { accept: 'application/json', ...headers } });
                  const t = await r.text();
                  let j = null;
                  try { j = JSON.parse(t); } catch {}
                  return { httpStatus: r.status, json: j, text: t.slice(0, 300) };
                } catch (e) {
                  return { httpStatus: 0, json: null, text: String(e?.message || e) };
                }
              },
              { u: root + apiPath, m: method, headers: h }
            );
          },
        };
        /* 刚登录完页面可能还在跳转，先等稳定再采集，避免 context destroyed */
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
        const data = await collectAccountData(tr, account);
        if (!data.authFailed) {
          mergeStats(account, data, {});
          log(`📊 已直接采集积分数据：${account.name}（余额: ${data.balance ?? '—'}，已用: ${data.used ?? '—'}）`);
        }
      } catch (e) {
        log(`⚠️ 登录后同步积分失败：${e?.message || e}`);
      }

      return true;
    }
    const names = (await ctx.cookies().catch(() => [])).map((c) => `${c.name}@${String(c.domain).replace(/^\./, '')}`);
    /* 只有业务会话 Cookie（session / session_2）才算真的登录成功；
       Keycloak 的 AUTH_SESSION_ID 等在登录页就会写，不能作为判据 */
    const hasAuthCookie = names.some((n) => /^session(_2)?$/i.test(n));
    if (hasAuthCookie) {
      try {
        const st = await ctx.storageState();
        const origin = originOf(page.url()) || site;
        writeState(account.name, { ...st, baseUrl: origin, loginUrl: origin, savedAt: Date.now() });
        upsertStats(account.name, { loggedIn: true, site: origin });
        log(`⚠️ 已保存登录态：${account.name}（检测到登录 Cookie，但签到接口未通过校验）`);
        log(`   接下来跑：node checkin.mjs checkin ${account.name}，若仍失败用 node checkin.mjs doctor --headed ${account.name} 排查`);
        return true;
      } catch {}
    }
    clearQr(account.name);
    log(`⚠️ 未检测到登录成功：${account.name}`);
    log(`   当前站点：${originOf(page.url()) || '未知'}；Cookie：${names.join(', ') || '无'}`);
    if (lastProbe) log(`   签到接口：HTTP ${lastProbe.httpStatus}${lastProbe.json?.code !== undefined ? ` code=${lastProbe.json.code}` : ''}`);
    log('   可加 --headed 观察页面，或用 doctor 排查。');
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function deleteAccount(name) {
  const cfg = loadConfig();
  const initialLen = (cfg.accounts || []).length;
  cfg.accounts = (cfg.accounts || []).filter((a) => a.name !== name && slug(a.name) !== slug(name));
  const removedConfig = cfg.accounts.length !== initialLen;
  saveConfig(cfg);

  // 删除 state 文件
  const sFile = statePath(name);
  if (fs.existsSync(sFile)) {
    try { fs.unlinkSync(sFile); } catch {}
  }

  // 删除浏览器 profile 目录
  const pDir = profilePath(name);
  if (fs.existsSync(pDir)) {
    try { fs.rmSync(pDir, { recursive: true, force: true }); } catch {}
  }

  // 从 state.json 中删除
  const db = readDb();
  const key = slug(name);
  if (db.accounts && (db.accounts[key] || db.accounts[name])) {
    delete db.accounts[key];
    delete db.accounts[name];
    writeDb(db);
  }

  log(`🗑️ 已彻底删除账号【${name}】${removedConfig ? '（已从配置文件中移除）' : ''}`);
  return true;
}

/* ============================================================== 命令 */

async function main() {
  const cfg = loadConfig();

  if (['help', '--help', '-h'].includes(CMD)) {
    console.log(
      [
        'WorkBuddy 每日自动签到 + 积分统计（国内版，多账号）',
        '',
        '  node checkin.mjs add <账号名>          新增账号并登录',
        '  node checkin.mjs del <账号名>          删除账号及其数据与缓存',
        '  node checkin.mjs login <账号名>        重新登录',
        '  node checkin.mjs checkin [账号名..]    批量签到',
        '  node checkin.mjs status [账号名..]     只看状态',
        '  node checkin.mjs stats [账号名..]      只采集积分数据（不签到）',
        '  node checkin.mjs list                  账号列表',
        '  node checkin.mjs report [天数]         状态统计（各状态占比 / 失败趋势，默认 30 天）',
        '  node checkin.mjs doctor [账号名..]     排查问题',
        '  node trae.mjs help                     TraeWork 站点单独操作',
        '    · node trae.mjs add <名字>           新增 TraeWork 网页账号（弹浏览器登录一次）',
        '    · node trae.mjs list / checkin / doctor',
        '  node dashboard.mjs                     打开可视化看板',
        '',
        '说明：checkin / status / stats / list 会同时处理 TraeWork CN 账号',
        '      （桌面客户端登录态自动发现；网页账号用 node trae.mjs add 添加；',
        '       可在 config.json 的 traework.enabled 关闭）。',
        '',
        '可选：--dry-run --mode http|browser|auto --headed --notify --json',
        '      --site cn|intl   登录站点（默认 cn）',
        '      --params <curl 文本或文件>',
      ].join('\n')
    );
    return 0;
  }

  if (CMD === 'del' || CMD === 'delete' || CMD === 'remove' || CMD === 'rm') {
    const name = ARGV._[0];
    if (!name) throw new Error('请提供要删除的账号名，例如：node checkin.mjs del 小号1');
    deleteAccount(name);
    return 0;
  }

  if (CMD === 'list') {
    const db = readDb();
    if (!cfg.accounts.length) {
      console.log('还没有 WorkBuddy 账号，先执行：node checkin.mjs add 账号名');
    } else {
      const seen = {};
      for (const a of cfg.accounts) {
        const st = readState(a.name);
        const s = db.accounts[slug(a.name)];
        const uid = st?.uid || uidFromCookies(st?.cookies) || '';
        const tag = st?.expiredAt ? '🔴 登录已失效（需重登）' : st ? '🟢 已登录' : '⚪️ 未登录';
        const extra = s?.balance !== undefined ? `｜余额 ${s.balance}｜已用 ${s.used ?? 0}` : '';
        let dupTag = '';
        if (uid) {
          if (seen[uid]) dupTag = `  ⚠️ 与「${seen[uid]}」是同一个账号`;
          else seen[uid] = a.name;
        }
        console.log(`${a.name}  ${tag}${extra}${a.enabled === false ? '（已停用）' : ''}${dupTag}`);
      }
    }

    /* —— TraeWork 站点（登录态来自 TRAE 桌面客户端，只读）—— */
    try {
      const tcfg = loadTraeConfig();
      if (tcfg.enabled) {
        const { accounts: tacc } = await discoverTraeAccounts(tcfg);
        if (tacc.length) {
          console.log(`\n${tcfg.label}：`);
          for (const a of tacc) {
            const leftD = a.expiredAt ? Math.floor((a.expiredAt - Date.now()) / 86400000) : null;
            const tag =
              leftD === null ? '🟢 已登录'
                : leftD <= 0 ? '🔴 登录态已过期（请打开一次 TRAE CN）'
                  : leftD <= 3 ? `🟡 登录态 ${leftD} 天后过期`
                    : `🟢 已登录（${leftD} 天后过期）`;
            console.log(`${a.name}  ${tag}  ［${a.app}］`);
          }
        } else {
          console.log(`\n${tcfg.label}：未发现登录态（打开并登录 TRAE CN 桌面客户端即可）`);
        }
      }
    } catch (e) {
      console.log(`\nTraeWork 读取失败：${e.message}`);
    }
    return 0;
  }

  if (CMD === 'add' || CMD === 'login') {
    const name = ARGV._[0];
    if (!name) throw new Error('请提供账号名，例如：node checkin.mjs add 小号1');
    let account = cfg.accounts.find((a) => a.name === name);
    if (!account) {
      account = { name };
      cfg.accounts.push(account);
      log(`➕ 已添加账号：${name}`);
    }
    if (ARGV.site) {
      account.loginUrl = ARGV.site === 'intl' ? SITE_INTL + '/' : SITE_CN + '/';
    } else if (!account.loginUrl) {
      account.loginUrl = cfg.loginUrl;
    }
    saveConfig(cfg);
    return (await loginAccount(account, cfg)) ? 0 : 1;
  }

  if (CMD === 'report') {
    /* 结构化日志统计：看各状态占比与失败趋势。
       runs 里每条记录都带 states（各状态数量），是 countStates() 存进去的。 */
    const db = readDb();
    const runs = db.runs || [];
    if (!runs.length) {
      console.log('还没有运行记录。先执行 node checkin.mjs checkin');
      return 0;
    }
    const days = Number(ARGV._[0]) || 30;
    const since = Date.now() - days * 86400000;
    const recent = runs.filter((r) => new Date(r.at).getTime() >= since);

    const totals = {};
    let ok = 0, total = 0, gained = 0, failRuns = 0;
    for (const r of recent) {
      total += r.total || 0;
      ok += r.ok || 0;
      gained += r.gained || 0;
      if ((r.ok || 0) < (r.total || 0)) failRuns += 1;
      if (r.states && Object.keys(r.states).length) {
        for (const [k, v] of Object.entries(r.states)) totals[k] = (totals[k] || 0) + v;
      } else {
        /* 旧记录（states 字段上线前）没有明细，用 ok/total 兜底分类 */
        if (r.ok) totals.ok = (totals.ok || 0) + r.ok;
        const f = (r.total || 0) - (r.ok || 0);
        if (f > 0) totals.failed = (totals.failed || 0) + f;
      }
    }
    const LABEL = {
      ok: '签到成功', already: '今日已签到', auth: '登录态失效', throttled: '被限流',
      inactive: '活动未开放', gateway: '网关拦截', network: '网络失败',
      badRequest: '请求参数错误', unknown: '未知错误', failed: '失败',
    };
    console.log(`最近 ${days} 天：${recent.length} 次运行（其中 ${failRuns} 次有失败）`);
    console.log(`账号次：${ok}/${total} 成功（${total ? ((ok / total) * 100).toFixed(1) : '0'}%）｜共领取 ${gained} 积分`);
    console.log('\n各状态次数：');
    const maxV = Math.max(...Object.values(totals), 1);
    for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(LABEL[k] || k).padEnd(12)} ${String(v).padStart(4)}  ${'█'.repeat(Math.max(1, Math.round((v / maxV) * 28)))}`);
    }
    return 0;
  }

  if (CMD === 'doctor') {
    for (const account of findAccounts(cfg, ARGV._)) {
      const saved = readState(account.name);
      const out = await withBrowser(
        account,
        { startUrl: normalizeLoginUrl(saved?.loginUrl || account.loginUrl || cfg.loginUrl), headless: !ARGV.headed, cfg },
        async (makeTransport, page, ctx) => {
          const bases = [...new Set([originOf(page.url()), saved?.baseUrl, cfg.baseUrl, ...(cfg.baseCandidates || [])].filter(Boolean))];
          const probes = [];
          for (const base of bases) {
            const tr = makeTransport(base);
            const r = await apiPost(tr, API.status, {});
            probes.push({ base, httpStatus: r.httpStatus, code: r.json?.code, authed: isAuthed(r) });
          }
          const cookies = (await ctx.cookies().catch(() => [])).map((c) => `${c.name}@${String(c.domain).replace(/^\./, '')}`);
          const ls = await evalRetry(page, () => Object.keys(window.localStorage)).catch(() => []);
          const tokens = (await findTokens(page)).length;
          return { account: account.name, start: originOf(page.url()), cookies, localStorageKeys: ls, jwtFound: tokens, probes };
        }
      );
      console.log(JSON.stringify(out, null, 2));
    }
    return 0;
  }

  if (CMD === 'checkin' || CMD === 'status' || CMD === 'stats') {
    /* 先识别哪些名字属于 TraeWork，避免 WorkBuddy 的账号查找对它们抛错 */
    const tcfgEarly = loadTraeConfig();
    let traeDisc = { accounts: [], errors: [] };
    if (tcfgEarly.enabled) {
      try { traeDisc = await discoverTraeAccounts(tcfgEarly); } catch {}
    }
    const isTraeName = (n) =>
      traeDisc.accounts.some((a) => a.name === n || slug(a.name) === slug(n) || a.userId === n);
    const wbNames = ARGV._.filter((n) => !isTraeName(n));
    const accounts = !ARGV._.length
      ? findAccounts(cfg, [])
      : wbNames.length
        ? findAccounts(cfg, wbNames)
        : [];

    if (!accounts.length && !traeDisc.accounts.length) {
      if (ARGV.json) console.log(JSON.stringify({ time: new Date().toISOString(), results: [] }, null, 2));
      else log('没有可用的账号。WorkBuddy 用 node checkin.mjs add 账号名；TraeWork 请先登录 TRAE CN 桌面客户端');
      return 0;
    }
    const statsOnly = CMD === 'stats' || CMD === 'status';

    /* 单实例锁：定时任务与看板上的「立即签到」按钮可能同时跑，
       两个进程各自 read-modify-write 同一份 state.json 会互相覆盖。
       端口被占 = 已有实例在跑 → 本次直接退出。锁归 OS 管，进程退出即释放。 */
    const lockPort = Number(cfg.checkinLockPort) || 47940;
    const lock = await acquireSingleInstanceLock(lockPort);
    if (!lock) {
      log(`⚠️ 已有签到任务正在运行（端口 ${lockPort} 被占用），本次跳过，避免并发写坏数据`);
      return 0;
    }

    const results = [];
    for (const account of accounts) {
      const r = await processAccount(account, cfg, { dryRun: !!ARGV.dryRun, statsOnly });
      /* 标记/清除登录失效状态，方便 list 和看板一眼看出哪个号要重登 */
      const st = readState(account.name);
      if (st) {
        const uid = st.uid || uidFromCookies(st.cookies);
        if (r.needsLogin) {
          writeState(account.name, { ...st, expiredAt: Date.now() });
          /* 把"是否被桌面客户端占用"同步到看板数据，一眼看出失败原因 */
          if (uid) upsertStats(account.name, { uid, desktopConflict: desktopHolders(uid).length > 0 });
        } else if (r.ok) {
          if (uid) upsertStats(account.name, { uid, desktopConflict: desktopHolders(uid).length > 0 });
          if (st.expiredAt) {
            const { expiredAt, ...rest } = st;
            writeState(account.name, rest);
          }
        }
      }
      results.push(r);
      if (!ARGV.json) {
        const icon = r.ok ? (r.already ? '➖' : '✅') : '❌';
        log(`${icon} ${r.name}：${r.text}${r.mode ? `（${r.mode}）` : ''}`);
      }
    }
    const gained = results.reduce((s, r) => s + (r.credit || 0), 0);
    const failed = results.filter((r) => !r.ok);
    const states = countStates(results);
    if (!statsOnly) {
      const db = readDb();
      db.runs = [...(db.runs || []).slice(-364), {
        at: new Date().toISOString(),
        total: results.length,
        ok: results.length - failed.length,
        gained,
        states,          // 结构化：各状态数量，供 `node checkin.mjs report` 统计
      }];
      writeDb(db);
    }

    /* —— TraeWork 站点：独立结算，异常绝不影响上面的 WorkBuddy 结果 —— */
    const traeOut = { label: tcfgEarly.label || 'TraeWork', results: [], skipped: '', error: '' };
    try {
      if (tcfgEarly.enabled) {
        const traeNames = ARGV._.filter(isTraeName);
        if (ARGV._.length && !traeNames.length) {
          traeOut.skipped = '本次只指定了 WorkBuddy 账号';
        } else if (!traeDisc.accounts.length) {
          traeOut.skipped = '未发现 TRAE 登录态（请打开并登录 TRAE CN 桌面客户端）';
        } else {
          const tr = await runTrae({ cmd: CMD, names: traeNames, dryRun: !!ARGV.dryRun });
          traeOut.results = tr.results || [];
          traeOut.skipped = tr.skipped || '';
        }
      }
    } catch (e) {
      traeOut.error = e?.message || String(e);
    }
    const traeFailed = traeOut.results.filter((r) => !r.ok);

    if (ARGV.json) {
      console.log(JSON.stringify({ time: new Date().toISOString(), results, traework: traeOut }, null, 2));
    } else {
      if (results.length) log(`—— WorkBuddy：${results.length - failed.length}/${results.length} 个账号成功，共领取 ${gained} 积分 ——`);
      if (traeOut.results.length) {
        log(`—— ${traeOut.label} ——`);
        for (const r of traeOut.results) log(`${r.ok ? (r.already ? '➖' : '✅') : '❌'} ${r.name}：${r.text}`);
      } else if (traeOut.skipped) {
        log(`（跳过 ${traeOut.label}：${traeOut.skipped}）`);
      } else if (traeOut.error) {
        log(`❌ ${traeOut.label} 处理异常：${traeOut.error}`);
      }
    }

    if (ARGV.notify) {
      const expired = [...failed, ...traeFailed].filter((f) => f.needsLogin).map((f) => f.name);
      const parts = [
        failed.length
          ? `${results.length - failed.length}/${results.length} 成功，+${gained} 积分；失败：${failed.map((f) => f.name).join('、')}`
          : `${results.length} 个账号完成，共 +${gained} 积分`,
      ];
      if (traeOut.results.length) {
        parts.push(`${traeOut.label} ${traeOut.results.length - traeFailed.length}/${traeOut.results.length} 成功`);
      }
      if (expired.length) parts.push(`账号 ${expired.join('、')} 登录已过期，请重新登录`);

      /* 多通道通知（macOS / 飞书 / 企微 / 钉钉 / 通用 webhook）。
         通道配置在 config.json 的 notify 段；任何通道失败都不影响签到结果。 */
      const ncfg = loadNotifyConfig(cfg);
      const nres = await notify(ncfg, {
        title: '自动签到',
        body: parts.join('；'),
        hasFailure: failed.length + traeFailed.length > 0,
      });
      for (const r of nres.results) {
        if (!r.ok) log(`   ⚠️ 通知通道 ${r.type} 发送失败：${r.error}`);
      }
    }
    return failed.length + traeFailed.length ? 1 : 0;
  }

  console.log(`未知命令：${CMD}\n执行 node checkin.mjs help 查看用法`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('❌ ' + (e?.message || e));
    process.exit(1);
  });
