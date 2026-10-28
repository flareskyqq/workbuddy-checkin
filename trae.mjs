#!/usr/bin/env node
/**
 * TraeWork CN 每日自动签到 + 积分采集（支持多账号）
 *
 *   node trae.mjs list                    账号列表 + 积分概览
 *   node trae.mjs add <名字>              新增网页账号（弹浏览器登录，只需一次）
 *   node trae.mjs login <名字>            重新登录（登录态失效时用）
 *   node trae.mjs del <名字>              删除网页账号及其登录态
 *   node trae.mjs checkin [账号名 ...]    批量签到（不带账号 = 全部）
 *   node trae.mjs status [账号名 ...]     只看状态，不领取
 *   node trae.mjs stats [账号名 ...]      只采集积分数据（不签到）
 *   node trae.mjs doctor                  排查登录态 / 接口连通性
 *
 * 参数：--dry-run  --json  --quiet
 *
 * ── 两种账号来源 ─────────────────────────────────────────────────────────
 * 1) 桌面客户端（自动发现，零配置）
 *    ~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json
 *      ├─ iCubeAuthInfo://icube.cloudide       → token / refreshToken / userId / host
 *      └─ iCubeAuthInfo://icube-dc:<machineId> → privateKeyPEM / publicKeyPEM
 *    两个键都是 AES-128-CBC 信封加密，密钥由密文前 32 字节经 SHA-512 派生，
 *    与硬件无关（macOS / Windows 同一套算法）。**只读，不修改任何文件。**
 *    注意：一个客户端同时只登录一个账号，所以这条路只能覆盖 1 个账号。
 *
 * 2) 网页登录（支持任意多个账号）
 *    `node trae.mjs add <名字>` 打开浏览器让你登录一次，随后只保存 Cookie：
 *      accounts/<名字>.trae.json  → cookies + userId + deviceId（权限 600）
 *    日常签到用 Cookie 调 GetUserToken 现换令牌，**不需要再开浏览器**。
 *
 * ── 鉴权链路（两种来源统一）───────────────────────────────────────────────
 *   POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken   (带 Cookie)
 *     → Result.Token
 *     → 后续请求头 Authorization: Cloud-IDE-JWT <Token>
 *   桌面来源的 token 直接从 storage.json 里解出来，省掉这一步。
 *
 * ── 重要限制 ─────────────────────────────────────────────────────────────
 * 桌面来源的 token 约 14 天过期，由桌面客户端自己续期。本模块【不主动续期】：
 * ExchangeToken 会轮换 refreshToken，抢先续期可能让桌面客户端被迫重新登录。
 * 因此到期时只提示用户打开一次 TRAE CN（客户端会自动刷新 storage.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/safe-io.mjs';
import { classifyCheckin, RETRYABLE_STATES, STATE_LABEL } from './lib/checkin-result.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const DATA_DIR = env('WBC_DATA_DIR', path.join(ROOT, 'data'));
const LOGS_DIR = env('WBC_LOGS_DIR', path.join(ROOT, 'logs'));
const ACCOUNTS_DIR = env('WBC_ACCOUNTS_DIR', path.join(ROOT, 'accounts'));
const PROFILES_DIR = env('WBC_PROFILES_DIR', path.join(ROOT, 'profiles'));
const CONFIG_PATH = env('WBC_CONFIG', path.join(ROOT, 'config.json'));
const TRAE_DB = path.join(DATA_DIR, 'trae.json');

const TRAE_HOST = 'https://api.trae.cn';
const TRAE_WEB = 'https://work.trae.cn/';
const TRAE_API = {
  checkLogin: '/cloudide/api/v3/trae/CheckLogin',
  userInfo: '/cloudide/api/v3/trae/GetUserInfo',
  userToken: '/cloudide/api/v3/common/GetUserToken',
  status: '/trae/api/v2/ug/checkin_credits/status',
  claim: '/trae/api/v2/ug/checkin_credits/claim',
  entitlement: '/trae/api/v2/pay/user_current_entitlement_list',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const CACHED_CHROMIUM = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/' +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

/** 桌面客户端登录态候选路径（按顺序探测） */
const DEFAULT_STORAGES = [
  ['TRAE SOLO CN', '~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json'],
  ['Trae CN', '~/Library/Application Support/Trae CN/User/globalStorage/storage.json'],
  ['TRAE SOLO', '~/Library/Application Support/TRAE SOLO/User/globalStorage/storage.json'],
  ['Trae', '~/Library/Application Support/Trae/User/globalStorage/storage.json'],
];

const slug = (n) =>
  String(n).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'account';
const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TRAE 的时间字段可能是 epoch 秒/毫秒，也可能是 ISO 字符串，统一成毫秒时间戳 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/* ============================================================ 解密（AES-128-CBC 信封） */

const HP = 16, AES128 = 16, WP = HP, RH = 64, RV = 32, VP = 64, EM = 6;
const K1 = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const K2 = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

const subtle = globalThis.crypto?.subtle;
const sha512 = async (d) => new Uint8Array(await subtle.digest('SHA-512', d));
const xor64 = () => { const r = new Uint8Array(VP); for (let i = 0; i < VP; i++) r[i] = K1[i] ^ K2[i]; return r; };

async function decryptEnvelope(b64) {
  if (!subtle) throw new Error('当前 Node 缺少 WebCrypto，请使用 Node 18+');
  const t = new Uint8Array(Buffer.from(String(b64), 'base64'));
  const seed = t.slice(EM, EM + RV);
  const sha = await sha512(seed);
  const comb = new Uint8Array(RH + VP);
  comb.set(sha, 0);
  comb.set(xor64(), RH);
  const hash = await sha512(comb);
  const aesKey = hash.slice(0, AES128);
  const iv = hash.slice(AES128, AES128 + WP);
  const ct = t.slice(RV + EM);
  const ck = await subtle.importKey('raw', aesKey, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, ck, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(RH)));
}

/* ============================================================ 配置 & 目录 */

export function loadTraeConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const t = cfg.traework || {};
  return {
    enabled: t.enabled !== false,
    label: t.label || 'TraeWork',
    storages: Array.isArray(t.storages) && t.storages.length ? t.storages : null,
    disabled: Array.isArray(t.disabled) ? t.disabled : [],
    browser: cfg.browser || 'edge',
  };
}

function ensureDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, ACCOUNTS_DIR, PROFILES_DIR]) fs.mkdirSync(d, { recursive: true });
}

/* ============================================================ 来源 1：桌面客户端 */

async function discoverDesktopAccounts(tcfg) {
  const accounts = [];
  const errors = [];
  const notices = [];
  const seen = new Set();
  const custom = !!tcfg.storages;
  /* 候选路径有三种写法：['app','路径'] 数组 / '路径' 字符串 / {app,path} 对象 */
  const candidates = (tcfg.storages || DEFAULT_STORAGES).map((s) => {
    if (Array.isArray(s)) return [s[0], s[1]];
    if (typeof s === 'string') return ['自定义', s];
    return [s?.app || '自定义', s?.path];
  });

  for (const [app, rawPath] of candidates) {
    const file = expandHome(rawPath);
    if (!fs.existsSync(file)) {
      if (custom) errors.push({ source: 'desktop', app, file, error: '登录态文件不存在' });
      continue;
    }
    let store;
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { errors.push({ source: 'desktop', app, file, error: '读取 storage.json 失败：' + e.message }); continue; }

    const blob = store['iCubeAuthInfo://icube.cloudide'];
    if (!blob) { errors.push({ source: 'desktop', app, file, error: '该客户端未登录（无 icube.cloudide）' }); continue; }

    let auth;
    try { auth = await decryptEnvelope(blob); }
    catch (e) { errors.push({ source: 'desktop', app, file, error: '登录态解密失败：' + e.message }); continue; }

    const userId = String(auth.userId || '');
    if (!userId || !auth.token) { errors.push({ source: 'desktop', app, file, error: '登录态缺少 token/userId' }); continue; }

    const region = auth.userRegion?.region || 'CN';
    const host = auth.host || TRAE_HOST;
    /* 只处理国内站。国际站（SG 等）走 *.trae.ai + v1 接口，且**没有每日签到活动**
       （2026-10-02 实测：8 个候选路径全部 404，权益接口只返回 Free plan / limit=0，
         连 usage_summary 都没有）。所以这里直接跳过并说明原因，不做无谓请求。 */
    if (!custom && region !== 'CN') {
      notices.push({
        source: 'desktop', app, region, host,
        username: auth.account?.username || userId,
        reason: '国际站无签到活动（实测 8 个候选路径均 404），已跳过',
      });
      continue;
    }

    if (seen.has(userId)) continue;   // 同一账号可能在多个客户端目录都有登录态
    seen.add(userId);

    let deviceKey = '';
    const appDir = path.dirname(path.dirname(path.dirname(file)));
    try { deviceKey = fs.readFileSync(path.join(appDir, 'machineid'), 'utf8').trim(); } catch {}
    if (!deviceKey) {
      for (const k of Object.keys(store)) {
        if (!k.startsWith('iCubeAuthInfo://icube-dc:')) continue;
        try { const dc = await decryptEnvelope(store[k]); if (dc.privateKeyPEM) deviceKey = k.split(':').pop(); } catch {}
        break;
      }
    }

    const username = auth.account?.username || auth.account?.email || userId;
    accounts.push({
      kind: 'desktop',
      app,
      storagePath: file,
      userId,
      username,
      name: username,
      token: auth.token,
      refreshToken: auth.refreshToken || '',
      host,
      region,
      expiredAt: toMs(auth.expiredAt),
      refreshExpiredAt: toMs(auth.refreshExpiredAt),
      /* 一账号一设备号：领取接口按 x-device-id 做「一设备一天一次」拦截，
         多账号共用同一 deviceId 会导致除第一个外全部被拒。 */
      deviceId: deviceKey ? `${deviceKey}-${userId}` : `trae-${userId}`,
    });
  }
  return { accounts, errors, notices };
}

/* ============================================================ 来源 2：网页登录 */

const webStatePath = (name) => path.join(ACCOUNTS_DIR, `${slug(name)}.trae.json`);

function loadWebAccounts() {
  const out = [];
  const errors = [];
  let files = [];
  try { files = fs.readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.trae.json')); }
  catch { return { accounts: out, errors }; }
  for (const f of files) {
    const file = path.join(ACCOUNTS_DIR, f);
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!d.name || !Array.isArray(d.cookies) || !d.cookies.length) {
        errors.push({ source: 'web', file, error: '账号文件不完整（缺 cookies）' });
        continue;
      }
      out.push({
        kind: 'web',
        app: '网页登录',
        statePath: file,
        name: d.name,
        userId: String(d.userId || ''),
        username: d.username || d.name,
        host: d.host || TRAE_HOST,
        region: d.region || 'CN',
        cookies: d.cookies,
        deviceId: d.deviceId || `web-${d.userId || slug(d.name)}`,
        savedAt: d.savedAt || '',
        expiredAt: 0,
      });
    } catch (e) {
      errors.push({ source: 'web', file, error: '解析失败：' + e.message });
    }
  }
  return { accounts: out, errors };
}

function saveWebAccount({ name, userId, username, cookies, host, region, deviceId }) {
  ensureDirs();
  const file = webStatePath(name);
  const prev = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  const data = {
    name,
    userId: String(userId || ''),
    username: username || name,
    host: host || TRAE_HOST,
    region: region || 'CN',
    /* 设备号一次生成后固定不变：稳定很重要，每天换设备号等于绕过每日限制 */
    deviceId: prev.deviceId || deviceId || `web-${userId || slug(name)}-${Math.random().toString(36).slice(2, 10)}`,
    savedAt: new Date().toISOString(),
    cookies,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

export function deleteWebAccount(name) {
  const file = webStatePath(name);
  const existed = fs.existsSync(file);
  try { if (existed) fs.unlinkSync(file); } catch {}
  const dir = path.join(PROFILES_DIR, 'trae-' + slug(name));
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return existed;
}

/* ============================================================ 合并发现 */

export async function discoverTraeAccounts(tcfg = loadTraeConfig()) {
  const desktop = await discoverDesktopAccounts(tcfg);
  const web = loadWebAccounts();
  const disabled = new Set(tcfg.disabled.map(String));
  const all = [...web.accounts, ...desktop.accounts].filter(
    (a) => !disabled.has(a.name) && !disabled.has(a.userId)
  );
  return { accounts: all, errors: [...web.errors, ...desktop.errors], notices: desktop.notices || [] };
}

/* ============================================================ HTTP & 鉴权 */

function cookieHeaderFor(cookies, host) {
  const nowSec = Date.now() / 1000;
  const bare = String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return (cookies || [])
    .filter((c) => c && c.name && (!c.expires || c.expires < 0 || c.expires > nowSec))
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      return !d || bare === d || bare.endsWith('.' + d) || d.endsWith(bare);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function rawPost(url, { headers = {}, body = '{}', tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { httpStatus: res.status, json, text };
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`请求 ${url} 失败：${lastErr?.message || lastErr}`);
}

/** 网页账号：用 Cookie 现换令牌（令牌约 1 小时有效，同一次运行内缓存） */
async function webToken(cred, force = false) {
  if (!force && cred._token && cred._tokenExp > Date.now()) return cred._token;
  const host = cred.host || TRAE_HOST;
  const r = await rawPost(`${host}${TRAE_API.userToken}`, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Cookie: cookieHeaderFor(cred.cookies, host) },
    body: '{}',
  });
  const tok = r.json?.Result?.Token;
  if (!tok) {
    const msg = r.json?.ResponseMetadata?.Error?.Message || `HTTP ${r.httpStatus}`;
    const err = new Error(`换取令牌失败：${msg}`);
    err.needsLogin = true;
    throw err;
  }
  cred._token = tok;
  cred._tokenExp = toMs(r.json?.Result?.ExpiredAt) || Date.now() + 30 * 60 * 1000;
  return tok;
}

/** 组装一次请求所需的头（网页账号需要先换令牌） */
async function authHeaders(cred) {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'x-device-id': cred.deviceId,
  };
  if (cred.region) h['X-User-Region'] = cred.region;
  h.Authorization = `Cloud-IDE-JWT ${cred.kind === 'web' ? await webToken(cred) : cred.token}`;
  return h;
}

async function traeFetch(cred, apiPath, { body = '{}', tries = 3 } = {}) {
  const host = cred.host || TRAE_HOST;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = await authHeaders(cred);
      const res = await fetch(`${host}${apiPath}`, { method: 'POST', headers, body });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { httpStatus: res.status, json, text };
    } catch (e) {
      if (e.needsLogin) throw e;          // 令牌换不出来，直接上抛
      lastErr = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`请求 ${apiPath} 失败：${lastErr?.message || lastErr}`);
}

const isAuthError = (r) =>
  r?.json?.code === 1001 || r?.httpStatus === 401 || /not able to authenticate|Token 无效/i.test(r?.text || '');

export const traeStatus = (cred) => traeFetch(cred, TRAE_API.status);
export const traeClaim = (cred) => traeFetch(cred, TRAE_API.claim);
export const traeEntitlement = (cred) => traeFetch(cred, TRAE_API.entitlement);
export const traeCheckLogin = (cred) => traeFetch(cred, TRAE_API.checkLogin);

/* ============================================================ 数据存取 */

export function readTraeDb() {
  let raw;
  try {
    raw = fs.readFileSync(TRAE_DB, 'utf8');
  } catch {
    return { updatedAt: null, accounts: {}, runs: [] };   // 文件还不存在，正常
  }
  try {
    const d = JSON.parse(raw);
    return { updatedAt: d.updatedAt || null, accounts: d.accounts || {}, runs: d.runs || [] };
  } catch {
    /* 文件存在但解析失败：先备份再重来，绝不静默覆盖（否则多账号的历史会一起丢） */
    const bak = `${TRAE_DB}.corrupt-${Date.now()}`;
    try { fs.renameSync(TRAE_DB, bak); } catch {}
    console.error(`⚠️ data/trae.json 解析失败，已备份到 ${path.basename(bak)} 并重新开始`);
    return { updatedAt: null, accounts: {}, runs: [] };
  }
}

function writeTraeDb(db) {
  ensureDirs();
  db.updatedAt = new Date().toISOString();
  /* 原子写：写临时文件再 rename，避免写到一半崩溃留下半截 JSON
     （此前 upsert 是 read-modify-write，一旦解析失败就会把其他账号的数据一起覆盖掉） */
  writeJsonAtomic(TRAE_DB, db);
}

function upsertTrae(account, patch) {
  const db = readTraeDb();
  const key = slug(account.name);
  const prev = db.accounts[key] || { name: account.name, history: [] };
  const merged = {
    ...prev,
    ...patch,
    name: prev.name || account.name,
    /* kind / source 始终跟着账号对象走，避免某条分支漏写导致来源被误判 */
    kind: account.kind || prev.kind || '',
    source: account.app || prev.source || '',
    updatedAt: new Date().toISOString(),
  };
  db.accounts[key] = merged;
  writeTraeDb(db);
  return merged;
}

const dayOf = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function pushHistory(account, entry) {
  const db = readTraeDb();
  const key = slug(account.name);
  const prev = db.accounts[key] || { name: account.name, history: [] };
  const history = (prev.history || []).filter((h) => h.date !== entry.date);
  history.push(entry);
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  db.accounts[key] = { ...prev, name: account.name, history };
  writeTraeDb(db);
}

/* ============================================================ 采集积分权益 */

function summarizeEntitlement(j) {
  if (!j || typeof j !== 'object') return null;
  const us = j.usage_summary || {};
  const packs = (j.user_entitlement_pack_list || [])
    .filter((p) => !p.is_hide)
    .map((p) => {
      const b = p.entitlement_base_info || {};
      const pe = b.product_extra?.package_extra;
      const endMs = toMs(p.expire_time || b.end_time);
      return {
        label: pe?.package_name || p.group_name || p.display_desc || '权益包',
        limit: b.quota?.credits_limit ?? pe?.quota?.credits_limit ?? 0,
        expireAt: endMs ? new Date(endMs).toISOString() : '',
        groupType: p.group_type,
      };
    });
  return {
    creditsTotal: Number(us.total_amount) || 0,
    consumed: Number(us.consumed_amount) || 0,
    consumptionRatio: Number(us.consumption_ratio) || 0,
    packs,
  };
}

/* ============================================================ 单账号流程 */

/**
 * 处理一个 TraeWork 账号。
 * 返回与 checkin.mjs 一致的结果结构：{ name, ok, already, credit, text, mode, needsLogin }
 */
export async function processTraeAccount(cred, { dryRun = false, statsOnly = false } = {}) {
  const base = { name: cred.name, mode: 'http', source: cred.app };
  const markLogin = (text) => {
    upsertTrae(cred, {
      userId: cred.userId, username: cred.username, source: cred.app,
      needsLogin: true, lastRunAt: new Date().toISOString(),
    });
    return { ...base, ok: false, needsLogin: true, text };
  };

  /* 桌面来源：token 已过期且本模块不做续期，提示用户打开客户端 */
  if (cred.kind === 'desktop' && cred.expiredAt && cred.expiredAt - Date.now() <= 0) {
    return markLogin('登录态已过期，请打开一次 TRAE CN 客户端后重试');
  }

  let st;
  try {
    st = await traeStatus(cred);
  } catch (e) {
    if (e.needsLogin) return markLogin(`登录态已失效，请执行 node trae.mjs login ${cred.name}`);
    return { ...base, ok: false, text: '请求异常：' + e.message, state: 'network' };
  }

  /* 统一分类：把「网关 HTML / 空响应 / 业务码」区分开，日志里能直接看出真因 */
  const stClass = classifyCheckin(st);
  if (stClass.state === 'auth') {
    return cred.kind === 'web'
      ? markLogin(`登录态已失效，请执行 node trae.mjs login ${cred.name}`)
      : markLogin('接口鉴权失败（登录态可能已失效），请打开一次 TRAE CN');
  }
  if (stClass.state !== 'ok') {
    return { ...base, ok: false, text: `状态查询失败：${stClass.message}`, state: stClass.state };
  }
  const s = st.json || {};
  if (!s.enable) {
    upsertTrae(cred, { userId: cred.userId, username: cred.username, source: cred.app, enabled: false });
    return { ...base, ok: false, text: '签到活动当前未开放', state: 'inactive' };
  }

  let credit = Number(s.credits) || 0;
  let already = !!s.checked_in;
  let text;

  if (already) {
    text = `今日已签到（本次所得 ${credit} 积分）`;
  } else if (statsOnly || dryRun) {
    text = dryRun ? '未签到（dry-run，仅查询）' : '今日未签到（仅采集模式，不领取）';
  } else {
    let c = await traeClaim(cred);
    let cClass = classifyCheckin(c);
    /* 网络抖动 / 网关拦截 / 限流：退避重试几次，别一次失败就记成「签到失败」 */
    for (let attempt = 1; attempt <= 3 && RETRYABLE_STATES.has(cClass.state); attempt += 1) {
      await sleep(1500 * attempt + Math.floor(Math.random() * 800));
      c = await traeClaim(cred);
      cClass = classifyCheckin(c);
    }
    const cj = c.json || {};
    if (cClass.state === 'ok') {
      credit = Number(cj.data?.credits ?? cj.credits ?? credit) || credit;
      already = false;
      text = `签到成功，+${credit} 积分`;
    } else if (cClass.state === 'already') {
      already = true;
      text = '今日已签到（其他端已领取）';
    } else if (cClass.state === 'auth') {
      return cred.kind === 'web'
        ? markLogin(`登录态已失效，请执行 node trae.mjs login ${cred.name}`)
        : markLogin('领取时鉴权失败，请打开一次 TRAE CN');
    } else {
      upsertTrae(cred, {
        userId: cred.userId, username: cred.username, source: cred.app,
        lastRunAt: new Date().toISOString(), lastCheckinOk: false,
      });
      return { ...base, ok: false, text: `领取失败（${STATE_LABEL[cClass.state] || cClass.state}）：${cClass.message}`, state: cClass.state };
    }
  }

  /* 采集积分权益（失败不影响签到结果） */
  let summary = null;
  try {
    const ent = await traeEntitlement(cred);
    if (ent.json && (ent.json.usage_summary || ent.json.user_entitlement_pack_list)) {
      summary = summarizeEntitlement(ent.json);
    }
  } catch {}

  const today = dayOf();
  upsertTrae(cred, {
    userId: cred.userId,
    username: cred.username,
    source: cred.app,
    kind: cred.kind,
    todayCheckedIn: already || !statsOnly,
    todayCredits: credit,
    extraCredits: Number(s.extra_credits) || 0,
    creditsTotal: summary?.creditsTotal ?? undefined,
    consumed: summary?.consumed ?? undefined,
    packs: summary?.packs ?? undefined,
    tokenExpiredAt: cred.kind === 'desktop' && cred.expiredAt ? new Date(cred.expiredAt).toISOString() : '',
    lastRunAt: new Date().toISOString(),
    lastCheckinOk: true,
    needsLogin: false,
  });
  pushHistory(cred, { date: today, at: new Date().toISOString(), credits: credit, checkedIn: already || !statsOnly });

  /* 桌面来源 token 临近过期时提前提醒 */
  let warn = '';
  if (cred.kind === 'desktop' && cred.expiredAt) {
    const daysLeft = Math.floor((cred.expiredAt - Date.now()) / 86400000);
    if (daysLeft <= 3) warn = `｜⚠️ 登录态约 ${Math.max(daysLeft, 0)} 天后过期，请打开一次 TRAE CN 客户端`;
  }
  return { ...base, ok: true, already, credit: already ? 0 : credit, text: text + warn };
}

/* ============================================================ 浏览器登录 */

function launchOpts(headless, cfgBrowser) {
  const opts = {
    headless,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-infobars'],
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--enable-automation'],
  };
  const want = process.env.WBC_BROWSER || cfgBrowser || 'auto';
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const hasChrome = isMac
    ? fs.existsSync('/Applications/Google Chrome.app')
    : fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ||
      fs.existsSync('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  const hasEdge = isMac
    ? fs.existsSync('/Applications/Microsoft Edge.app')
    : fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ||
      fs.existsSync('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
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

const TRACKER_HOSTS = ['doubleclick.net', 'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com', 'hm.baidu.com'];

async function blockTrackers(ctx) {
  if (process.env.WBC_ALLOW_TRACKERS === '1') return;
  for (const host of TRACKER_HOSTS) {
    await ctx.route(`**://*.${host}/**`, (r) => r.abort()).catch(() => {});
  }
}

/**
 * 打开浏览器让用户登录一次，成功后保存 Cookie。
 * 通过轮询 CheckLogin 的 Result.IsLogin 判断登录是否完成。
 */
export async function addWebAccount(name, { tcfg = loadTraeConfig(), onLog = () => {}, timeoutMs = 300000, pollMs = 2000 } = {}) {
  ensureDirs();
  const { chromium } = await import('playwright-core');
  const dir = path.join(PROFILES_DIR, 'trae-' + slug(name));
  fs.mkdirSync(dir, { recursive: true });

  onLog(`🌐 正在打开浏览器，请在窗口里登录 TraeWork（账号备注名：${name}）…`);
  const ctx = await chromium.launchPersistentContext(dir, {
    ...launchOpts(false, tcfg.browser),
    viewport: { width: 1180, height: 820 },
    locale: 'zh-CN',
    userAgent: UA,
  });
  await blockTrackers(ctx);

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(TRAE_WEB, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    onLog('   没看到登录入口就点右上角「登录」。登录成功后窗口会自动关闭。');

    const deadline = Date.now() + timeoutMs;
    let lastHint = 0;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const info = await page.evaluate(async () => {
        try {
          const r = await fetch('https://api.trae.cn/cloudide/api/v3/trae/CheckLogin', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          return await r.json();
        } catch { return null; }
      }).catch(() => null);

      const res = info?.Result;
      if (res?.IsLogin) {
        let username = '';
        try {
          const u = await page.evaluate(async () => {
            const r = await fetch('https://api.trae.cn/cloudide/api/v3/trae/GetUserInfo', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            return await r.json();
          });
          username = u?.Result?.NickName || u?.Result?.UserName || u?.Result?.Name || '';
        } catch {}

        const cookies = await ctx.cookies();
        const file = saveWebAccount({
          name,
          userId: res.UserID,
          username,
          cookies,
          host: res.Host || TRAE_HOST,
          region: res.Region || 'CN',
        });
        onLog(`✅ 登录成功：${name}（用户ID ${res.UserID}）`);
        onLog(`   登录态已保存到 ${path.relative(ROOT, file)}（权限 600，含 Cookie，勿外传）`);
        return { ok: true, userId: res.UserID, username, cookieCount: cookies.length, file };
      }
      if (Date.now() - lastHint > 30000) {
        lastHint = Date.now();
        onLog(`   …仍在等待登录（最多 ${Math.round(timeoutMs / 60000)} 分钟）`);
      }
    }
    return { ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）。可重新执行 node trae.mjs add ${name}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ============================================================ 对外主入口 */

export async function runTrae({ cmd = 'checkin', names = [], dryRun = false, onLog = () => {} } = {}) {
  const tcfg = loadTraeConfig();
  if (!tcfg.enabled) return { results: [], errors: [], skipped: 'traework 已在 config.json 中停用' };

  const { accounts, errors, notices = [] } = await discoverTraeAccounts(tcfg);
  if (!accounts.length) {
    return { results: [], errors, notices, skipped: '未找到可用的 TraeWork 登录态（可执行 node trae.mjs add <名字> 添加）' };
  }

  let picked = accounts;
  if (names.length) {
    picked = [];
    for (const n of names) {
      const hit = accounts.find((a) => a.name === n || slug(a.name) === slug(n) || a.userId === n);
      if (!hit) throw new Error(`TraeWork 里找不到账号：${n}`);
      picked.push(hit);
    }
  }

  const statsOnly = cmd === 'stats' || cmd === 'status';
  const results = [];
  for (const cred of picked) {
    let r;
    try {
      r = await processTraeAccount(cred, { dryRun, statsOnly });
    } catch (e) {
      r = { name: cred.name, ok: false, text: `异常：${e.message}`, mode: 'http', needsLogin: !!e.needsLogin };
    }
    results.push(r);
    onLog(`${r.ok ? (r.already ? '➖' : '✅') : '❌'} ${r.name}：${r.text}`);
  }

  if (!statsOnly) {
    const db = readTraeDb();
    const gained = results.reduce((s, r) => s + (r.credit || 0), 0);
    const failed = results.filter((r) => !r.ok);
    db.runs = [...(db.runs || []).slice(-364), {
      at: new Date().toISOString(), total: results.length,
      ok: results.length - failed.length, gained,
    }];
    writeTraeDb(db);
  }

  return { results, errors, notices };
}

/* ============================================================ CLI */

async function cli() {
  const raw = process.argv.slice(2);
  const opt = { _: [], json: false, dryRun: false, quiet: false };
  for (const a of raw) {
    if (a === '--json') opt.json = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--quiet') opt.quiet = true;
    else opt._.push(a);
  }
  const cmd = opt._.shift() || 'help';
  const names = opt._;
  const tcfg = loadTraeConfig();
  const say = (m) => { if (!opt.json && !opt.quiet) console.log(m); };

  if (['help', '--help', '-h'].includes(cmd)) {
    console.log([
      'TraeWork CN 每日自动签到 + 积分采集（支持多账号）',
      '',
      '  node trae.mjs list                  账号列表 + 积分概览',
      '  node trae.mjs add <名字>            新增网页账号（弹浏览器登录，只需一次）',
      '  node trae.mjs login <名字>          重新登录',
      '  node trae.mjs del <名字>            删除网页账号',
      '  node trae.mjs checkin [账号名..]    批量签到（不带账号 = 全部）',
      '  node trae.mjs status [账号名..]     只看状态，不领取',
      '  node trae.mjs stats [账号名..]      只采集积分数据（不签到）',
      '  node trae.mjs doctor                排查登录态 / 接口',
      '',
      '账号来源：① TRAE 桌面客户端的登录态（自动发现，只能覆盖 1 个账号）',
      '         ② 网页登录（用 add 添加，可加任意多个）',
      '',
      '可选：--dry-run --json --quiet',
    ].join('\n'));
    return 0;
  }

  if (cmd === 'add' || cmd === 'login') {
    const name = names[0];
    if (!name) { console.error('请提供账号备注名，例如：node trae.mjs add 小号1'); return 2; }
    const r = await addWebAccount(name, { tcfg, onLog: say });
    if (!r.ok) { console.error('❌ ' + r.error); return 1; }
    if (opt.json) console.log(JSON.stringify(r, null, 2));
    say(`\n下一步：node trae.mjs status ${name}  验证签到状态`);
    return 0;
  }

  if (cmd === 'del' || cmd === 'delete' || cmd === 'rm') {
    const name = names[0];
    if (!name) { console.error('请提供要删除的账号名'); return 2; }
    const ok = deleteWebAccount(name);
    console.log(ok ? `🗑️ 已删除网页账号：${name}` : `没找到网页账号：${name}（桌面来源的账号不在这里删）`);
    return ok ? 0 : 1;
  }

  if (cmd === 'doctor') {
    const { accounts, errors, notices = [] } = await discoverTraeAccounts(tcfg);
    const out = { enabled: tcfg.enabled, accounts: [], errors, notices };
    for (const a of accounts) {
      const probe = { name: a.name, userId: a.userId, source: a.app, kind: a.kind, region: a.region };
      try {
        const st = await traeStatus(a);
        probe.status = st.json;
        probe.authed = !isAuthError(st);
      } catch (e) { probe.statusError = e.message; probe.needsLogin = !!e.needsLogin; }
      out.accounts.push(probe);
    }
    console.log(JSON.stringify(out, null, 2));
    return out.accounts.every((a) => a.authed) ? 0 : 1;
  }

  if (cmd === 'list') {
    const { accounts, errors, notices = [] } = await discoverTraeAccounts(tcfg);
    for (const n of notices) {
      say(`（已跳过 ${n.app} 的「${n.username}」：${n.reason}，区域 ${n.region}）`);
    }
    if (!accounts.length) {
      say('没有可用的 TraeWork 账号。');
      for (const e of errors) say(`  · ${e.app || e.source}: ${e.error}`);
      say('添加方式：node trae.mjs add <备注名>（网页登录）');
      return 0;
    }
    const db = readTraeDb();
    for (const a of accounts) {
      const s = db.accounts[slug(a.name)] || {};
      let tag;
      if (a.kind === 'desktop' && a.expiredAt) {
        const leftD = Math.floor((a.expiredAt - Date.now()) / 86400000);
        tag = leftD <= 0 ? '🔴 登录态已过期' : leftD <= 3 ? `🟡 登录态 ${leftD} 天后过期` : `🟢 已登录（${leftD} 天后过期）`;
      } else {
        tag = s.needsLogin ? '🔴 登录态已失效（需重新登录）' : '🟢 已登录';
      }
      const bal = s.creditsTotal !== undefined ? `｜总积分 ${s.creditsTotal}` : '';
      const today = s.todayCheckedIn ? `｜今日已签 +${s.todayCredits ?? 0}` : '｜今日未签';
      console.log(`${a.name}  ${tag}${bal}${today}  ［${a.app}］`);
    }
    return 0;
  }

  if (['checkin', 'status', 'stats'].includes(cmd)) {
    const { results, errors, notices = [], skipped } = await runTrae({ cmd, names, dryRun: opt.dryRun, onLog: say });
    if (skipped) {
      if (opt.json) console.log(JSON.stringify({ time: new Date().toISOString(), skipped, results: [] }, null, 2));
      else say(`（跳过 TraeWork：${skipped}）`);
      for (const n of notices) say(`  · ${n.app}「${n.username}」：${n.reason}`);
      return 0;
    }
    if (opt.json) console.log(JSON.stringify({ time: new Date().toISOString(), results, errors, notices }, null, 2));
    else {
      const gained = results.reduce((s, r) => s + (r.credit || 0), 0);
      const failed = results.filter((r) => !r.ok);
      say(`—— TraeWork 完成：${results.length - failed.length}/${results.length} 个账号成功，共领取 ${gained} 积分 ——`);
      for (const e of errors) say(`  · 跳过 ${e.app || e.source}：${e.error}`);
      for (const n of notices) say(`  · 跳过 ${n.app}「${n.username}」：${n.reason}`);
    }
    return results.some((r) => !r.ok) ? 1 : 0;
  }

  console.log(`未知命令：${cmd}\n执行 node trae.mjs help 查看用法`);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  cli()
    .then((c) => process.exit(c))
    .catch((e) => { console.error('❌ ' + (e?.message || e)); process.exit(1); });
}
