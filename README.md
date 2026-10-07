# WorkBuddy + TraeWork 每日自动签到 + 积分看板（多账号 / 双站点）

- 每天定时为多个账号自动签到领积分：
  - **WorkBuddy**（国内版 `workbuddy.cn`）：每日签到 +100 积分，需先用浏览器登录一次
  - **TraeWork**（`work.trae.cn` / `api.trae.cn`）：每日签到 +100~200 积分，**零配置**——直接复用本机 TRAE 桌面客户端的登录态
- 自动统计：账号数量、每个账号**剩余积分**、**已用积分**、连续签到、资源包明细
- 自带可视化看板（本地网站），双击即开，两个站点的数据在同一张表里

> ## ⚠️ 免责声明（用之前请读）
>
> 本项目是**个人自用工具**，通过模拟浏览器会话调用第三方平台的公开接口，**不是官方工具**。
>
> - **可能违反平台服务条款。** 使用自动化脚本操作账号存在被平台限制或封禁的风险，
>   请自行评估。作者不对任何账号损失负责。
> - **登录态存在本机。** `accounts/*.state.json` 里是完整的会话凭据（等价于你的登录密码），
>   **已被 `.gitignore` 排除，绝对不要提交、不要分享、不要放进云盘。**
> - **本项目刻意不做的事**：不伪造任何「行为事件」去刷成长中心的任务进度。
>   任务进度由服务端依据真实行为点亮，伪造上报等于骗平台积分。详见 `growth.mjs` 头部注释。
> - 仅供学习交流。请遵守你所在地区的法律法规与平台规则。

## 一、先登录每个账号（只需一次）

终端里执行（`主号` 换成你的账号备注名）：

```bash
cd "~/workbuddy-checkin"
node checkin.mjs add 主号
```

会弹出浏览器 → 登录 WorkBuddy（国内版 `workbuddy.cn`）→ 登录成功后窗口自动关闭并提示「登录成功」。

再加第二个、第三个账号，重复执行即可：

```bash
node checkin.mjs add 小号1
node checkin.mjs add 小号2
```

> 默认走国内版 `www.workbuddy.cn`。确有国际版账号才需要加 `--site intl`。

### 第二个站点：TraeWork CN（支持多账号）

TraeWork 的签到**不需要**在 WorkBuddy 那边加账号，有两种账号来源：

**来源 ①：TRAE 桌面客户端（自动，零配置）**

只要 TRAE CN 桌面客户端处于登录状态，`checkin` / `status` / `stats` / `list` 就会自动带上它。
**全程只读**，不修改 TRAE 的任何文件。
> 局限：一个桌面客户端同时只登录一个账号，所以这条路**只能覆盖 1 个账号**。

**来源 ②：网页登录（想签几个就加几个）**

**方式一：在看板上点按钮（推荐）**

打开看板 → 右上角 **「＋ 添加 TraeWork 账号」** → 填备注名 → 「开始登录」→ 弹出浏览器，点右上角「登录」完成登录 → 窗口自动关闭、账号出现在列表里。

每个 TraeWork 账号在列表里都有 **重新登录 / 删除** 按钮，不用碰终端。

**方式二：命令行**

```bash
node trae.mjs add 小号1      # 弹出浏览器 → 你登录一次 → 自动保存登录态
node trae.mjs add 小号2
node trae.mjs add 小号3
```

每个账号**只需登录一次**。之后日常签到**不会再开浏览器**——工具用保存的 Cookie 现换令牌调接口。

```bash
node trae.mjs list                   # 账号列表 + 积分概览
node trae.mjs checkin                # 只签 TraeWork（全部账号）
node trae.mjs checkin 小号1           # 只签指定账号
node trae.mjs status                 # 只看状态，不领取
node trae.mjs login 小号1             # 登录态失效时重新登录
node trae.mjs del 小号1               # 删除账号及其登录态
node trae.mjs doctor                 # 排查登录态 / 接口
```

> **两种来源的区别**
> | | 桌面来源 | 网页来源 |
> | --- | --- | --- |
> | 配置成本 | 零（自动发现） | 每个账号登录一次 |
> | 账号数量 | 只能 1 个 | 不限 |
> | 登录态有效期 | 约 14 天，靠客户端续期 | Cookie 由服务端定，失效时提示重新登录 |
>
> **桌面来源的续期注意**：token 约 14 天过期，由桌面客户端自己续期。本工具**故意不主动续期**——续期接口会轮换 `refreshToken`，抢先调用可能让你在 TRAE 客户端上被迫重新登录。所以 `list` 显示「🟡 登录态 N 天后过期」时，**打开一次 TRAE CN 客户端**即可。
>
> 想关掉整个站点：把 `config.json` 里 `traework.enabled` 改成 `false`。

## 二、看板（可视化）

**推荐：用桌面 App 打开** —— 已安装到「应用程序」：

- 打开方式：`访达 → 应用程序 → WorkBuddy积分`（或按 ⌘空格 搜「WorkBuddy积分」）
- 首次打开后，在程序坞图标上右键 → 选项 → **在程序坞中保留**，以后点一下就能用
- 它是独立窗口、没有地址栏，和原生 App 一样；会自动确保后台数据服务在运行
- 应用文件：`~/Applications/WorkBuddy积分.app`（源码副本在项目 `build/` 里，可重新生成）

其他打开方式：

- 双击项目里的 `看板.command`
- 命令行 `node dashboard.mjs`（会自动打开浏览器）
- 直接访问 `http://127.0.0.1:8787/`（后台服务常驻，开机自启）

看板是**蓝白亮色主题**（顶部小猫 Logo、区块爪印、纯白卡片 + 蓝色渐变，没有黑色背景）。

看板包含：

| 区域 | 内容 |
| --- | --- |
| 顶部卡片 | WorkBuddy：账号数、今日已签到数、剩余积分合计、已用积分合计、累计签到领取（带「积分」单位 + **核算成人民币**）；另有独立的 **TraeWork 积分** 卡片 |
| 各账号积分 | 每个 WorkBuddy 账号「剩余 / 已用」对比条（占满整行），右侧显示积分数与折合人民币 |
| 账号明细表 | 账号、昵称、站点、剩余、已用、连签天数、今日状态、更新时间。WorkBuddy 行可 **改名 / 重新登录 / 删除**；TraeWork 网页账号行可 **重新登录 / 删除**；TraeWork 桌面来源行标注「由 TRAE 客户端管理」 |
| 点开某账号 | WorkBuddy：最近 9 周签到热力图 + 资源包明细（每日免费额度 / 权益赠送 / 付费包）+ 每日记录；TraeWork：权益包明细 + 签到记录 |

> TraeWork 与 WorkBuddy 是两套独立的积分体系，**不混算**：TraeWork 积分不参与人民币折算，也不计入 WorkBuddy 的合计。

### 积分换算人民币

按官方定价表折算，默认单价 **¥0.02 / 积分（50 积分 ≈ ¥1）**，来源：

| 套餐 | 价格 | 每月积分 | 单价 |
| --- | --- | --- | --- |
| 标准版 | ¥99（现价 ¥70） | 4,000 | ¥0.0248（现价 ¥0.0175） |
| 高级版 | ¥199（现价 ¥140） | 9,000 | ¥0.0221（现价 ¥0.0156） |
| 旗舰版 | ¥999（现价 ¥700） | 50,000 | ¥0.0200（现价 ¥0.0140） |

想按现价折算（约 ¥0.014）就把 `config.json` 里的 `creditToYuan` 改成 `0.014` 即可，看板立即生效。
| 最近运行日志 | 最近一次签到的执行结果 |

看板上的按钮：

- **立即签到全部账号**：立刻跑一次批量签到，完成后自动刷新数据
- **只刷新数据**：不签到，只采集最新余额/用量

### 在界面里添加账号（不用碰终端）

打开看板 App，点右上角 **「＋ 添加账号」**：

1. 填一个备注名（比如「小号1」）
2. 选站点（默认国内版 workbuddy.cn）
3. 点「开始登录」→ 会自动弹出一个浏览器窗口 → 在里面登录 WorkBuddy
4. 登录成功后自动关闭窗口、读取积分数据，账号立刻出现在列表里

账号列表右侧每行还有 **「重新登录」** 按钮，登录过期时点它即可，无需终端命令。

![添加账号](~/workbuddy-checkin/docs/界面-添加账号.png)

### 换图标（猫）

内置三款手绘小猫图标，一条命令切换（App 图标 + 网页图标同时更新）：

```bash
./set-icon.sh orange   # 橘白小猫（当前）
./set-icon.sh navy     # 深蓝小猫
./set-icon.sh cream    # 黑猫粉底
```

图标源文件在 `build/cat/`（SVG 生成脚本 `build/cat/gen.mjs`，可自行改颜色重新生成）。
若程序坞仍显示旧图标：把它从程序坞拖走再重新添加一次即可（macOS 图标缓存）。

## 三、每天自动跑（已装好）

macOS 定时任务，**每天 09:05** 自动签到，**14:30 再补一次**（已签到会自动跳过；Mac 睡眠错过时间、唤醒后也会补跑），完成后弹系统通知。

实际入口是 `daily-checkin.sh`，它做三件事：**等网络就绪** → **按需续期登录态**（`--max-age 5`，
距上次续期超过 5 天就主动续，不等失效）→ **签到**。
所以唤醒后立刻补跑不会因断网整批失败，登录态也不会周期性到期，不需要你干预。

```bash
./install-daily.sh      # 重新安装 / 改时间（改脚本里的 HOUR_PRIMARY 等变量）
./uninstall-daily.sh    # 卸载
tail -f logs/checkin-$(date +%F).log     # 看日志
```

## 三之二、成长中心任务（Buddy / 任务奖励 / 旅行）

除了每日签到，官网「成长中心」还有一批任务奖励（体验某某功能、领取 Buddy 等）和 Buddy 旅行。
`growth.mjs` 会帮你**自动收下已经赚到的**，并把没报名的任务先报上。

```bash
node growth.mjs list            # 看任务清单（只读，不点任何东西）
node growth.mjs guide           # 待办清单：还差什么、点哪去、值多少积分
node growth.mjs run             # 报名未报名的任务 + 领取已达标奖励 + Buddy 旅行
node growth.mjs run --dry-run   # 只预览要做什么
```

`guide` 会把没做完的任务列出来，附上客户端 deep link（`workbuddy://chat` 之类），
点一下直达。**做完后跑 `run`，奖励自动收下来。** 实测 16 个任务合计 **1550 积分 ≈ ¥31**。

`daily-checkin.sh` 已把它串进去。可用 `config.json` 的 `growth.enabled` 关掉。

### ⚠️ 这个模块刻意不做的事

**不伪造任何行为事件刷进度。**

成长中心的任务进度由服务端依据**真实行为**点亮——创建画布、装技能、召唤专家、用特定模型对话、
关注公众号满 24 小时……**必须真的做了才会 0→1**。

网上有项目（如 `workbuddy2api-panel` 的 `scripts/task_chat5.py`）直接构造
`{"eventCode":"chat_request_send",...}` 上报，谎报用户聊过天来骗任务奖励。
**那是伪造数据骗平台积分（积分按 0.02/分折算成钱），本项目不实现，也不建议你用。**

> 这个边界是刻意的，不是"暂时没做"。HANDOFF 4.6 节有完整说明。
> 如果你哪天想加这个功能：请先想清楚，这是拿脚本替用户向平台说假话换钱。

所以本模块只做两件正当的事：

| 动作 | 说明 |
| --- | --- |
| **报名（accept）** | 部分任务的进度**从报名后才开始计**。提前报名，你正常使用产品时进度才会自然积累 |
| **领奖（claim）** | 只领**进度已达标**的任务 —— 也就是你确实已经完成、但还没领的那些 |

外加 Buddy 旅行这类纯站内游戏机制。

> 实测效果：`账号D` 一次性领到了「领取一只 Buddy」**+300 积分 +8 能量**——
> 那是它之前真的用过、进度满了却一直没领的奖励。

### 接口（2026-10-02 真实账号实测）

| 用途 | 路径 |
| --- | --- |
| 任务列表 | `GET /v2/activity/growth/tasks` |
| 报名 | `POST /activity/growth/tasks/accept` ← **不带 `/v2`，带 `/v2` 会 401** |
| 领奖 | `POST /activity/growth/tasks/<task_code>/claim` |
| 旅行状态 / 配置 / 派出 / 领奖 | `/activity/growth/buddy/travel/{status,config,depart,claim}` |

`depart` 必须带 `{"location_id":N}`（地点从 `travel/config` 拿），只传 `{}` 会 400 `invalid request`。
鉴权只用保存的 Cookie，需带 `x-client-platform: web`。

---

## 四、常用命令

```bash
node checkin.mjs checkin          # 全部账号批量签到（含 TraeWork）
node checkin.mjs checkin 主号      # 只签到某账号
node checkin.mjs status           # 只看状态（不领取）
node checkin.mjs stats            # 只采集积分/用量数据（看板用）
node checkin.mjs list             # 账号列表 + 余额概览（含 TraeWork）
node checkin.mjs report 7         # 状态统计：各状态占比 / 失败趋势（最近 7 天）
node growth.mjs list              # 成长中心任务清单（只读）
node growth.mjs run               # 成长中心：报名 + 领已达标奖励 + Buddy 旅行
node checkin.mjs login 主号        # 登录过期时重新登录
node checkin.mjs doctor 主号       # 排查登录/接口问题

node trae.mjs add 小号1            # 新增 TraeWork 网页账号（弹浏览器登录一次）
node trae.mjs checkin             # 只处理 TraeWork 站点
node trae.mjs list                # TraeWork 账号 + 积分概览
node trae.mjs doctor              # 排查 TRAE 登录态
```

> 只指定 WorkBuddy 账号名时，TraeWork 会自动跳过（反之亦然），两个站点互不干扰。

### 签到结果通知（可推到飞书 / 企业微信 / 钉钉）

默认只发 macOS 系统通知。想推到群里，在 `config.json` 加通道即可：

```json
"notify": {
  "enabled": true,
  "onlyOnFailure": false,          // true = 只有出现失败账号时才发
  "channels": [
    { "type": "macos" },
    { "type": "feishu",   "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" },
    { "type": "wecom",    "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" },
    { "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx", "secret": "可选，加签用" }
  ]
}
```

支持的通道：`macos` / `feishu` / `wecom` / `dingtalk` / `generic`（任意 webhook）/ `stdout`。

> **通知失败不会影响签到**——每个通道独立超时（10 秒）+ 异常捕获。
> 另外飞书/企微/钉钉出错时 HTTP 仍是 200，本工具会读 body 里的 `code`/`errcode` 判断真实结果。

## 五、原理与数据结构

调用 WorkBuddy 客户端的计费接口（走 `/v2` 网关）：

| 用途 | 接口 |
| --- | --- |
| 签到活动状态 | `POST /v2/billing/meter/checkin-activity-status` |
| 执行签到 | `POST /v2/billing/meter/daily-checkin` |
| 余额/总量聚合 | `POST /v2/billing/meter/get-user-resource-summary` |
| 免费包明细（含每日签到赠送） | `POST /v2/billing/meter/get-user-resource-free-packages` |
| 付费包明细 | `POST /v2/billing/meter/get-user-resource-paid-packages` |

取数方式按 3 级降级：**① 轻量请求**（用上次登录保存的 Cookie/令牌）→ **② 浏览器模式**（无头浏览器以页面同源身份调用，自动带完整登录态与 SSO 令牌）→ **③ 抓包兜底**（`--params <curl 文本或文件>`）。

文件说明：

```
config.json            账号配置（登录站点、traework 开关等）
checkin.mjs            WorkBuddy 主脚本 + 统一入口
trae.mjs               TraeWork 站点模块（签到走纯 HTTP，只有 add/login 用浏览器）
accounts/*.state.json  WorkBuddy 登录态（600 权限，仅本机）
accounts/*.trae.json   TraeWork 网页登录态（Cookie，600 权限，仅本机）
profiles/              每个账号的浏览器配置（WorkBuddy 与 TraeWork 各用各的）
data/state.json        看板数据源（WorkBuddy：余额、用量、签到历史）
data/trae.json         看板数据源（TraeWork：总积分、权益包、签到历史）
logs/                  运行日志
```

### TraeWork 站点原理

**不启动浏览器**（除 `add` / `login` 时的一次性登录），日常全程纯 HTTP。两种来源最终都收敛到同一个鉴权头：

```
① 桌面来源：从 storage.json 解出 token
② 网页来源：POST /cloudide/api/v3/common/GetUserToken（带 Cookie）→ Result.Token
        ↓
Authorization: Cloud-IDE-JWT <Token>
```

桌面来源的登录态位置：

```
~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json
  ├─ iCubeAuthInfo://icube.cloudide       → token / refreshToken / userId / host
  └─ iCubeAuthInfo://icube-dc:<machineId> → privateKeyPEM / publicKeyPEM
```

两个键都是 **AES-128-CBC 信封加密**，密钥由密文前 32 字节经 SHA-512 派生，**与硬件绑定无关**（所以 macOS / Windows 同一套算法）。

| 用途 | 接口 |
| --- | --- |
| 登录检测 | `POST https://api.trae.cn/cloudide/api/v3/trae/CheckLogin` |
| 换令牌（网页来源） | `POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken` |
| 签到状态 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` |
| 执行签到 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim` |
| 积分权益明细 | `POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list` |

请求头：`Authorization: Cloud-IDE-JWT <token>`，并按账号带独立的 `x-device-id`。

> **为什么必须一账号一 deviceId**：TraeWork 的领取接口按 `x-device-id` 做「一设备一天一次」拦截。多个账号共用同一个 deviceId 时，只有第一个能成功、其余全被拒。所以工具给每个账号生成**稳定且唯一**的设备号（网页来源在添加时生成一次并固定下来）。**稳定很关键**——若每天换设备号，等于绕过每日限制，属于滥用。
>
> 另外：工具**只在「今日未签到」时才调用领取接口**，已签到直接跳过，不会重复领取。

### TraeWork 登录态失效怎么办

| 来源 | 表现 | 处理 |
| --- | --- | --- |
| 桌面 | `list` 显示「🔴 登录态已过期」或「🟡 N 天后过期」 | 打开一次 TRAE CN 客户端（它会自动刷新），工具随即恢复 |
| 网页 | `list` 显示「🔴 登录态已失效」 | `node trae.mjs login <名字>` 重新登录一次 |

### 登录为什么这么快了（性能说明）

登录窗口以前是从**官网首页**进，那个页面有 117 个请求、空闲也要烧 25% CPU；现在**直接打开登录页** `/login/`，只有 42 个请求、CPU 约 5%：

| 打开方式 | 请求数 | 空闲 CPU |
| --- | --- | --- |
| 官网首页（旧） | 117 | 25.1% |
| **登录页（现在）** | 42 | **4.8%** |
| 登录页 + Edge | 42 | 2.5% |

（顺带验证过：禁用页面动画对 CPU 几乎没影响，所以不是动画、也不是你 Chrome 的扩展问题。）

换浏览器：在 `config.json` 里加 `"browser": "edge"`（可选 `auto` / `chrome` / `edge` / `chromium`），或临时用环境变量：

```bash
WBC_BROWSER=edge node checkin.mjs login 账号名
```

> Safari 不行：自动化引擎驱动不了真正的 Safari App（只能用它的内核另开一个浏览器，反而没有浏览器的会话优势）；Chrome / Edge 都是 Chromium 内核，兼容性一致。

另外：登录页会提前写入 Keycloak 的流程 Cookie，所以"是否登录成功"现在只认业务会话 `session` / `session_2`，不会再误判。

## 六、常见问题
**登录时浏览器很卡？** 这不是工具本身的问题，是 WorkBuddy 网页很重。实测（M1）：

| 状态 | CPU |
| --- | --- |
| 浏览器空页面 | 0.4% |
| 打开 workbuddy.cn 首页后（静止不动） | ~25% |
| 整页加载 | 5~7 秒、约 140 个请求 |

已经做的优化：

- 优先使用系统已装的 Google Chrome / Edge（比内置 Chromium 启动更快、实测更省 CPU）
- 登录时屏蔽广告/埋点域名（doubleclick、googletagmanager、腾讯埋点等）
- 工具自身轮询改成「只读 Cookie、不执行页面脚本」，不再和页面抢主线程
- 每个账号的浏览器缓存会保留，第 2 次以后登录不用再重新下载

建议：登录时把其它 Chrome 窗口先关掉（同时渲染同一页面会明显更卡）；登录窗口只需开十几秒。

> 日常自动签到**不会启动浏览器**（走纯接口），所以这种卡顿只出现在「添加账号 / 重新登录」时。
> 如果怀疑屏蔽埋点影响了登录，加环境变量 `WBC_ALLOW_TRACKERS=1` 可放行重试。


**提示「登录态不可用」**：先别急着重登，试试修复（多数情况不用重新扫码）：

```bash
node tools/repair-state.mjs 账号名
```

它会用无头浏览器加载一次站点、让会话完成续期后重新保存登录态，修复前后都会实调接口验证。

> **为什么会出现**：WorkBuddy 的业务会话 `session` / `session_2` **只有 7 天有效期**，而 SSO 身份
> Cookie 有 1 年。连续 7 天只用纯 HTTP 签到、不开浏览器，业务会话就会到期（表现为「登录已过期」）。
> 用浏览器访问一次站点即可静默续上，**不需要重新扫码**。
>
> **这个已经自动化了**：每日任务入口 `daily-checkin.sh` 会先跑一遍修复再签到，
> 所以正常情况下你不会再看到这个问题。详见 HANDOFF 第五节第 1b 条。

**如果修复也无效**：说明登录态真的过期了，执行 `node checkin.mjs login 主号` 重新登录。

**TraeWork 提示「未发现 TRAE 登录态」**：本机 TRAE CN 桌面客户端没登录（或刚换了账号）。打开客户端登录一次即可；如果你要签多个账号，用 `node trae.mjs add <名字>` 走网页登录。

**TraeWork 网页账号提示「登录态已失效」**：`node trae.mjs login <名字>` 重新登录一次即可。Cookie 失效是正常的，服务端会定期让它过期。

**TraeWork 签到报「设备」相关错误**：说明 `x-device-id` 被判重。检查 `config.json` 的 `traework.disabled` 是否误写了账号；也**不要**手工改 `accounts/*.trae.json` 里的 `deviceId`（工具已保证每账号唯一且稳定）。

**看板没数据**：先 `node checkin.mjs stats`（或勾看板上的「只刷新数据」）。

**想排查登录/接口**：

```bash
node checkin.mjs doctor --headed 主号
```

会打印当前站点、Cookie 名称、本地存储键、各域名接口返回码，方便定位。

### 界面主题

- 蓝白亮色配色，白色卡片 + 蓝色渐变主色，无深色/黑色底
- 小猫元素：顶部小猫 Logo（矢量绘制）、区块标题爪印、页面右下角爪印水印、弹窗标题 🐱
- 想连 App 图标也换成蓝色小猫：`./set-icon.sh navy`
