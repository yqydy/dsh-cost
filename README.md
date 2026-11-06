# dsh-daily-cost —— DeepSeek 每日费用看板

在 DSH 的**会话标题栏（顶部）**显示今天花在 DeepSeek 上的钱，点一下弹出明细：分项 token、
高峰/空闲拆分、近 7 天、按模型。**实时**更新（宿主侧 `fs.watch` 增量折会话日志，界面每 15 秒取一次）。

> 源码仓库：<https://github.com/yqydy/dsh-cost>。开发目录就是仓库根目录，改完按「安装位置与文件」
> 一节复制回 profile 即可。

---

## 钱是怎么算出来的

### 数据来源：本机 session 日志

`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd`。每个 `assistant/message` 事件都带 provider 报的用量：

| 日志字段 | 含义 | 对应官方计费项 |
|---|---|---|
| `inputTokens` | 缓存**未命中**的输入 | `prompt_cache_miss_tokens` |
| `cacheReadTokens` | 缓存**命中**的输入 | `prompt_cache_hit_tokens` |
| `outputTokens` | 输出 | 输出 token |
| `cacheWriteTokens` | 缓存写入 | **不计费**（DeepSeek 没有写入费/存储费） |

事件自带的 `time` 决定它属于哪一天，以及当时算高峰还是空闲；同一会话里最近的
`request/header.config.model` 决定用哪一档价格。

> 为什么不用会话投影：投影（`tokenUsage`）是**单会话累计**、没有时间戳，回答不了「今天花了多少」；
> 而「今天」天然跨会话（主会话 + 子代理 + 其它窗口）。持久 session 日志是唯一同时带时间戳与
> 用量的真相来源。

### 价格：DeepSeek 官网现行价目

来源 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（2026-09-10 04:00 UTC 起），
单位 **元 / 百万 tokens**，下表是**高峰价**：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | 0.04 | 2 | 8 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro-0813，官方已标注逐步下线） | 0.30 | 9 | 27 |

规则（与官网一致）：

* **空闲价 = 高峰价 × 0.5**；
* **高峰** = 北京时间**周一至周五** `09:00-12:00`、`14:00-18:00`（不含法定节假日）；
  其余时段、周末、节假日**全天**为空闲；
* 费用 = Σ(各计费项 token 数 × 对应单价) ÷ 1e6，**逐次调用**按当时所属时段计价；
* 没有起步价、按次费、阶梯价，也没有缓存写入费。

旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会自动按 Flash 价计。
**其它 provider / 模型**（例如走 newapi 中转的）不在官方价目表里，会以 `priced: false` 单列出来，
金额按 0 计——看到这一行说明有未定价的调用。

### 日界与时段

一律按**北京时间（UTC+8）**。中国大陆不实行夏令时，所以是精确的固定偏移，与本机时区设置无关。

---

## 界面

* **胶囊**：会话标题栏右侧 `今日 ¥17.68`。取不到数据时显示 `—`。
* **点开**：下方弹出浮层（绝对定位，**不占布局、不推动输入框**）：
  今日金额与调用次数、未命中/命中/输出 token、缓存命中率、高峰/空闲拆分、
  近 7 天柱状（深色=高峰、浅色=空闲）、按模型明细表、价格与时段规则说明。
* **收起**：点浮层外任意处，或按 `Esc`。
* 文案跟 `<html lang>` 在中文/英文之间切换。

---

## 配置

改 `<profile>/cordis.patch.yml`（profile 通常是
`%APPDATA%\dsh-desktop-plus\harness\profiles\web`）。loader 语义是 **config 整体替换**，
所以要把想改的键写全：

```yaml
- id: dsh-daily-cost-host
  name: 'dsh-daily-cost-host'
  config:
    currency: CNY            # CNY | USD（USD 用官网英文页的独立价目，不做汇率换算）
    offPeakDiscount: 0.5     # 空闲价 = 高峰价 × 该系数
    peakWindows: [[540, 720], [840, 1080]]   # 高峰窗口，单位：北京时间的分钟 [起, 止)
    holidays: ['2026-10-01', '2026-10-02']   # 法定节假日（全天算空闲），默认空
    prices:                  # 覆盖/补充价目（按高峰价给，单位 元/百万 tokens）
      deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
    extraSessionRoots: []    # 额外的 sessions 根（比如 ~/.dsh/sessions）
    retainDays: 120          # 账本保留天数
    refreshMs: 20000         # 兜底轮询间隔；实时性主要靠 fs.watch
    defaultDays: 30          # 接口默认返回多少天
    writeSummaryFile: true   # 是否落盘快照
```

改完保存即可：HMR 会重新组合 profile。**注意**：宿主半边的 js 由 Node 按 URL 缓存，
改 `host.js` 这类宿主代码后要**重启应用**才会生效（见下文「改动与更新」）。

> loader 的语义是 **config 整体替换**，但你**不必把全部键写全**：`host.js` 的
> `normalizeConfig` 对缺失键一律回退到内置默认值。所以只想改节假日时，
> 配置里只写 `holidays` 即可，价格表 / 高峰窗口 / 扫描根 / 折扣都保持默认。

### 当前生效的配置（2026-10-16 填入）

**`holidays` 已填入 2026 年全部法定节假日（33 天）**，含周末那些天（周末本来就按空闲计，
列出只是为了让读数自解释）。来源：国办发明电〔2025〕7 号
<https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>。

列入的具体日期：

| 节日 | 放假日 | 其中按工作日（会被这条配置改变计价） |
|---|---|---|
| 元旦 | 01-01 ~ 01-03 | 01-01（四）、01-02（五） |
| 春节 | 02-15 ~ 02-23 | 02-16（一）~ 02-20（五）、02-23（一） |
| 清明 | 04-04 ~ 04-06 | 04-06（一） |
| 劳动节 | 05-01 ~ 05-05 | 05-01（五）、05-04（一）、05-05（二） |
| 端午 | 06-19 ~ 06-21 | 06-19（五） |
| 中秋 | 09-25 ~ 09-27 | 09-25（五） |
| 国庆 | 10-01 ~ 10-07 | 10-01（四）、10-02（五）、10-05（一）~ 10-07（三） |

**调休上班的周末不列入**（01-04、02-14、02-28、05-09、09-20、10-10）：它们不是节假日，
按周六/周日算空闲本来就正确 —— 调休上班那天 DeepSeek 官方的空闲时段也确实是从 00:00 起算的。

**2027 年的安排国务院尚未发布**（通常每年 11 月发通知），发布后把日期追加进
`holidays` 数组即可；在那之前 2027 年的节假日会按高峰计价（偏贵一倍）。

配置落在 profile 的 patch 层：`%APPDATA%\dsh-desktop-plus\harness\profiles\web\cordis.patch.yml`
的 `- id: dsh-daily-cost-host` 一节（该文件里还写了官方来源与调休说明，便于日后维护）。

---

## 取值接口与快照

* `GET /api/dsh-daily-cost/summary?days=30[&refresh=1]` —— 浏览器半边用的 JSON（同源、带
  Connection 的 cookie 认证）。字段：`today` / `yesterday` / `last7` / `last30` / `all` /
  `days[]` / `models[]` / `prices` / `peakRule` / `scan` / `route`。
* `<DSH_HOME>/dsh-daily-cost/summary.json` —— 同一份内容的落盘快照，任何变化后重写（原子写）。
  排查问题先看它：`scan.lastError` 有没有错、`route.registered` 是不是 true。

用带 cookie 的探针直接问接口（本机自用；脚本不打印任何密钥）：

```powershell
node tools/api-probe.cjs
```

---

## 自检

```powershell
node test/run.mjs       # 宿主半边：把真实会话日志折一遍，并与一份独立实现逐日比对
node test/client.mjs    # 浏览器半边：用真 React + react-dom/server 渲染 5 种情形
node test/holidays.mjs  # 节假日计价：同一批日志折两遍（含/不含「今天」为节假日），金额应恰好 ×0.5
```

`test/holidays.mjs` 是**对照实验**，验证的不只是「配置被读到」，而是「配置真的改变了计价」：
同一批真实日志，A 不列任何节假日、B 把今天列为节假日 —— 今日金额应当恰好减半、
token 数与调用数分毫不动、peak/offPeak 归属对调。实测（2026-10-16）：

```
A 不列节假日 : cost 2.8211  peak 2.8211  offPeak 0
B 列为节假日 : cost 1.4106  peak 0       offPeak 1.4106
```

> 金额是快照里 `round(cost, 4)` 的量化值，所以该脚本的容差是 1e-3（断言「恰好减半」，
> 不是「逐位相等」）。

`test/run.mjs` 的判据是**差分**：今天以前的每一天必须与独立实现（正则提取、逐帧处理，
与宿主的「前缀快判 + 花括号配对」是两条不同路径）**逐字节一致**；今天允许有偏差
（两份读数之间还在写入），但插件不能多算。

---

## 安装位置与文件

装在这个 profile 里（`install_bundle` 的等价手工步骤）：

```
%APPDATA%\dsh-desktop-plus\harness\profiles\web\
├─ package.json                      # dependencies + dsh.profile.bundles 含 dsh-daily-cost-host
├─ cordis.patch.yml                  # 该插件的 config 覆盖行（可选）
└─ node_modules\dsh-daily-cost-host\
   ├─ package.json                   # dsh.bundle.patch + dsh.client（platform=web）
   ├─ cordis.patch.yml               # insert: 插件行
   ├─ host.js                        # 宿主半边：折账 + 价格 + /api 路由
   ├─ index.js                       # 包根入口（转发到 host.js）
   ├─ client.js                      # 浏览器半边：标题栏胶囊 + 浮层
   ├─ locale\{zh,en}.json            # 插件列表里的标题/说明
   ├─ icon.svg                       # 插件图标
   ├─ test\                          # 自检
   └─ tools\                         # patch-profile / set-config / recompose / api-probe
```

源码仓库：<https://github.com/yqydy/dsh-cost>（本机开发目录即仓库根目录），改完复制进上面的目录即可。

### 当前这台机器上的安装坐标（2026-10-16 装于 DSH Desktop Plus）

```
DSH_HOME  = C:\Users\20862\AppData\Roaming\dsh-desktop-plus\harness
profile   = %DSH_HOME%\profiles\web
插件目录  = %DSH_HOME%\profiles\web\node_modules\dsh-daily-cost-host
应用      = E:\xiazai\ykdsh\DSH\DSH Desktop Plus.exe
```

手工安装三步（不需要 pnpm，Plus 自带的 harness 会在线重新组合）：

1. 复制 `index.js` `host.js` `client.js` `package.json` `cordis.patch.yml` `icon.svg`
   `locale\` `README.md` 到上面的插件目录；
2. 把插件登记进 `profiles\web\package.json`：
   `dependencies['dsh-daily-cost-host'] = 'file:node_modules/dsh-daily-cost-host'`
   且 `dsh.profile.bundles` 末尾追加 `'dsh-daily-cost-host'`（等价于 `tools/patch-profile.cjs`）；
3. 跑 `tools/recompose.cjs` 刷新 profile patch 末尾的时间戳注释触发重新组合。

**不需要重启应用**：实测这三步做完，宿主半边在几秒内挂上（快照开始更新），
客户端 bundle 也进了首页的 `__DSH_BOOT__` 注入表。

验证（任一条通过即说明两边都活着）：

* `%DSH_HOME%\dsh-daily-cost\summary.json` 开始更新，`route.registered = true`、`scan.lastError = null`；
* 首页 `__DSH_BOOT__.entries` 里出现 `{"id":"dsh-daily-cost-host","url":"plugins/??dsh-daily-cost-host/client.js&rev=…"}`；
* 带会话 cookie 请求 `GET /api/dsh-daily-cost/summary?days=7` 返回 200（未知路径返回 404 可作对照）。

> `test/client.mjs` 里的 React 取自捆包运行时。旧版路径是
> `E:\xiazai\ykdsh\DSH\resources\app\node_modules`；新捆包里没有 react，
> 所以跑之前要显式给：`$env:DSH_APP_MODULES = 'E:\xiazai\ykdsh\DSH\resources\app\node_modules'`。
> 宿主自检 `test/run.mjs` 不需要任何外部依赖。

### 改动与更新

| 改了什么 | 怎么生效 |
|---|---|
| `client.js`（界面） | 复制过去 → 跑 `node tools/recompose.cjs <profile>/cordis.patch.yml` → 刷新页面 |
| `locale\*.json` / `icon.svg` | 同上（插件列表显示） |
| `host.js`（宿主逻辑） | **需要重启应用**：Node 的 ES 模块缓存按 URL 生效，进程内无法换代码 |
| 配置（`config`） | 直接存盘，HMR 会重挂该行 |

> `node_modules` 里的文件不在 HMR 监听范围内；`tools/recompose.cjs` 通过在 profile patch
> 末尾维护**一行时间戳注释**来触发重新组合（内容一变就重载），顺便清掉历史遗留注释。

### 为什么包名是 `dsh-daily-cost-host`

宿主半边的 js 与包清单（`exports`）在 Node 里都按路径缓存，所以「同一个包名换入口文件」
在**不重启进程**的情况下拿不到新代码。用一个新的、从没被解析过的包名才能真正加载到新实现——
这就是安装时那次 `dsh-daily-cost` → `dsh-daily-cost-host` 重命名的原因。名字只影响内部标识，
界面上的标题来自 `locale/*.json`（「DeepSeek 每日费用」）。

---

## 已知限制

* **`holidays` 默认为空**：中国法定节假日需要自己按 `YYYY-MM-DD` 填（API 的 `peakRule.holidays`
  会回显当前生效的清单）。填之前，节假日里的那 6 个小时会按高峰（2 倍）计价。
* **只统计 provider 真的报了用量的调用**：失败/中断、最终没落 `assistant/message` 的尝试不计。
  日志里每个 `assistant/message` 记一次（含重试的多次尝试）。
* **未定价模型按 0 计**并单独列出（`priced: false`）。
* **历史区间**：日志文件存在就能重算；`retainDays` 只限制内存账本保留多久。
* 价格取自官网现行价目，官方调价后请同步 `prices`。
