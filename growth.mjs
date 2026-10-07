#!/usr/bin/env node
/**
 * WorkBuddy 成长中心（Buddy 任务 / 旅行 / 补签 / 兑换）模块
 *
 *   node growth.mjs list [账号名]     只读：任务清单 + Buddy 旅行状态 + 断登情况
 *   node growth.mjs guide [账号名]    待办清单：还差什么、点哪去、值多少积分
 *   node growth.mjs accept [账号名]   报名所有未报名任务（让进度开始计）
 *   node growth.mjs claim [账号名]    领取「进度已达标」任务的奖励
 *   node growth.mjs buddy [账号名]    Buddy 旅行：空闲就派出，已到达就领取
 *   node growth.mjs makeup [账号名]   用补签卡补断登（每轮最多补 1 天）
 *   node growth.mjs run [账号名]      accept + claim + buddy（日常用的就是这个）
 *
 * 参数：--dry-run（只预览不执行） --json
 *
 * ── 这个模块【刻意不做】的事 ───────────────────────────────────────────────
 * 不伪造任何「行为事件」去刷任务进度。
 *
 * 成长中心的进度由服务端依据真实行为点亮（chat_request_send、真实对话、装技能等）。
 * 网上有项目（如 workbuddy2api-panel 的 scripts/task_chat5.py）直接构造
 * {"eventCode":"chat_request_send",...} 上报，谎报用户聊过天来骗任务奖励 ——
 * 那是伪造数据骗平台积分，本模块不实现，也不建议任何人用。
 *
 * 本模块只做两件正当的事：
 *   1) 报名（accept）—— 部分任务的进度「从报名后才开始计」，提前报名能让用户正常使用时自然积累进度
 *   2) 领奖（claim）—— 只领**进度已达标**的任务，也就是用户确实已经完成的那些
 * 外加 Buddy 旅行、补签、兑换这类纯游戏/补偿机制，都是站内正当功能。
 *
 * ── 接口（2026-10-02 用真实账号实测）─────────────────────────────────────────
 *   GET  /v2/activity/growth/tasks                任务列表（含 progress / accept_status）
 *   POST /v2/activity/growth/tasks/accept         {"task_codes":[...]}
 *   POST /activity/growth/tasks/<task_code>/claim 领奖（task_code 在路径里，无 body）
 *   GET  /activity/growth/buddy/travel/status     旅行状态
 *   POST /activity/growth/buddy/travel/depart     派出
 *   POST /activity/growth/buddy/travel/claim      领取旅行奖励
 *   GET  /activity/growth/heatmap                 活跃日历（判断断登）
 *   POST /activity/growth/makeup-cards/use        {"target_date":"YYYY-MM-DD"}
 * 鉴权：只用保存的 Cookie（不需要 Bearer），需带 x-client-platform: web。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const ACCOUNTS_DIR = env('WBC_ACCOUNTS_DIR', path.join(ROOT, 'accounts'));
const CONFIG_PATH = env('WBC_CONFIG', path.join(ROOT, 'config.json'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const slug = (n) =>
  String(n).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'account';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function accountNames() {
  const cfg = loadConfig();
  return (cfg.accounts || []).filter((a) => a.enabled !== false).map((a) => a.name);
}

function readState(name) {
  const file = path.join(ACCOUNTS_DIR, `${slug(name)}.state.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 构造一次 growth 请求所需的头（只用 Cookie，无需 Bearer） */
function headersFor(st) {
  const base = String(st.baseUrl || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': UA,
    Origin: base,
    Referer: base + '/profile/growth-center',
    'x-client-platform': 'web',
    Cookie: (st.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '),
  };
}

async function call(st, method, p, body) {
  const base = String(st.baseUrl || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  try {
    const r = await fetch(base + p, {
      method,
      headers: headersFor(st),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { http: r.status, json, text: text.slice(0, 400) };
  } catch (e) {
    return { http: 0, json: null, text: String(e?.message || e) };
  }
}

/**
 * 实测确认的路径（2026-10-02 真实账号）。注意两处与网上流传版本不同：
 *   · accept 是 /activity/growth/tasks/accept —— 不带 /v2 前缀（带 /v2 会 401）
 *   · depart 必须带 {"location_id":N}，只传 {} 会 400 invalid request
 *     地点列表来自 /activity/growth/buddy/travel/config
 */
const PATHS = {
  tasks: '/v2/activity/growth/tasks',
  accept: '/activity/growth/tasks/accept',
  claim: (code) => `/activity/growth/tasks/${encodeURIComponent(code)}/claim`,
  travelStatus: '/activity/growth/buddy/travel/status',
  travelConfig: '/activity/growth/buddy/travel/config',
  travelDepart: '/activity/growth/buddy/travel/depart',
  travelClaim: '/activity/growth/buddy/travel/claim',
};

const OK = (r) => r?.http === 200 && r?.json?.code === 0;

/** 取服务端错误信息。该接口的错误字段是 msg（不是 message），两个都试。 */
const errOf = (r) =>
  r?.json?.message || r?.json?.msg || (r?.json?.code !== undefined ? `业务码 ${r.json.code}` : `HTTP ${r?.http ?? 0}`);

/* ---------------------------------------------------------------- 只读查询 */

export async function listTasks(st) {
  const r = await call(st, 'GET', PATHS.tasks);
  if (!OK(r)) return { ok: false, error: errOf(r), tasks: [] };
  return { ok: true, tasks: r.json.data?.tasks || [] };
}

export async function travelStatus(st) {
  const r = await call(st, 'GET', PATHS.travelStatus);
  if (!OK(r)) return { ok: false, error: errOf(r) };
  const d = r.json.data || {};
  return { ok: true, state: d.state, arriveAt: d.arrive_at, rewardCredit: d.reward_credit || 0, dailyLimit: !!d.daily_limit_reached, raw: d };
}

/* ---------------------------------------------------------------- 写操作 */

/** 报名任务（幂等）。只有 not_accepted 的才报名。 */
export async function acceptTasks(st, codes) {
  if (!codes.length) return { ok: true, accepted: [], skipped: '没有未报名的任务' };
  const r = await call(st, 'POST', PATHS.accept, { task_codes: codes });
  if (!OK(r)) return { ok: false, error: errOf(r) };
  const results = r.json.data?.results || [];
  const okCodes = results.filter((x) => x.status === 'accepted').map((x) => x.task_code);
  return { ok: true, accepted: okCodes.length ? okCodes : codes };
}

/**
 * 领取任务奖励。只领「进度已达标且未领取」的 —— 也就是用户确实做完的那些。
 * 绝不会为了领奖去伪造任何进度。
 */
export async function claimTask(st, code) {
  const r = await call(st, 'POST', PATHS.claim(code));
  if (!OK(r)) return { ok: false, error: errOf(r) };
  const d = r.json.data || {};
  return { ok: true, credit: d.credit || 0, energy: d.energy || 0, already: !!d.already_claimed };
}

/** 旅行地点列表（depart 需要 location_id） */
export async function travelConfig(st) {
  const r = await call(st, 'GET', PATHS.travelConfig);
  if (!OK(r)) return { ok: false, error: errOf(r), locations: [] };
  return { ok: true, locations: r.json.data?.locations || [] };
}

/** Buddy 旅行：空闲就派出。默认选第一个可用地点。 */
export async function travelDepart(st, { locationId } = {}) {
  let lid = locationId;
  if (lid === undefined) {
    const cfg = await travelConfig(st);
    if (!cfg.ok || !cfg.locations.length) return { ok: false, error: `拿不到旅行地点：${cfg.error || '列表为空'}` };
    lid = cfg.locations[0].id;
  }
  const r = await call(st, 'POST', PATHS.travelDepart, { location_id: lid });
  if (!OK(r)) return { ok: false, error: errOf(r) };
  const d = r.json.data || {};
  return { ok: true, location: d.location?.name || '', hours: d.location?.duration_hours || 0, raw: d };
}

/** Buddy 旅行：已到达就领取 */
export async function travelClaim(st) {
  const r = await call(st, 'POST', PATHS.travelClaim, {});
  if (!OK(r)) return { ok: false, error: errOf(r) };
  const d = r.json.data || {};
  return { ok: true, credit: d.credit || d.reward_credit || 0, raw: d };
}

/* ---------------------------------------------------------------- 单账号流程 */

/** 只读总览 */
export async function inspect(name, st) {
  const out = { name, tasks: [], claimable: [], notAccepted: [], travel: null, error: null };
  const t = await listTasks(st);
  if (!t.ok) { out.error = t.error; return out; }
  out.tasks = t.tasks.map((x) => ({
    code: x.task_code, title: x.title || x.task_code, desc: x.task_desc || '',
    credit: x.reward_credit || 0, energy: x.reward_energy || 0,
    current: x.progress?.current ?? 0, target: x.progress?.target ?? 0,
    status: x.accept_status || '', claimed: x.accept_status === 'claimed',
    jump: x.jump_url || '',          // 客户端 deep link，点一下直达
  }));
  out.claimable = out.tasks.filter((x) => !x.claimed && x.target > 0 && x.current >= x.target);
  out.notAccepted = out.tasks.filter((x) => x.status === 'not_accepted');
  out.travel = await travelStatus(st);
  return out;
}

/** 执行：报名 → 领奖 → Buddy 旅行 */
export async function runAccount(name, st, { dryRun = false, onLog = () => {} } = {}) {
  const res = { name, accepted: 0, claimed: [], credits: 0, energy: 0, travel: null, errors: [] };

  const t = await listTasks(st);
  if (!t.ok) {
    res.errors.push(`任务列表读取失败：${t.error}`);
    return res;
  }

  /* 1) 报名未报名的任务 —— 部分任务进度从报名后才开始计 */
  const pending = (t.tasks || []).filter((x) => x.accept_status === 'not_accepted').map((x) => x.task_code);
  if (pending.length) {
    if (dryRun) {
      onLog(`   [dry-run] 将报名 ${pending.length} 个任务：${pending.join('、')}`);
    } else {
      const a = await acceptTasks(st, pending);
      /* 幂等：已报名的会重复提交，所以这里说的是「提交处理」而非「新增报名」 */
      if (a.ok) { res.accepted = a.accepted.length || pending.length; onLog(`   ✔ 已提交报名 ${pending.length} 个任务`); }
      else res.errors.push(`报名失败：${a.error}`);
      await sleep(800);
    }
  }

  /* 2) 领取已达标任务的奖励（只领真正做完的） */
  const done = (t.tasks || []).filter(
    (x) => x.accept_status !== 'claimed' &&
           (x.progress?.target ?? 0) > 0 &&
           (x.progress?.current ?? 0) >= (x.progress?.target ?? 0)
  );
  for (const x of done) {
    if (dryRun) {
      onLog(`   [dry-run] 可领奖：${x.title || x.task_code}（${x.reward_credit || 0} 积分）`);
      continue;
    }
    const c = await claimTask(st, x.task_code);
    if (c.ok) {
      res.claimed.push({ code: x.task_code, credit: c.credit, energy: c.energy });
      res.credits += c.credit;
      res.energy += c.energy;
      onLog(`   🎁 已领取「${x.title || x.task_code}」+${c.credit} 积分${c.energy ? ` +${c.energy} 能量` : ''}`);
    } else {
      res.errors.push(`领奖失败 ${x.task_code}：${c.error}`);
    }
    await sleep(800);
  }
  if (!done.length && !dryRun) onLog('   · 没有进度已达标待领的任务');

  /* 3) Buddy 旅行：空闲就派出，已到达就领取 */
  const tv = await travelStatus(st);
  res.travel = tv;
  if (tv.ok) {
    if (tv.state === 'idle' && !tv.dailyLimit) {
      if (dryRun) onLog('   [dry-run] Buddy 空闲，将派出旅行');
      else {
        const d = await travelDepart(st);
        onLog(d.ok
          ? `   🐱 已派 Buddy 去「${d.location}」，约 ${d.hours} 小时后回来`
          : `   ⚠️ 派出失败：${d.error}`);
      }
    } else if (tv.state === 'arrived' || tv.state === 'completed') {
      if (dryRun) onLog(`   [dry-run] Buddy 已到达，将领取 ${tv.rewardCredit} 积分`);
      else {
        const c = await travelClaim(st);
        if (c.ok) { res.credits += c.credit; onLog(`   🐱 旅行奖励 +${c.credit} 积分`); }
        else onLog(`   ⚠️ 旅行领奖失败：${c.error}`);
      }
    } else {
      const eta = tv.arriveAt ? new Date(tv.arriveAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
      onLog(`   · Buddy 状态：${tv.state}${eta ? `（预计 ${eta} 到达）` : ''}`);
    }
  }

  return res;
}

/* ---------------------------------------------------------------- CLI */

async function cli() {
  const argv = process.argv.slice(2);
  const flags = { dryRun: argv.includes('--dry-run'), json: argv.includes('--json') };
  const cmd = argv.find((a) => !a.startsWith('--')) || 'list';
  const names = argv.slice(1).filter((a) => !a.startsWith('--'));
  const targets = names.length ? names : accountNames();

  if (cmd === 'help') {
    console.log([
      'WorkBuddy 成长中心模块',
      '',
      '  node growth.mjs list [账号名]     任务清单 + Buddy 状态（只读）',
      '  node growth.mjs guide [账号名]    待办清单：还差什么 + 一键跳转链接',
      '  node growth.mjs accept [账号名]   报名未报名的任务',
      '  node growth.mjs claim [账号名]    领取进度已达标任务的奖励',
      '  node growth.mjs buddy [账号名]    Buddy 旅行：派出 / 领取',
      '  node growth.mjs run [账号名]      accept + claim + buddy（日常用这个）',
      '',
      '可选：--dry-run（只预览） --json',
      '',
      '说明：本模块不伪造任何行为事件刷进度 —— 只报名、只领真正做完的奖。',
    ].join('\n'));
    return 0;
  }

  if (!targets.length) {
    console.log('没有可用账号。');
    return 0;
  }

  const all = [];
  for (const name of targets) {
    const st = readState(name);
    if (!st) { console.log(`⚪️ ${name}：没有登录态，跳过`); continue; }
    console.log(`\n=== ${name} ===`);

    if (cmd === 'list') {
      const info = await inspect(name, st);
      if (info.error) { console.log(`  ❌ ${info.error}`); continue; }
      const pad = (s, n) => {
        let w = 0;
        for (const ch of String(s)) w += /[一-鿿　-〿]/.test(ch) ? 2 : 1;
        return String(s) + ' '.repeat(Math.max(0, n - w));
      };
      for (const t of info.tasks) {
        const mark = t.claimed ? '✅' : (t.target > 0 && t.current >= t.target ? '🎯' : (t.status === 'accepted' ? '⏳' : '⬜'));
        console.log(`  ${mark} ${pad(t.title, 24)} ${t.current}/${t.target}  ${String(t.credit).padStart(4)}积分  [${t.code}]`);
      }
      console.log(`\n  可领奖：${info.claimable.length} 个 ｜ 未报名：${info.notAccepted.length} 个`);
      if (info.travel?.ok) console.log(`  Buddy 旅行：${info.travel.state}${info.travel.dailyLimit ? '（今日已达上限）' : ''}`);
      continue;
    }

    if (cmd === 'guide') {
      const info = await inspect(name, st);
      if (info.error) { console.log(`  ❌ ${info.error}`); continue; }
      const pending = info.tasks.filter((t) => !t.claimed);
      const total = pending.reduce((s, t) => s + t.credit, 0);
      console.log(`  未领奖任务 ${pending.length} 个，合计 ${total} 积分 ≈ ¥${(total * 0.02).toFixed(2)}\n`);
      console.log('  做完后跑 `node growth.mjs run` 会自动把奖励收下来。\n');
      /* 按「剩余次数」排序：一次性的排前面，先做完收益最高的 */
      pending.sort((a, b) => (a.target - a.current) - (b.target - b.current) || b.credit - a.credit);
      for (const t of pending) {
        const left = t.target > 0 ? `还差 ${t.target - t.current} 次` : '一次性';
        console.log(`  □ ${t.title}   +${t.credit} 积分  (${left})`);
        if (t.desc) console.log(`      ${t.desc}`);
        if (t.jump) console.log(`      打开 → ${t.jump}`);
        console.log();
      }
      continue;
    }

    if (cmd === 'accept') {
      const t = await listTasks(st);
      if (!t.ok) { console.log(`  ❌ ${t.error}`); continue; }
      const pending = t.tasks.filter((x) => x.accept_status === 'not_accepted').map((x) => x.task_code);
      if (!pending.length) { console.log('  · 全部任务已报名'); continue; }
      if (flags.dryRun) { console.log(`  [dry-run] 将报名：${pending.join('、')}`); continue; }
      const a = await acceptTasks(st, pending);
      console.log(a.ok ? `  ✔ 已报名 ${pending.length} 个` : `  ❌ ${a.error}`);
      continue;
    }

    if (cmd === 'claim' || cmd === 'buddy' || cmd === 'run') {
      const r = await runAccount(name, st, { dryRun: flags.dryRun, onLog: (m) => console.log(m) });
      all.push(r);
      if (r.errors.length) for (const e of r.errors) console.log(`   ⚠️ ${e}`);
      continue;
    }

    console.log(`未知命令：${cmd}（执行 node growth.mjs help）`);
    return 2;
  }

  if (cmd === 'run' || cmd === 'claim' || cmd === 'buddy') {
    const credits = all.reduce((s, r) => s + r.credits, 0);
    const claimed = all.reduce((s, r) => s + r.claimed.length, 0);
    const acc = all.reduce((s, r) => s + r.accepted, 0);
    console.log(`\n—— 成长中心：提交报名 ${acc} 个，领奖 ${claimed} 项，共 +${credits} 积分${flags.dryRun ? '（dry-run）' : ''} ——`);
  }
  if (flags.json) console.log(JSON.stringify(all, null, 2));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  cli().then((c) => process.exit(c)).catch((e) => { console.error('❌ ' + (e?.message || e)); process.exit(1); });
}
