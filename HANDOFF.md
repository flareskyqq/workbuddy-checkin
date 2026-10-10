# WorkBuddy + TraeWork 自动签到 + 积分看板 —— 交接说明

> 交接日期：2026-09-24　机器：macOS（Apple M1）　项目路径：`~/workbuddy-checkin`
> 本文档面向接手继续开发的 AI / 工程师，读完即可上手。

---

## 一、这是什么

多账号每日自动签到 + 积分统计看板，目前覆盖**两个站点**：

**站点 1：WorkBuddy**（腾讯，国内版 `workbuddy.cn`）

- 每天定时为多个账号自动签到领积分（每日签到 +100）
- 采集每个账号的**剩余积分 / 已用积分 / 累计签到领取 / 持久连签 / 资源包明细**
- 自带本地可视化看板（蓝白主题 + 小猫元素）与 macOS 桌面 App
- 支持在界面里添加账号、改名、重新登录、删除

**站点 2：TraeWork**（字节跳动，`work.trae.cn` / `api.trae.cn`）—— 2026-09-24 新增

- 每天自动签到领积分（每日 +100~200）
- **零配置**：直接复用本机 TRAE 桌面客户端的登录态（只读），不需要在工具里加账号、不需要浏览器
- 采集**总积分 / 已用积分 / 权益包明细 / 签到历史**

**成果**：用户 4 个 WorkBuddy 账号（3 个可用）已连续自动签到；TraeWork 1 个账号（桌面客户端登录的那个）已接入；看板能看到两个站点的余额与用量；桌面 App 可双击打开。

---

## 二、当前运行状态（交接时）

| 项 | 状态 |
| --- | --- |
| 看板服务 | launchd `com.workbuddy.dashboard`，`http://127.0.0.1:8787/`，常驻 + 开机自启 |
| 定时签到 | launchd `com.workbuddy.daily-checkin`，每天 **09:05**，**14:30** 补跑一次（错过会在唤醒后补）。入口是 `daily-checkin.sh`（等网络 → 修登录态 → 签到），**两个站点都会签到**，无需额外配置 |
| 桌面 App | `~/Applications/WorkBuddy积分.app`（源码副本在 `build/`，用 Edge 打开窗口） |
| 浏览器 | 登录用 **Microsoft Edge**（`config.json` → `"browser": "edge"`）。**仅 WorkBuddy 需要**；TraeWork 走纯 HTTP |
| 积分单价 | `creditToYuan: 0.02`（官方标价口径，50 积分 ≈ ¥1）。**仅用于 WorkBuddy**，TraeWork 积分体系不同、不折算 |

**账号现状**（`config.json` + `accounts/*.state.json`）：

| 账号名 | 站点 | 状态 |
| --- | --- | --- |
| 账号A | workbuddy.cn | 🟢 正常，连签 11 天 |
| 账号B | workbuddy.cn | 🟢 正常，连签 7 天 |
| 账号C | workbuddy.cn | 🟢 正常，连签 7 天 |
| 账号D | workbuddy.cn | 🟢 **2026-09-27 已修复**，连签 8 天（此前长期 401，见"已知问题 1"） |
| 账号E | workbuddy.cn | 🟢 **2026-09-27 已修复**，连签 1 天（此前一直 401） |
| 1 | workbuddy.cn | ⚪️ 从未登录（用户测试时建的，可删） |
| 用户1656845595 | TraeWork（桌面来源） | 🟢 登录态正常；**签到被服务端限流**：`code 9074 当前参与用户太多` |

---

## 三、目录结构

```
checkin.mjs          主脚本：登录 / 签到 / 采集 / 账号管理（CLI）+ 统一入口（含 TraeWork）
trae.mjs             TraeWork 站点模块：读登录态 / 签到 / 采集（纯 HTTP，无浏览器依赖）
growth.mjs            成长中心模块：任务报名 / 领已达标奖励 / Buddy 旅行（纯 HTTP）
lib/safe-io.mjs      原子写文件 + 回环端口单实例锁（借鉴 WorkDaddy）
lib/checkin-result.mjs 签到响应三态分类器（区分 网关HTML/空响应/业务码/限流/未开放）
lib/notify.mjs       通知抽象层：macos / 飞书 / 企微 / 钉钉(加签) / 通用 webhook / stdout
daily-checkin.sh     每日任务入口：等网络 → 修登录态 → 签到（install-daily.sh 调用它）
tools/repair-state.mjs 修复「登录成功但一直 401」的账号（无头浏览器续期，不用重新扫码）
dashboard.mjs        本地看板服务（含 REST 接口，供网页调用）
dashboard.html       看板前端（单文件，无外部依赖，蓝白主题 + 小猫）
config.json          账号与全局配置（站点、浏览器、积分单价、账号列表、traework 开关）
accounts/*.state.json 每个 WorkBuddy 账号的登录态（Cookie + Bearer 令牌，权限 600，**敏感**）
accounts/*.trae.json  每个 TraeWork 网页账号的登录态（Cookie + deviceId，权限 600，**敏感**）
profiles/<账号>/      每个账号独立的浏览器配置（**体积大，不入包**）
data/state.json      看板数据源：WorkBuddy 余额、用量、历史、签到日期、uid、冲突标记
data/trae.json       看板数据源：TraeWork 总积分、权益包、签到历史、登录态到期时间
logs/                运行日志（checkin-YYYY-MM-DD.log / dashboard-*.log）
tools/               诊断与性能测量脚本（见下）
build/               桌面 App 源码副本 + 小猫图标生成器
docs/                界面截图 + `GitHub同类项目调研.md`（10 个同类项目分析 + 可借鉴模式）
install-daily.sh     安装/更新定时任务（可改时间）
uninstall-daily.sh   卸载定时任务
set-icon.sh <orange|navy|cream>  切换小猫图标
登录账号.command / 签到.command / 看板.command   双击即可用的快捷入口
```

---

## 四、核心原理

### 4.1 用到的接口（全部 `POST`）

| 用途 | 路径 |
| --- | --- |
| 签到活动状态 | `/v2/billing/meter/checkin-activity-status` |
| 执行签到 | `/v2/billing/meter/daily-checkin` |
| 余额/总量聚合 | `/v2/billing/meter/get-user-resource-summary` |
| 免费包明细（含签到赠送） | `/v2/billing/meter/get-user-resource-free-packages` |
| 付费包明细 | `/v2/billing/meter/get-user-resource-paid-packages` |

网关：国内 `https://www.workbuddy.cn`（备用国际 `www.workbuddy.ai`）。
请求必须带**浏览器形态的 header**（User-Agent / Origin / Referer），否则 APISIX 网关直接 401。

### 4.2 鉴权

- 登录态来自浏览器 Cookie：业务会话 `session` / `session_2`（7 天）+ Keycloak 身份 `KEYCLOAK_SESSION`（1 年）
- 也支持 `Authorization: Bearer <JWT>`（代码会从页面 localStorage 里找 JWT 兜底）
- **判定"登录成功"只认业务会话 `session` / `session_2`** —— Keycloak 的 `AUTH_SESSION_ID` 在登录页就会写，不能作为判据（踩过坑）

### 4.3 三级降级策略

1. **http**（默认）：直接用上次登录保存的 Cookie 调接口，不启浏览器（日常签到都走这条）
2. **browser**：无头 Edge 以"页面同源请求"调用，自动带完整登录态
3. **params**：`--params <curl 文本/文件>` 直接复用抓包 header（终极兜底）

### 4.4 登录流程性能优化（**重要**）

| 打开方式 | 请求数 | 空闲 CPU |
| --- | --- | --- |
| 官网首页 `www.workbuddy.cn/` | 117 | **25%** |
| **登录页 `www.workbuddy.cn/login/`** | 42 | **0.1%** |
| 登录页 + Edge | 42 | 0.1% |

**结论：登录窗口必须直接开 `/login/`，绝不能走首页**（首页是营销页，会卡死）。
代码里已有 `normalizeLoginUrl()` 兜底：配置里写根地址也会自动改成 `/login/`。

### 4.5 TraeWork 站点（2026-09-24 新增，同日扩展为多账号）

实现文件：`trae.mjs`。签到/采集走**纯 HTTP**，只有 `add` / `login` 会启动浏览器。
`checkin.mjs` 通过 `import { runTrae, discoverTraeAccounts, loadTraeConfig } from './trae.mjs'` 集成。

#### 两种账号来源（统一收敛到同一个鉴权头）

| | 来源 ① 桌面客户端 | 来源 ② 网页登录 |
| --- | --- | --- |
| 发现方式 | 自动（扫 `storage.json`） | 扫 `accounts/*.trae.json` |
| 配置成本 | 零 | 每个账号 `node trae.mjs add <名字>` 登录一次 |
| 账号上限 | **1 个**（客户端同时只登一个） | 不限 |
| 令牌获取 | 解密 `storage.json` 直接拿 | `POST /cloudide/api/v3/common/GetUserToken`（带 Cookie） |
| `kind` 字段 | `desktop` | `web` |

两者最终都用 `Authorization: Cloud-IDE-JWT <token>`。

#### 鉴权来源 ①：桌面客户端（**只读**，绝不写回）

```
~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json
  ├─ iCubeAuthInfo://icube.cloudide        → token / refreshToken / expiredAt / userId / host / userRegion / account
  └─ iCubeAuthInfo://icube-dc:<machineId>  → privateKeyPEM / publicKeyPEM
```

两个键都是 **AES-128-CBC 信封加密**。解密算法（已实测跑通，与平台无关）：

```
t   = base64_decode(blob)
key = t[6 : 6+32]                    # EM=6, RV=32
hash= SHA512( SHA512(key) || (K1 xor K2) )     # 前 64 字节 || 64 字节常量异或
aesKey = hash[0:16]                  # AES-128
iv     = hash[16:32]
plain  = AES-128-CBC_decrypt( t[38:], aesKey, iv )
json   = JSON.parse( plain[64:] )    # 丢掉前 64 字节头
```

K1 / K2 是硬编码的 64 字节常量（见 `trae.mjs` 的 `K1` / `K2`）。

> 备选目录也会探测：`Trae CN`（Trae IDE 客户端）。同一账号可能在多个目录都有登录态，按 `userId` 去重。

#### 鉴权来源 ②：网页登录（多账号用这条）

入口有两个：看板右上角 **「＋ 添加 TraeWork 账号」**（走 `POST /api/traework/add`），或命令行 `node trae.mjs add <名字>`。两者最终都执行 `addWebAccount()`。

`node trae.mjs add <名字>` 的流程：

1. `chromium.launchPersistentContext(profiles/trae-<名字>/, { channel: 'msedge', headless: false })`
2. 打开 `https://work.trae.cn/`，用户手动登录（工具不碰登录表单）
3. **每 2 秒轮询** `POST api.trae.cn/cloudide/api/v3/trae/CheckLogin`，看 `Result.IsLogin` 是否变 `true`
4. 登录成功后 `ctx.cookies()` 取全部 Cookie，连同 `Result.UserID` / `Host` / `Region` 写入 `accounts/<名字>.trae.json`（600 权限），关闭浏览器

日常签到不再开浏览器，直接用保存的 Cookie 调 `GetUserToken` 换令牌（令牌约 1 小时，同一次运行内缓存）。

`accounts/<名字>.trae.json` 结构：

```json
{ "name": "...", "userId": "...", "username": "...",
  "host": "https://api.trae.cn", "region": "CN",
  "deviceId": "web-<userId>-<随机>",   // 添加时生成一次，此后固定不变
  "savedAt": "...", "cookies": [ ...playwright cookie 对象... ] }
```

> **未登录时的返回特征**（判定逻辑依赖这些）：
> - `CheckLogin` → HTTP 200，`Result.IsLogin = false`
> - `GetUserToken` → **HTTP 401**，`ResponseMetadata.Error.Code = 20101`（Token 无效）
> - `GetUserInfo` → HTTP 401，`Code = 20310`
> - 签到接口 → HTTP 200，`code = 1001`

#### 接口（全部 `POST`，host 固定 `https://api.trae.cn`）

| 用途 | 路径 |
| --- | --- |
| 登录检测 | `/cloudide/api/v3/trae/CheckLogin` |
| 用户信息 | `/cloudide/api/v3/trae/GetUserInfo` |
| 换令牌（网页来源） | `/cloudide/api/v3/common/GetUserToken` |
| 签到状态 | `/trae/api/v2/ug/checkin_credits/status` |
| 执行签到 | `/trae/api/v2/ug/checkin_credits/claim` |
| 积分权益明细 | `/trae/api/v2/pay/user_current_entitlement_list` |

请求头：`Authorization: Cloud-IDE-JWT <token>`、`Content-Type: application/json`、`X-User-Region: CN`、`x-device-id: <machineId>-<userId>`。

返回判定：
- 成功：`code === 0 || code === 200 || success === true`
- 鉴权失败：`code === 1001`（未登录 / token 失效）
- 参数错误：`code === 9004`（**通常是漏了 `x-device-id`**）

#### 两个必须记住的坑

1. **`x-device-id` 是必需的，且必须一账号一值**
   TraeWork 领取接口按 `x-device-id` 做「一设备一天一次」拦截。多账号共用同一 deviceId → 只有第一个成功、其余全被拒。
   工具用 `machineId-userId` 生成**每账号稳定且唯一**的设备号。**稳定性很关键**：如果每天换一个 deviceId，等于绕过每日限制，属于滥用，不要这么做。

2. **不要主动续期 token**
   `token` 有效期约 14 天，`refreshToken` 约 6 个月。续期接口 `/trae/api/v3/oauth/ExchangeToken` 需要 `privateKeyPEM` + RSA 签名（材料齐备，技术上可做），但**它会轮换 `refreshToken`**——工具抢先续期会让桌面客户端手里的旧 refreshToken 失效，用户被迫重新登录 TRAE。
   因此当前策略：**只读复用 + 到期提示**。`list` 会显示「🟡 登录态 N 天后过期」，提示用户打开一次 TRAE CN（客户端自己会刷新 `storage.json`）。
   > 这是有意的设计取舍，不是没做完。若将来要做续期，务必先确认服务端是否允许多个 refreshToken 并存，并考虑把新凭据**加密写回** `storage.json`（需要逆向加密过程，风险高）。

#### 安全边界

- 只读 `storage.json`，**不修改 TRAE 任何文件**
- 日志/输出**不打印 token**（只打印长度与前缀）
- 签到结果落在 `data/trae.json`（不含任何凭据）

---

### 4.6 成长中心（任务 / Buddy 旅行）— 2026-10-02 新增

实现文件：`growth.mjs`（纯 HTTP，只用 `accounts/*.state.json` 里的 Cookie，**不需要 Bearer**）。
`daily-checkin.sh` 第 3 步调用它；`config.json` 的 `growth.enabled` 可关。

#### ⚠️ 接手必读：这个模块刻意不做什么

**不伪造任何「行为事件」去刷任务进度。**

成长中心的进度由服务端依据**真实行为**点亮（创建画布、装技能、召唤专家、用特定模型对话、
关注公众号满 24h 等）。网上有项目（例：`workbuddy2api-panel` 的 `scripts/task_chat5.py`、
`task_common.py`）直接构造 `{"eventCode":"chat_request_send","timestamp":...}` 上报，
**谎报用户聊过天来骗任务奖励** —— 那是伪造数据骗平台积分，本项目不实现。

若将来有人提"能不能自动刷满任务进度"，答案是：**不能**，而且理由要讲清楚。

#### 只做的两件正当的事

| 动作 | 端点 | 说明 |
| --- | --- | --- |
| **报名 accept** | `POST /activity/growth/tasks/accept` `{"task_codes":[...]}` | 部分任务进度**从报名后才开始计**。提前报名，用户正常使用产品时进度才会自然积累 |
| **领奖 claim** | `POST /activity/growth/tasks/<task_code>/claim` | 只领**进度已达标**的（`current >= target`），即用户确实完成但没领的。幂等，重复领返回 `already_claimed:true` |

外加 Buddy 旅行（站内正当游戏机制）。

#### 实测接口（真实账号，2026-10-02）

| 用途 | 路径 | 备注 |
| --- | --- | --- |
| 任务列表 | `GET /v2/activity/growth/tasks` | 含 `progress{current,target}`、`accept_status`、`reward_credit` |
| 报名 | `POST /activity/growth/tasks/accept` | **不带 `/v2`** —— `/v2/activity/growth/tasks/accept` 会 401 |
| 领奖 | `POST /activity/growth/tasks/<code>/claim` | 无 body，task_code 在路径里 |
| 旅行状态 | `GET /activity/growth/buddy/travel/status` | `state`: idle / traveling / arrived |
| 旅行地点 | `GET /activity/growth/buddy/travel/config` | `data.locations[]`，含 `id` / `name` / `duration_hours` |
| 派出 | `POST /activity/growth/buddy/travel/depart` | **必须带 `{"location_id":N}`**，只传 `{}` 会 400 `invalid request` |
| 旅行领奖 | `POST /activity/growth/buddy/travel/claim` | |
| Buddy 信息 | `GET /activity/growth/buddy/info` | |

**鉴权**：只用 Cookie + `x-client-platform: web` + `Origin`/`Referer` 指向 `/profile/growth-center`。
不需要 Bearer（我们从 localStorage 里没找到 JWT，直接用 Cookie 就通）。

**错误字段是该 API 的 `msg` 而不是 `message`** —— 取错误信息两个都要试（见 `errOf()`）。

#### 已知返回

- `no active buddy` —— 该账号还没领养 Buddy（`first_buddy` 任务未达标），派出是预期失败，不是 bug
- `already traveling` —— Buddy 已在旅途中

#### 实测效果

`账号D` 一次性领到「领取一只 Buddy」**+300 积分 +8 能量**（进度早就 1/1，只是没人领）。

---

### 4.7 ⚠️ 项目**不能放在 iCloud 同步的目录里**（2026-10-10 重大故障）

**故障现象**：看板反复崩溃（累计 **8290 次**）、定时任务静默失效、日志里全是
`Error: Unknown system error -11`（= EAGAIN）和 `Operation not permitted`。

**根因**：项目原本在 `~/Desktop/工作/workbuddy-checkin`，而 macOS 开了
**iCloud「桌面与文档」同步**（`defaults read com.apple.finder FXICloudDriveDesktop` = 1）。
iCloud 会把不常用的文件**驱逐到云端**，本地只留占位符：

```
$ stat -f "%z %b" data/state.json
52326 0        # 52326 字节，但占 0 个磁盘块 = 内容在云端
```

node 读这种文件 → **`EAGAIN (errno -11)`** → 崩溃。launchd 再拉起 → 再崩 → 死循环。
同时 launchd 访问 iCloud 托管的 `~/Desktop` 还会被 TCC 拦（`Operation not permitted`）。

**判断方法**（以后遇到类似问题先跑这个）：
```bash
for f in *.mjs data/*.json; do
  sz=$(stat -f %z "$f"); blk=$(stat -f %b "$f")
  [ "$sz" -gt 4096 ] && [ "$blk" -eq 0 ] && echo "未下载: $f"
done
defaults read com.apple.finder FXICloudDriveDesktop   # 1 = 桌面被 iCloud 接管
```

**修复**：把项目移到 **`~/workbuddy-checkin`**（`~` 根目录不受 iCloud 和 TCC 保护）。
搬迁后实测：看板连续运行 **10 分钟零崩溃**，定时任务 err.log 全空、5/7 账号签到成功。

**两条硬性约束**：
1. **项目必须放在 `~/` 下、不要放 Desktop / Documents / Downloads** —— 这三个目录默认被 iCloud 同步 + TCC 保护
2. launchd plist 里的 `NODE_BIN` **不要写死版本号目录** —— managed node 升级过（`22.22.2-3` → `-6`）旧路径就没了。
   `daily-checkin.sh` 现已做三级兜底，但 plist 里的路径仍需留意。

---

## 五、已知问题 / 踩过的坑（接手务必看）

### 1. 「登录成功但马上失效」的真正原因：保存 Cookie 的时机太早（2026-09-27 定位并修复）

**症状**：扫码/窗口登录都提示「登录成功」、也能在浏览器里读到余额，但存下来的 Cookie 用纯 HTTP
调接口**从第一秒起就是 401**（APISIX 网关返回 HTML）。重新登录多少次都没用。

**排查过程（方法可复用）**：
1. **对照实验**：同一套代码、同一套请求头 —— `账号A`/`账号B`/`账号C` → 200；`账号E`/`账号D` → 401
   → 排除代码问题，锁定到账号维度
2. 把保存的 Cookie **灌进浏览器上下文**再调接口 → **200 通过**
   → 证明 Cookie 本身有效，问题出在「用纯 HTTP 重放」
3. 逐项试请求头（完整浏览器头 / 按 path 过滤 Cookie / 只带 `session`）→ **全部 401**
   → 排除请求头因素
4. 让浏览器加载一次站点，**对比加载前后的 Cookie** → `session` / `session_2` **被更新了**，
   并新出现 `qcmainCSRFToken` / `intl` / `qcloud_*` / `id` 等 8 个 Cookie
   → 用更新后的 Cookie 走纯 HTTP → **200 通过**

**根因**：登录流程在「检测到登录成功」的瞬间就 `ctx.storageState()` 保存，但那一刻业务会话
`session` / `session_2` **还没完成页面 JS 的静默续期**。页面随后会自动刷新出真正可用的会话，这一步没被等到。

**修复**（已写入 `loginAccount()`）：
- 检测到登录成功后，先 `page.goto(base + '/')` 重新加载站点并**等 10 秒**，再抓 `storageState()`
- 稳定性复验通过后**再抓一次**并覆盖保存，确保存下来的是续期后的最终会话

**存量账号修复**：`node tools/repair-state.mjs [账号名 ...]`
不重新登录，只把已保存的 Cookie 灌进无头浏览器、加载站点等续期、重新抓取覆盖保存。
修复前后都会用纯 HTTP 实调验证，**没修好的账号不会被改动**。
2026-09-27 用它把 `账号E` 和 `账号D` 从 401 修回 200（当天全量签到 3/6 → 5/6）。

> **⚠️ 旧结论已作废**：本文档此前把同类症状归因于「同一账号多处登录互相顶掉」。
> 那个解释对 `账号D` **是错的** —— 它和 `账号E` 一样，都是上面这个保存时机问题。
> `desktopConflict` 标记（看板 🚫）**不能作为失效判据**：桌面客户端占着 `账号A`，而 `账号A` 一直正常。

### 1b. 业务会话只有 7 天，会周期性集体失效（2026-10-01 定位并根治）

**Cookie 有效期实测**：

| Cookie | 有效期 | 作用 |
| --- | --- | --- |
| `session` / `session_2` | **7 天** | 业务会话，调接口靠它 |
| `KEYCLOAK_SESSION` | **365 天** | SSO 身份，用来静默续期业务会话 |

**所以**：连续 7 天只用纯 HTTP 签到、不开浏览器 → 业务会话到期 → 账号集体变成「登录已过期」。
但 SSO Cookie 还有效，**用浏览器访问一次站点就能静默续上**（不需要重新扫码）。

**实证对照（2026-10-01）**：

| 账号 | 上次抓取登录态 | 距今天数 | 结果 |
| --- | --- | --- | --- |
| 账号A / 账号B / 账号C | 09-21 | **10 天** | ❌ 401 |
| 账号D / 账号E | 09-27（repair 抓的） | 4 天 | ✅ 200 |

**根治**：新增 `daily-checkin.sh` 作为每日入口（`install-daily.sh` 已改为调用它），它做两件事：

1. **等网络就绪**（最多 2 分钟）—— Mac 睡眠错过时间后 launchd 会在唤醒瞬间补跑，那时网络没起来，
   整批会以 `HTTP 0 fetch failed` 失败（2026-10-01 的 10:34 / 14:39 两次就是这个）
2. **跑 `tools/repair-state.mjs --max-age 5`** —— 健康账号只发一次 HTTP 探测就跳过，开销约 2 秒；
   过期的账号自动用无头浏览器续期；**距上次续期超过 5 天的会主动续**（业务会话 7 天到期，不等它失效）
3. 最后执行 `checkin.mjs checkin --notify`

> 手动修复单个账号仍然可用：`node tools/repair-state.mjs [账号名 ...]`

### 2. 首页 vs 登录页（已修）
见 4.4。曾因"新增账号"代码路径漏改，导致新增账号走首页 → 用户体感"卡死"。现两处都已修 + 兜底函数。

### 3. 浏览器选择
- 默认 Edge（`config.json` → `browser`，可选 `auto|chrome|edge|chromium`，环境变量 `WBC_BROWSER` 优先）
- **Safari 不可行**：Playwright 驱动不了真正的 Safari App（`webkit` 是另一个内核，拿不到用户 Safari 的会话）
- 曾出现黄色横幅"你使用的是不受支持的命令行标志 `--disable-blink-features=AutomationControlled`" → 已移除该标志

### 4. 机器负载（**性能问题的真正大头**）
交接时实测：系统负载 8.9、交换区已用 1.63GB/2GB。占用大头：Codex 相关进程 ~32%、WindowServer 30%、WorkBuddy AI 15%、用户自己的 Chrome（14 进程）25%。
→ 用户报"卡"时，先看负载，别只怀疑我们的浏览器。

### 5. 其他
- 断网/刚唤醒会导致整批失败 → `httpTransport()` 已加 3 次重试（1.5s/3s/4.5s 退避）
- 登录后页面还在跳转时读数据会报 `Execution context was destroyed` → 已用 `evalRetry()` + 等页面稳定解决
- 同一账号被添加两次（uid 相同）会互相顶掉 → `duplicatesOf()` 已检测并在看板标"⚠️ 重复"
- 看板统计口径：已停用账号不计入顶部统计

---

## 六、常用命令

```bash
cd "~/workbuddy-checkin"

node checkin.mjs list                  # 账号列表 + 余额概览
node checkin.mjs add 账号名            # 新增并登录（会弹 Edge）
node checkin.mjs login 账号名          # 重新登录
node checkin.mjs checkin [账号名..]    # 批量签到（不带名字=全部）
node checkin.mjs status               # 只看状态
node checkin.mjs stats                # 只采集数据（不签到）
node checkin.mjs del 账号名            # 删除账号（含登录态/缓存/统计）
node checkin.mjs doctor 账号名         # 排查登录/接口
node checkin.mjs report 7              # 状态统计：各状态占比 / 失败趋势（最近 7 天）
node growth.mjs list                   # 成长中心任务清单（只读）
node growth.mjs run                    # 报名 + 领已达标奖励 + Buddy 旅行
node growth.mjs run --dry-run          # 只预览
node tools/repair-state.mjs [账号名..]  # 修「登录成功但一直 401」的账号（不用重新登录）
node tools/repair-state.mjs --max-age 5 # 主动保活：距上次续期超过 5 天就提前续

# TraeWork 站点（签到走纯 HTTP；add/login 才用浏览器）
node trae.mjs list                     # TraeWork 账号 + 积分概览 + 登录态状态
node trae.mjs add <名字>               # 新增网页账号（弹浏览器登录一次）
node trae.mjs login <名字>             # 重新登录
node trae.mjs del <名字>               # 删除网页账号及其登录态
node trae.mjs checkin                  # 只签 TraeWork
node trae.mjs status                   # 只看状态，不领取
node trae.mjs doctor                   # 排查 TRAE 登录态 / 接口连通性

node dashboard.mjs                     # 启动看板（会开浏览器）
./install-daily.sh                     # 重装定时任务（可改时间）
./set-icon.sh navy                     # 换小猫图标
```

> `checkin` / `status` / `stats` / `list` 会**同时**处理两个站点。
> 指定账号名时按站点自动分流：只给 WorkBuddy 账号名 → TraeWork 跳过，反之亦然。
> 退出码 = 两个站点失败数之和（0 表示全成功）。

看板 REST 接口（`dashboard.mjs`）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/data` | 看板数据（含 `rate` 汇率、`configAccounts`） |
| `POST /api/run?cmd=checkin\|stats&names=` | 跑任务，返回 jobId |
| `GET /api/job/:id` | 任务输出（前端轮询） |
| `POST /api/account/add?name=&site=cn\|intl` | 新增并登录 |
| `POST /api/account/rename?from=&to=` | 改名（迁移登录态/缓存/统计） |
| `POST /api/account/delete?name=` | 删除账号 |
| `POST /api/traework/add?name=` | 新增/重新登录 TraeWork 网页账号（起 `trae.mjs add`，会弹浏览器） |
| `POST /api/traework/delete?name=` | 删除 TraeWork 网页账号（起 `trae.mjs del`） |

> `dashboard.mjs` 里 `spawnJob(script, args, label)` 是通用任务启动器，`runJob` → `checkin.mjs`、`runTraeJob` → `trae.mjs`。要再加站点就再加一个包装函数。

---

## 七、诊断工具（tools/）

| 脚本 | 用途 |
| --- | --- |
| `perf_site.mjs` | 测浏览器打开某页面的 CPU/请求数 |
| `perf_login_options.mjs` | 对比"首页 vs 登录页 vs Edge"的 CPU |
| `onscreen_test.mjs` | 对比窗口在屏幕内/外的 CPU（定位合成开销） |
| `login_step2.mjs` | 复现"登录页 → 点同意 → 扫码页"，看每步 URL/CPU |
| `price_dump.mjs` / `price_probe.mjs` | 抓官网定价页（积分↔人民币单价来源） |
| `banner_check.mjs` | 检查页面上的横幅/提示文案 |

---

## 八、建议的下一步（TODO）

1. **解决"同一账号多处登录"**：实现方案 C（复用用户 Chrome 登录态），或引导用户选 A/B
2. 看板增强：每日消耗曲线、按模型分类用量、导出 Excel/CSV
3. 签到失败自动重试 + 邮件/微信通知（目前只有 macOS 通知）
4. 账号 `1` 未登录，可清理
5. 若用户要长期用：把 `profiles/` 定期清理（每个账号的浏览器缓存会持续增长）

**TraeWork 相关（2026-09-24 新增后遗留）**：

6. ~~多账号支持~~ **已做**（2026-09-24）：新增网页登录来源，`node trae.mjs add <名字>` 可加任意多个账号。**尚未用真实账号跑通首次登录**——见下方"未验证项"。
7. **token 续期**：见 4.5 —— 有意未做，做之前必须先确认 refreshToken 是否允许并存，否则会把用户的桌面客户端踢下线。
8. **积分流水**：`/trae/api/v2/ug/credits/transactions` 等候选接口尚未验证（当前只用 `user_current_entitlement_list` 拿总额与权益包）。
9. **签到日历**：TraeWork 目前没有像 WorkBuddy 那样的热力图，`trae.mjs` 已在 `history` 里按天记录，前端可直接复用。

**未验证项（接手优先确认）**：

10. **网页来源的首次真实登录**。`add` 的浏览器拉起、轮询 `CheckLogin`、超时收尾都已实测通过（冒烟测试 15 秒正常退出）；但"用户登录成功 → 抓 Cookie → `GetUserToken` 换出令牌 → 调签到接口"这条链**还没用真实账号跑过**。第一次执行 `node trae.mjs add <名字>` 后请务必用 `node trae.mjs status <名字>` 验证。
    如果 `GetUserToken` 报 401，说明 Cookie 集合不够——检查 `cookieHeaderFor()` 的域匹配（`api.trae.cn` 需要 `.trae.cn` 域下的 Cookie）。

---

## 九、安全说明（重要）

- `accounts/*.state.json`（WorkBuddy）与 `accounts/*.trae.json`（TraeWork 网页登录）里都是**可直接登录该账号的 Cookie/令牌**，权限 600，**本交接包默认不含**
- `profiles/` 是完整浏览器配置（含 Cookie），体积大，同样**不含**
- **TraeWork**：工具**只读** TRAE 桌面客户端的 `storage.json`（含 `token` / `refreshToken` / `privateKeyPEM`），**不复制、不落盘、不写回**。`data/trae.json` 只存积分与签到结果，**不含任何凭据**。日志里 token 只打印长度和前后缀，不打印完整值。
  > 注意：`~/Library/Application Support/TRAE SOLO CN/` 本身是高敏感目录（等于账号登录权），任何打包/分享时都不要包含它。
- 需要"带凭证的完整包"时，在项目目录执行：
  ```bash
  zip -r workbuddy-checkin-完整包.zip . -x 'node_modules/*' 'logs/*' '*.zip'
  ```
  ⚠️ 该包等于把账号登录权交出去，只在完全可信的环境下传递
