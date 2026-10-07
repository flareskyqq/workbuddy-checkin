/**
 * 通知抽象层：一个 notify() 打通多通道
 *
 * 借鉴自 keggin-CHN/leaflow-checkin 的 `notify.py` 与 star620/TraeTools 的飞书 webhook 用法。
 *
 * 设计原则：
 *  1. 通知失败**绝不影响**签到主流程 —— 所有通道都包 try/catch + 超时
 *  2. 配置驱动，加通道不用改调用方
 *  3. 默认只发 macOS 系统通知（零配置可用）
 *
 * config.json 里的配置：
 * {
 *   "notify": {
 *     "enabled": true,
 *     "onlyOnFailure": false,          // true = 只有出现失败账号时才发
 *     "channels": [
 *       { "type": "macos" },
 *       { "type": "feishu",  "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" },
 *       { "type": "wecom",   "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" },
 *       { "type": "dingtalk","webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx", "secret": "可选" },
 *       { "type": "generic", "webhook": "https://your.endpoint/hook", "headers": {} },
 *       { "type": "stdout" }
 *     ]
 *   }
 * }
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const TIMEOUT_MS = 10000;

/** 读配置；缺省给一个「只发 macOS 通知」的默认值 */
export function loadNotifyConfig(cfg = {}) {
  const n = cfg.notify || {};
  return {
    enabled: n.enabled !== false,
    onlyOnFailure: n.onlyOnFailure === true,
    channels: Array.isArray(n.channels) && n.channels.length
      ? n.channels
      : [{ type: 'macos' }],
  };
}

/* ---------------------------------------------------------------- 各通道实现 */

function channelMacos({ title, body }) {
  return new Promise((resolve) => {
    // osascript 的字符串转义：把双引号和反斜杠转义掉
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
    execFile('osascript', ['-e', script], { timeout: TIMEOUT_MS }, (err) => {
      resolve({ ok: !err, error: err ? String(err.message).slice(0, 120) : undefined });
    });
  });
}

async function postJson(url, payload, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // 飞书/企微/钉钉都会在 body 里带错误码，HTTP 200 不代表成功
    const bizErr = json && (json.code ?? json.errcode);
    const ok = r.ok && (bizErr === undefined || bizErr === 0);
    return { ok, error: ok ? undefined : `HTTP ${r.status} ${text.slice(0, 140)}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 140) };
  } finally {
    clearTimeout(timer);
  }
}

/** 钉钉要求加签：timestamp + "\n" + secret 做 HMAC-SHA256，再 base64 + urlencode */
function dingtalkSign(webhook, secret) {
  const ts = Date.now();
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
  );
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${ts}&sign=${sign}`;
}

const textOf = ({ title, body }) => `${title}\n${body}`;

/* ---------------------------------------------------------------- 对外入口 */

/**
 * 发通知。任何通道失败都只记在返回值里，不抛异常。
 * @returns {Promise<{sent:number, results:Array<{type:string,ok:boolean,error?:string}>}>}
 */
export async function notify(ncfg, { title, body, hasFailure = false, force = false } = {}) {
  const results = [];
  if (!ncfg?.enabled) return { sent: 0, results };
  if (ncfg.onlyOnFailure && !hasFailure && !force) {
    return { sent: 0, results: [{ type: '(skipped)', ok: true, error: 'onlyOnFailure=true 且本次无失败' }] };
  }

  for (const ch of ncfg.channels || []) {
    const type = String(ch?.type || '').toLowerCase();
    let r;
    try {
      if (type === 'macos' || type === 'osascript') {
        r = await channelMacos({ title, body });
      } else if (type === 'feishu' || type === 'lark') {
        r = ch.webhook
          ? await postJson(ch.webhook, { msg_type: 'text', content: { text: textOf({ title, body }) } })
          : { ok: false, error: '缺少 webhook' };
      } else if (type === 'wecom' || type === 'wechat' || type === 'qyapi') {
        r = ch.webhook
          ? await postJson(ch.webhook, { msgtype: 'text', text: { content: textOf({ title, body }) } })
          : { ok: false, error: '缺少 webhook' };
      } else if (type === 'dingtalk') {
        if (!ch.webhook) r = { ok: false, error: '缺少 webhook' };
        else {
          const url = ch.secret ? dingtalkSign(ch.webhook, ch.secret) : ch.webhook;
          r = await postJson(url, { msgtype: 'text', text: { content: textOf({ title, body }) } });
        }
      } else if (type === 'generic' || type === 'webhook') {
        r = ch.webhook
          ? await postJson(ch.webhook, { title, body, text: textOf({ title, body }), ts: new Date().toISOString() }, ch.headers || {})
          : { ok: false, error: '缺少 webhook' };
      } else if (type === 'stdout' || type === 'console') {
        console.log(`[通知] ${title}\n${body}`);
        r = { ok: true };
      } else {
        r = { ok: false, error: `未知通道类型：${ch?.type}` };
      }
    } catch (e) {
      r = { ok: false, error: String(e?.message || e).slice(0, 140) };
    }
    results.push({ type: ch?.type || '?', ...r });
  }

  return { sent: results.filter((x) => x.ok).length, results };
}

/** 把签到结果拼成一段人类可读的汇总文本 */
export function formatSummary({ results = [], traeResults = [], title = 'WorkBuddy 签到' } = {}) {
  const all = [...results, ...traeResults];
  const failed = all.filter((r) => !r.ok);
  const gained = all.reduce((s, r) => s + (r.credit || 0), 0);
  const lines = [`${all.length - failed.length}/${all.length} 个账号成功，共领取 ${gained} 积分`];
  for (const r of failed) {
    lines.push(`❌ ${r.name}：${r.text}`);
  }
  return { title, body: lines.join('\n'), hasFailure: failed.length > 0 };
}
