/**
 * 签到响应分类器（三态 + 失败细分）
 *
 * 借鉴自 babygoton/WorkDaddy 的 `scripts/checkin-result.js`。
 *
 * 核心洞察（原文注释）：
 *   "Accept only an explicit successful response from the official check-in API.
 *    A successful HTTP status alone is insufficient because gateways can return
 *    an empty or non-JSON 200 response."
 *
 * 我们确实踩过这个坑：TraeWork 国际站账号返回 `{}`、WorkBuddy 网关返回 HTML 401，
 * 两者都不是"业务失败"，却被当成普通错误混在一起，日志里看不出真因。
 *
 * 分类结果：
 *   ok         本次签到成功
 *   already    今天已经签过了（正常，不算失败）
 *   inactive   活动未开放 / 已结束
 *   auth       登录态失效，需要重新登录
 *   throttled  被限流（可稍后重试）
 *   badRequest 请求参数问题（通常是漏了 x-device-id 之类）
 *   gateway    网关拦截（非 JSON / HTML 响应）
 *   unknown    其他
 */

/** 活动未开放的措辞 */
export const INACTIVE_RE = /未开启|未开始|未开放|已结束|已过期|已下线|无此类活动|活动(?:已)?(?:结束|关闭|暂停|下线)|not\s*(?:open|started|active)|inactive|ended/i;
/** 已签到的措辞 */
export const ALREADY_RE = /已签到|已领取|已经(?:签到|领取)|重复签到|今日已|明天再来|明日再来|already\s*(?:checked[-\s]?in|claimed)|already/i;
/** 登录态失效的措辞 */
export const AUTH_RE = /not\s+able\s+to\s+authenticate|unauthor|token\s*(?:无效|失效)|未登录|登录已(?:过期|失效)|not\s+logged\s+in|invalid\s+token/i;
/** 限流的措辞 */
export const THROTTLED_RE = /参与用户太多|稍后再试|请求(?:过于)?频繁|操作太快|限流|try\s*again\s*later|too\s*many|rate\s*limit/i;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 响应体是否为网关的 HTML 页面（而非业务 JSON） */
export const looksLikeHtml = (text) => /^\s*<(!doctype|html|head|body)/i.test(String(text || ''));

/**
 * 分类一次签到响应。
 * @param {{httpStatus?:number, json?:any, text?:string, service?:'workbuddy'|'traework'}} r
 * @returns {{state:string, ok:boolean, already:boolean, code:number|null, message:string, detail:string}}
 */
export function classifyCheckin(r = {}) {
  const http = num(r.httpStatus) ?? 0;
  const json = r.json;
  const text = String(r.text || '');
  const code = num(json?.code ?? json?.status);

  // 1) 网络层完全没通
  if (http === 0) {
    return { state: 'network', ok: false, already: false, code: null, message: '网络请求失败（没拿到响应）', detail: text.slice(0, 160) };
  }
  // 2) 网关返回 HTML（不是业务 JSON）
  if (looksLikeHtml(text)) {
    return {
      state: http === 401 || http === 403 ? 'auth' : 'gateway',
      ok: false, already: false, code: null,
      message: http === 401 || http === 403 ? '网关拒绝（HTTP ' + http + '），登录态可能已失效' : '网关拦截（HTTP ' + http + '，非 JSON 响应）',
      detail: 'HTTP ' + http + ' · HTML 响应',
    };
  }
  // 3) 200 但响应体为空 / 不是对象 —— WorkDaddy 特别强调要单独识别
  if (json === null || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).length === 0) {
    return {
      state: 'gateway', ok: false, already: false, code: null,
      message: '接口返回空响应（HTTP ' + http + '）——通常是域名/接口路径不对，或网关拦截',
      detail: text.trim().slice(0, 160) || '(空)',
    };
  }

  const message = String(json.message ?? json.msg ?? json.error ?? '');
  const detail = message || text.trim().slice(0, 160) || ('HTTP ' + http);

  // 4) 明确的业务判定
  const inactive = INACTIVE_RE.test(message);
  const already = !inactive && (code === 10001 || ALREADY_RE.test(message));
  const authed = AUTH_RE.test(message);
  const throttled = THROTTLED_RE.test(message);

  if (inactive) return { state: 'inactive', ok: false, already: false, code, message: detail, detail };
  if (already) return { state: 'already', ok: true, already: true, code, message: detail, detail };
  if (authed) return { state: 'auth', ok: false, already: false, code, message: detail, detail };
  if (throttled) return { state: 'throttled', ok: false, already: false, code, message: detail, detail };
  if (code === 9004) return { state: 'badRequest', ok: false, already: false, code, message: detail, detail };

  // 5) 成功：必须 code 明确为 0/200，且 HTTP 是 2xx
  if ((code === 0 || code === 200) && http >= 200 && http < 300) {
    return { state: 'ok', ok: true, already: false, code, message: detail, detail };
  }
  if (code === 1001) return { state: 'auth', ok: false, already: false, code, message: detail, detail };

  return { state: 'unknown', ok: false, already: false, code, message: detail, detail };
}

/** 这些状态值得稍后重试（而不是直接判定失败） */
export const RETRYABLE_STATES = new Set(['network', 'gateway', 'throttled']);

/** 这些状态说明登录态没了，需要重新登录 */
export const NEEDS_LOGIN_STATES = new Set(['auth']);

/** 人类可读的状态名（给日志/看板用） */
export const STATE_LABEL = {
  ok: '签到成功',
  already: '今日已签到',
  inactive: '活动未开放',
  auth: '登录态失效',
  throttled: '被限流',
  badRequest: '请求参数错误',
  gateway: '网关拦截',
  network: '网络失败',
  unknown: '未知错误',
};
