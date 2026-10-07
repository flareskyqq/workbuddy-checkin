#!/usr/bin/env node
/**
 * WorkBuddy 积分看板（本地网站）
 *   node dashboard.mjs            启动并自动打开浏览器
 *   node dashboard.mjs --port 9000
 *   node dashboard.mjs --no-open
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = process.env.WBC_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRAE_FILE = path.join(DATA_DIR, 'trae.json');
const LOGS_DIR = process.env.WBC_LOGS_DIR || path.join(ROOT, 'logs');
const HTML_FILE = path.join(ROOT, 'dashboard.html');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(process.env.WBC_PORT || getArg('--port', 8787));
const NO_OPEN = args.includes('--no-open');

const jobs = new Map();
let jobSeq = 0;
const CONFIG_FILE = process.env.WBC_CONFIG || path.join(ROOT, 'config.json');
const ACCOUNTS_DIR = process.env.WBC_ACCOUNTS_DIR || path.join(ROOT, 'accounts');
const PROFILES_DIR = process.env.WBC_PROFILES_DIR || path.join(ROOT, 'profiles');
const slugOf = (n) => String(n).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'account';
const SITE_CN = 'https://www.workbuddy.cn';
const SITE_INTL = 'https://www.workbuddy.ai';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

function spawnJob(script, args, label) {
  const id = String(++jobSeq);
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: process.env,
  });
  const job = { id, cmd: label || args.join(' '), startedAt: new Date().toISOString(), output: '', done: false, code: null };
  jobs.set(id, job);
  const push = (buf) => {
    job.output += buf.toString();
    if (job.output.length > 40000) job.output = job.output.slice(-40000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    job.done = true;
    job.code = code;
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

const runJob = (args, label) => spawnJob('checkin.mjs', args, label);
/* TraeWork 独立脚本（add/login 会弹浏览器登录一次） */
const runTraeJob = (args, label) => spawnJob('trae.mjs', args, label);

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const ACCESS_LOG = path.join(LOGS_DIR, 'dashboard-access.log');
function access(req) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(
      ACCESS_LOG,
      `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${req.socket.remoteAddress || '-'} ${req.method} ${req.url} ${req.headers['user-agent'] || ''}\n`
    );
  } catch {}
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  access(req);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('缺少 dashboard.html');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (url.pathname === '/api/data') {
    let db = { updatedAt: null, accounts: {}, runs: [] };
    try {
      db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
    let recentLog = '';
    try {
      const files = fs.readdirSync(LOGS_DIR).filter((f) => f.startsWith('checkin-')).sort();
      if (files.length) {
        recentLog = fs.readFileSync(path.join(LOGS_DIR, files[files.length - 1]), 'utf8').split('\n').slice(-12).join('\n');
      }
    } catch {}
    const cfg = readConfig();
    const configAccounts = (cfg.accounts || []).map((a) => ({
      name: a.name,
      loginUrl: a.loginUrl || cfg.loginUrl || SITE_CN,
      enabled: a.enabled !== false,
    }));
    const rate = Number(cfg.creditToYuan) > 0 ? Number(cfg.creditToYuan) : 0.02;
    /* TraeWork 站点数据（由 trae.mjs 采集，独立文件、独立积分口径） */
    let traework = { updatedAt: null, accounts: {}, runs: [], label: 'TraeWork' };
    try {
      traework = { ...traework, ...JSON.parse(fs.readFileSync(TRAE_FILE, 'utf8')) };
    } catch {}
    traework.label = (cfg.traework && cfg.traework.label) || 'TraeWork';
    traework.enabled = !cfg.traework || cfg.traework.enabled !== false;
    json(res, 200, { ...db, configAccounts, rate, recentLog, traework, server: { now: new Date().toISOString(), port: PORT } });
    return;
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    const cmd = url.searchParams.get('cmd') === 'checkin' ? 'checkin' : 'stats';
    const names = (url.searchParams.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const job = runJob([cmd, ...names]);
    json(res, 200, { id: job.id, cmd: job.cmd });
    return;
  }

  /* 添加 / 重新登录账号：会弹出一个浏览器窗口让用户登录 */
  if (url.pathname === '/api/account/add' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    const site = url.searchParams.get('site') === 'intl' ? SITE_INTL : SITE_CN;
    if (!name) return json(res, 400, { error: '请填写账号备注名' });
    if (name.length > 40) return json(res, 400, { error: '账号名请控制在 40 字以内' });
    const cfg = readConfig();
    cfg.accounts = cfg.accounts || [];
    const exist = cfg.accounts.find((a) => a.name === name);
    if (!exist) cfg.accounts.push({ name, loginUrl: site + '/login/' });   // 首页太重，直接给登录页
    else exist.loginUrl = site + '/login/';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    const useWindow = url.searchParams.get('window') === '1';
    const args = ['login', name, '--site', site === SITE_INTL ? 'intl' : 'cn'];
    if (!useWindow) args.push('--qr');        // 默认扫码：二维码显示在网页里，不弹浏览器
    const job = runJob(args, `login ${name}${useWindow ? ' (窗口模式)' : ''}`);
    json(res, 200, { id: job.id, name, isNew: !exist, cmd: job.cmd });
    return;
  }

  /* 删除账号：调用 checkin.mjs del <name> 清理配置、状态与缓存 */
  /* 扫码登录：把二维码图片发给看板页面显示（无窗口登录，避免浏览器卡顿） */
  if (url.pathname.startsWith('/api/qr/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/qr/'.length));
    const f = path.join(DATA_DIR, `qr-${slugOf(name)}.png`);
    if (!fs.existsSync(f)) return json(res, 404, { error: '二维码还没准备好' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }

  /* 修改账号备注名（会同时迁移登录态、浏览器缓存和统计数据） */
  if (url.pathname === '/api/account/rename' && req.method === 'POST') {
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    if (!from || !to) return json(res, 400, { error: '账号名不能为空' });
    if (to.length > 40) return json(res, 400, { error: '名字请控制在 40 字以内' });
    const cfg = readConfig();
    cfg.accounts = cfg.accounts || [];
    const acct = cfg.accounts.find((a) => a.name === from);
    if (!acct) return json(res, 404, { error: '找不到账号：' + from });
    if (cfg.accounts.some((a) => a.name === to)) return json(res, 400, { error: '已经有叫「' + to + '」的账号了' });
    acct.name = to;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');

    const fromSlug = slugOf(from);
    const toSlug = slugOf(to);
    const moved = [];
    for (const [src, dst] of [
      [path.join(ACCOUNTS_DIR, fromSlug + '.state.json'), path.join(ACCOUNTS_DIR, toSlug + '.state.json')],
      [path.join(PROFILES_DIR, fromSlug), path.join(PROFILES_DIR, toSlug)],
    ]) {
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.renameSync(src, dst);
          moved.push(path.basename(dst));
        }
      } catch (e) {
        moved.push('迁移失败:' + path.basename(src));
      }
    }
    try {
      const db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (db.accounts && db.accounts[fromSlug]) {
        db.accounts[toSlug] = { ...db.accounts[fromSlug], name: to };
        delete db.accounts[fromSlug];
        fs.writeFileSync(STATE_FILE, JSON.stringify(db, null, 2) + '\n');
        moved.push('统计数据');
      }
    } catch {}
    json(res, 200, { ok: true, from, to, moved });
    return;
  }

  if (url.pathname === '/api/account/delete' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json(res, 400, { error: '请指定要删除的账号名' });
    const job = runJob(['del', name], `del ${name}`);
    json(res, 200, { id: job.id, name, cmd: job.cmd });
    return;
  }

  /* TraeWork 网页账号：新增 / 重新登录（会弹浏览器让用户登录一次） */
  if (url.pathname === '/api/traework/add' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json(res, 400, { error: '请填写账号备注名' });
    if (name.length > 40) return json(res, 400, { error: '账号名请控制在 40 字以内' });
    const job = runTraeJob(['add', name], `trae add ${name}`);
    json(res, 200, { id: job.id, name, cmd: job.cmd });
    return;
  }

  /* 删除 TraeWork 网页账号（桌面来源的账号不受影响） */
  if (url.pathname === '/api/traework/delete' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json(res, 400, { error: '请指定要删除的账号名' });
    const job = runTraeJob(['del', name], `trae del ${name}`);
    json(res, 200, { id: job.id, name, cmd: job.cmd });
    return;
  }

  if (url.pathname.startsWith('/api/job/')) {
    const job = jobs.get(url.pathname.split('/').pop());
    if (!job) return json(res, 404, { error: 'not found' });
    return json(res, 200, job);
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`📊 积分看板已启动：${url}`);
  console.log('   按 Ctrl+C 关闭。数据来自 data/state.json（WorkBuddy）与 data/trae.json（TraeWork）。');
  if (!NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [url], () => {});
  }
});
