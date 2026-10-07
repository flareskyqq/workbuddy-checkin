# GitHub 同类项目调研 + 优化落地

> 调研日期：2026-10-02　目的：看别人怎么做多账号签到，把成熟做法搬进来

## 一、调研的 10 个项目

### A 类：同赛道（AI 工具签到 / 多账号管理）

| 项目 | Star | 语言 | 与我们的关系 |
| --- | --- | --- | --- |
| [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy) | 1633 | JS | **同目标（WorkBuddy/CodeBuddy）**，100+ 模块，架构最成熟 |
| [qixing-jk/all-api-hub](https://github.com/qixing-jk/all-api-hub) | 4905 | TS | NewAPI/Sub2API 账号中枢 + 余额看板 + 自动签到 |
| [millylee/anyrouter-check-in](https://github.com/millylee/anyrouter-check-in) | 1405 | Python | 多平台 NewAPI 签到，有完整测试 |
| [smart-open/TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant) | 190 | Tauri+React | **同目标（Trae Work）**，桌面端多账号管理 |
| [star620/TraeTools](https://github.com/star620/TraeTools) | 138 | C#+Python | **同目标（Trae Work）**，签到/切号/用量 |

### B 类：通用多账号签到框架

| 项目 | Star | 关键设计 |
| --- | --- | --- |
| [Sitoi/dailycheckin](https://github.com/Sitoi/dailycheckin) | 8724 | 每个站点一个独立包 + 统一 main 调度，青龙/Docker 部署 |
| [Cp0204/quark-auto-save](https://github.com/Cp0204/quark-auto-save) | 3055 | 签到 + 自动转存 + 推送 |
| [MoeNetwork/Tieba-Cloud-Sign](https://github.com/MoeNetwork/Tieba-Cloud-Sign) | 1974 | 云签到，插件化 |
| [LuckyPray/XAutoDaily](https://github.com/LuckyPray/XAutoDaily) | 1588 | QQ 模块化签到，配置驱动 |
| [keggin-CHN/leaflow-checkin](https://github.com/keggin-CHN/leaflow-checkin) | 143 | **纯 Token 认证、无浏览器**、GitHub Actions 定时、通知抽象 |

---

## 二、提炼出的 8 个模式

### 1. 原子写文件 ⭐ 已采纳

**来源**：WorkDaddy `scripts/atomic-file-write.js`

```js
writeFileSync(tmp) → chmodSync(tmp) → renameSync(tmp, file)   // rename 是原子的
```

**为什么重要**：`writeFileSync` 直接覆盖时，写到一半进程被杀/断电 → 文件变半截 JSON。
我们**已经踩过**这个坑：`data/trae.json` 解析失败时，`upsert` 会把整个文件覆盖掉，
多账号场景下等于丢掉其他账号的全部历史（当时只能靠"检测到损坏就先备份"事后补救）。

Windows 上 `rename` 会被杀软/索引器短暂占用，需要针对 `EPERM/EACCES/EBUSY` 重试。

### 2. 签到响应三态分类 ⭐ 已采纳

**来源**：WorkDaddy `scripts/checkin-result.js`

原文注释点破了要害：

> A successful HTTP status alone is insufficient because gateways can return
> an empty or non-JSON 200 response.

分类结果：`ok / already / inactive / auth / throttled / badRequest / gateway / network / unknown`

**为什么重要**：我们之前是零散的正则匹配，导致两类问题被混在一起：
- TraeWork 国际站返回 `{}` —— 看起来像"查询失败"，其实是域名/路径不对
- WorkBuddy 网关返回 HTML 401 —— 看起来像业务错误，其实是登录态问题

### 3. 按 Token 的 `iss` 决定 API 域名 ⭐ 已采纳（理念）

**来源**：WorkDaddy `checkin-result.js` 的 `tokenIssuerOrigin()` + `ISSUER_HOST_MAP`

解析 JWT 的 `iss` 声明，映射到正确的域名（`workbuddy.cn` / `workbuddy.ai` / `codebuddy.cn` / `codebuddy.ai`），
而不是硬编码候选列表逐个试。

**对我们的启发**：我们踩过反向的坑 —— 把 TRAE SOLO 国际站的账号（host 是 `growsg-normal.trae.ai`）
按国内路径调用，拿到空响应。现在的处理是"非 CN 直接跳过"，更彻底的做法是按 host 决定接口版本。

### 4. 回环端口单实例锁 ⭐ 已采纳

**来源**：WorkDaddy `scripts/watchdog.js`

```js
net.createServer().listen({ host: '127.0.0.1', port, exclusive: true })
// EADDRINUSE = 已有实例在跑 → 本实例退出
```

锁归 OS 管，进程退出（含被 kill）自动释放，**不会留下死锁文件**。

**为什么重要**：定时任务与看板上的「立即签到」按钮可能同时跑，
两个进程各自 read-modify-write 同一份 `state.json` → 后写的覆盖先写的。

### 5. 指数退避重启

**来源**：WorkDaddy `watchdog.js`

```js
restartDelay = Math.min(restartDelay * 2, 60000);   // 稳定 60s 后重置为 3s
```

**未采纳**：我们的场景是一次性任务而非常驻守护，用不上。

### 6. 提前续期 + 不可变刷新

**来源**：WorkDaddy `scripts/token-refresh.js`

- `shouldRefreshAccessToken(auth, now, threshold = 1 天)` —— 到期前 1 天就刷新，不等它过期
- 刷新函数返回**新对象**，不修改入参

**部分采纳**：我们的 TraeWork 桌面来源**故意不主动续期**（续期会轮换 refreshToken，
把用户的桌面客户端踢下线，见 HANDOFF 4.5）。但"提前判断"的思路用在了状态展示上。

### 7. 纯 Token 认证 / 无浏览器 ⭐ 已实现

**来源**：leaflow-checkin、TraeTools、WorkDaddy 的 token 模式

用环境变量/配置文件传 token，不依赖浏览器。好处：可部署到 GitHub Actions / 服务器，
不占本机资源。

**我们的现状**：TraeWork 已做到（纯 HTTP，仅 `add/login` 用浏览器）；
WorkBuddy 仍依赖浏览器 Cookie（其鉴权链路更复杂，暂不动）。

### 8. 通知抽象

**来源**：leaflow-checkin `notify.py`、TraeTools 的飞书 webhook

统一通知接口，支持飞书/钉钉/企业微信/邮件多通道。

**未采纳**：我们目前只有 macOS 系统通知。若要加多通道，应该抽一层而不是到处写。

---

## 三、本次实际落地的改动

| 文件 | 改动 | 来源模式 |
| --- | --- | --- |
| `lib/safe-io.mjs` | **新增**：原子写文件 + 回环端口单实例锁 | #1 #4 |
| `lib/checkin-result.mjs` | **新增**：签到响应三态分类器（含空响应/网关 HTML 识别） | #2 |
| `checkin.mjs` | `writeState` / `writeDb` 改用原子写；`checkin`/`status`/`stats` 加单实例锁 | #1 #4 |
| `trae.mjs` | `trae.json` 改原子写；状态与领取结果改用分类器；可重试状态自动退避重试 3 次 | #1 #2 |

### 效果验证

**单实例锁**（并发跑两个 `status`）：

```
A → ➖ 账号A：【查询】今日已签到，连续 2 天，余额 1376.3
B → ⚠️ 已有签到任务正在运行（端口 47940 被占用），本次跳过，避免并发写坏数据
```

**分类器**（10 个真实响应用例，全部正确）：

| 输入 | 分类 |
| --- | --- |
| TraeWork `{code:0, checked_in:true}` | `ok` |
| TraeWork `{code:9074, "参与用户太多"}` | `throttled` |
| TraeWork `{}` | `gateway`（空响应） |
| TraeWork `{code:1001}` | `auth` |
| WorkBuddy HTML 401 | `auth`（网关拒绝） |
| WorkBuddy `{code:10001,"已经签到过了"}` | `already` |
| `fetch failed` | `network` |
| `{code:1002,"活动已结束"}` | `inactive` |
| `{code:9004}` | `badRequest` |

**错误信息可读性提升**：

```
改前：❌ 用户1656845595：领取失败：当前参与用户太多，请稍后再试
改后：❌ 用户1656845595：领取失败（被限流）：当前参与用户太多，请稍后再试
```

---

## 四、调研中确认的、但**不采纳**的做法

### TraeTools 的「9074 = 设备被风控，换设备号重试」

`star620/TraeTools/checkin.py` 注释称 9074 是设备号被标记，换全新设备号重试最多 5 次。

**我实测验证了，对我们不成立**：

```
② claim 用【当前设备号】   → {"code":9074}
③ claim 用【全新随机设备号】 → {"code":9074}    ← 完全一样
④ status                  → checked_in: false（没签上）
```

结论：9074 是**账号级/活动级限制**，不是设备风控。所以：
1. 换设备号解决不了问题
2. 也**不该**去实现设备号轮换 —— 那是绕过风控，而且没用

### 多账号随机间隔 3~6 秒

TraeTools 在账号之间加随机间隔以降低请求密度。我们的账号数少（1 个 TraeWork），
且每次请求之间本来就有网络往返延迟，暂不需要。

---

## 五、后续优化（2026-10-02 已全部落地）

| # | 项目 | 状态 | 实现 |
| --- | --- | --- | --- |
| 1 | TraeWork 国际站支持 | ✅ **已查清，确认不支持** | 见下 |
| 2 | 通知抽象层 | ✅ 已做 | `lib/notify.mjs` |
| 3 | 登录态主动保活 | ✅ 已做 | `repair-state.mjs --max-age` |
| 4 | 结构化日志 | ✅ 已做 | `runs[].states` + `checkin.mjs report` |

### 1. TraeWork 国际站：查清了，**它根本没有签到活动**

实测 `growsg-normal.trae.ai`（SG 区）：

| 路径 | 结果 |
| --- | --- |
| `/trae/api/v1/pay/user_current_entitlement_list` | **200 ✅**（说明国际站用 v1） |
| `/trae/api/v1/ug/checkin_credits/status` | 404 |
| `/trae/api/v1/ug/checkin_credits/claim` | 404 |
| `/trae/api/v1/checkin_credits/status` | 404 |
| `/trae/api/v1/ug/checkin/status` | 404 |
| `/trae/api/v1/checkin/status` | 404 |
| `/trae/api/v1/ug/daily_checkin/status` | 404 |
| `/trae/api/v1/pay/checkin_credits/status` | 404 |
| `/trae/api/v1/ug/checkin_status` | 404 |

而且权益数据里只有 `Free plan / limit=0`，**连 `usage_summary` 都没有** —— 说明该站点就没有积分签到这回事。

**结论**：不是"我们没支持"，是**它不存在**。已把跳过原因从笼统的「非国内站」改成明确的
「国际站无签到活动（实测 8 个候选路径均 404）」。

### 2. 通知抽象层 —— `lib/notify.mjs`

支持的通道：`macos` / `feishu`(飞书) / `wecom`(企业微信) / `dingtalk`(钉钉，含加签) / `generic`(通用 webhook) / `stdout`

配置在 `config.json` 的 `notify` 段：

```json
"notify": {
  "enabled": true,
  "onlyOnFailure": false,
  "channels": [
    { "type": "macos" },
    { "type": "feishu", "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" },
    { "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx", "secret": "可选" }
  ]
}
```

设计要点：
- **通知失败绝不影响签到** —— 每个通道独立 try/catch + 10 秒超时
- **识别业务级失败** —— 飞书/企微/钉钉出错时 HTTP 仍是 200，要看 body 里的 `code`/`errcode`。
  实测：假 webhook 返回 `HTTP 200 {"code":19001}`，被正确判为失败

### 3. 登录态主动保活 —— `repair-state.mjs --max-age <天>`

业务会话 7 天到期，所以**不等 401 再修**，而是距上次续期超过阈值就主动续：

```bash
node tools/repair-state.mjs --max-age 5
```

`daily-checkin.sh` 已默认带 `--max-age 5`。实测输出会显示每个账号的续期年龄：

```
✅ 账号A：登录态正常（0.3 天前续期），不用修
✅ 账号D：登录态正常（4.4 天前续期），不用修
```

### 4. 结构化日志 —— `runs[].states` + `checkin.mjs report`

每次运行把各状态数量写进 `data/state.json` 的 `runs[]`，新增 `report` 命令看趋势：

```bash
node checkin.mjs report 7     # 最近 7 天
```

```
最近 7 天：26 次运行（其中 25 次有失败）
账号次：68/147 成功（46.3%）｜共领取 2600 积分

各状态次数：
  失败             78  ████████████████████████████
  签到成功           63  ███████████████████████
  今日已签到           5  ██
  登录态失效           1  █
```

> 旧记录没有 `states` 字段，`report` 会用 `ok/total` 兜底分类，不会显示成空白。
