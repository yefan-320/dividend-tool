# 红利工具

> 线上版（手机可直接打开，不依赖本机服务）：**https://yefan-320.github.io/dividend-tool/**

本地离线的 A 股红利工具：全市场股息率扫描、个股决策、组合回测（组合 / 个股 / 对比）、持仓账本。纯静态站点，无构建、无后端，所有数据在本地。

> 原工具在 `../repo/`，**只读、不改**（只作为功能参考与历史分红/池子数据来源）。本目录是全新实现，运行在 8766 端口；localStorage 与原工具隔离（不同 origin）。

## 运行

**本机（推荐，双击）**：打开桌面文件夹 `红利/`，双击 **`打开红利工具.command`** —— 自动起本地服务并打开浏览器；用完双击 `停止红利工具.command`。

> 第一次双击若提示"无法验证开发者"，右键 → 打开 → 仍要打开 一次即可。

**手机看（同一 Wi-Fi）**：双击 **`手机访问.command`**，会打印 `http://<Mac局域网IP>:8766`，手机连同一个 Wi-Fi 直接打开。

**手机在外面看**：两种方式（见下方「手机访问」）：
- 临时：`brew install cloudflared`，然后 `cloudflared tunnel --url http://127.0.0.1:8766`，把打印的 `https://xxx.trycloudflare.com` 在手机打开（Mac 需开机）；
- 永久：把 `红利工具/` 部署到 Cloudflare Pages / GitHub Pages（纯静态，无账号也做不了，需要你的一次性操作）。

**命令行**：

```bash
cd 红利工具
python3 -m http.server 8766
# http://127.0.0.1:8766
```

> 为什么不能直接双击 index.html？新版是 ES 模块 + fetch，浏览器在 `file://` 下会拦截本地 JSON（旧版是 `<script>` 直加载的 JS 数据所以能双击）。需要本地 HTTP 服务。

## 手机访问

**已部署：`https://yefan-320.github.io/dividend-tool/`（GitHub Pages，手机直接打开，不依赖 Mac / 本机服务）**

更新线上版本（**不需要再授权**）：

1. 双击 `../部署到GitHub.command`，或 `cd 红利工具 && git push origin main`；
2. GitHub Pages 自动重建，1–2 分钟后手机刷新即可。

> 本机已配置该仓库的 SSH 部署密钥（`红利工具/.git/d3-deploy-key`），推送自动使用，不再需要 GitHub 授权。换机器/换仓库见 `../report/DEPLOY-GITHUB.md`。

详细说明见 `../report/DEPLOY-GITHUB.md`。

| 场景 | 做法 | 限制 |
|---|---|---|
| 出门 / 永久 | GitHub Pages（已部署） | 更新时双击 `../部署到GitHub.command`，无需再授权 |
| 同一 Wi-Fi | 双击 `../手机访问.command` → 手机打开打印的局域网地址 | Mac 要开机；http 下 PWA 不能离线安装 |
| 临时公网（Mac 需开机） | `cloudflared tunnel --url http://127.0.0.1:8766` | 需要本机装 cloudflared；链接临时 |

部署后行情/日 K 由浏览器自动联网拉取，不需要 Mac 或后台脚本；核心静态数据想更新时跑一次抓取脚本再 push。

## 五个页面

| 页面 | 内容 |
|---|---|
| **今天** | 全市场候选：可买 / 观察 / 回避 / 数据不足；持仓概览、分红日历、数据源状态 |
| **选股** | 扫描榜（100 行、可排序、长表格内部滚动、表头吸顶）、条件选股（股息率/连续分红/分位/市值/支付率/ROE/质量）、多股对比（最多 4 只，归一走势 + 指标表）、自选（本地存储） |
| **个股** | 行情、日 K 蜡烛（成交量 + MA20/MA60 + 股息率参考价，1/3/5 年切换）、股息率分位、分红历史、四层因子、自选/加入组合 |
| **回测** | 组合回测（投入 / 持仓回放、组合方案 + 建仓节奏、指标卡、全景图、持仓构成、分红、收益拆解、分环境、历史相似状态、年度数据、个股明细、交易流水、规则卡）；个股回测；组合对比 |
| **我的** | 总账（每笔收益/年化/XIRR）、组合方案（自由加删股票 / 比例或金额 / 本金 / 建仓节奏 / 执行清单）、设置（月支出/期初现金/备份导出导入/数据健康/关于） |

## 组合方案（我的 → 组合方案）

方案 = 一套代码 + 目标比例 + 计划本金 + 建仓节奏，可自由编辑：

- **加 / 删股票**：选股弹层按代码或名称搜（右侧带当前股息率），配满 100% 时自动等权腾位置；
- **比例 / 金额两种输入**：右上角切换，金额模式直接填每只投多少钱（万元）；
- **本金 / 现金 / 权重合计**：股票合计不到 100% 的部分就是现金仓位，实时显示年分红和组合股息率；
- **建仓节奏**：一次性 / 分批 N 期 / 股息率≥X% 才买（显示触发价）；回测引擎按同一节奏模拟，保证和清单是同一口径；
- **执行清单**：目标市值 vs 当前持仓 → 差额 → 建议买卖多少股（100 股整手），分批方案按每期预算拆好，dip 没到门槛显示「等触发价」，一键「记一笔」写进总账；
- **联动**：方案卡可直接回测，回测页「组合」下拉框也能选；复制 / 删除只影响方案，不动账本。

详见 `../report/PORTFOLIO-PLAN.md`。

## 数据

| 文件 | 内容 | 时点 | 来源 |
|---|---|---|---|
| `data/quotes.json` | 全池最新行情 | 2026-10-30 | 新浪批量行情 |
| `data/monthly.json` | 2823 只月度收盘（2012-01 起） | 2026-10 | 腾讯月线 |
| `data/daily/meta.json` + 7 只演示持仓 | 交易日历 + 演示持仓的日 K（离线兜底）；**其余日 K 按需联网拉取**（腾讯，IndexedDB 缓存） | 2026-10-30 | 腾讯日线 |
| `data/dy-pct.json` | 股息率分位（预计算，33KB，避免加载 6.5MB 月线） | 派生 | 月线 + 分红 |
| `data/index-daily.json` | 中证红利全收益 + 低波全收益日线 | 2026-08 | 中证指数 / 理杏仁快照 |
| `data/baseline.json` | 股票池（名称/行业/市值）、年度每股分红（只保留 `years`，派生字段由前端重算） | 2026-08 快照 | 旧快照导入 + `build-slim-data` 瘦身 |
| `data/finance-core.json` | 首屏用：5377 只 2025 年报的 eps/ROE/每股经营现金流（质量闸门） | 2025 年报 | 东财 → `build-slim-data` 拆分 |
| `data/finance-extra.json` | 个股页按需：净利率/负债率/归母净利润（首屏不加载） | 2025 年报 | 同上 |
| `data/finance-current.json` | 5377 只 2025 年报完整 6 字段（抓取脚本/体检脚本用，页面不再加载） | 2025 年报 | 东财数据中心 |
| `data/finance-history.json` | 5513 只 2011–2025 年度指标（回测用） | 年度 | 东财数据中心 |
| `data/benchmark.json` | 中证红利全收益月末点位 | 2012-01 ~ 2026-10 | 中证指数 + 补两月 |
| `data/index.json` | 中证红利 / 沪深300 / 中证500 月线 | 2026-10 | 腾讯 |

更新数据：

```bash
node tools/fetch-data.mjs all        # 行情 + 月线 + 指数（约 3 分钟）
node tools/fetch-finance.mjs 2011 2025
node tools/fetch-daily.mjs --offline-cache   # 可选：想把全市场日 K 落盘当离线缓存时再跑（默认不跑，页面按需联网）
node tools/build-derivatives.mjs      # 生成 dy-pct.json（分位预计算）
node tools/build-slim-data.mjs       # 生成 finance-core/extra、瘦身 baseline（fetch-finance 会自动跑）
node tools/audit-app.mjs              # 数据 + 引擎体检 → ../report/AUDIT-APP.md
```

> 旧 2.0 的 `snapshot-data.js` 已随旧仓库删除；`fetch-data.mjs` 会自动改用当前
> `data/baseline.json` + `data/monthly.json` 里的股票池/持仓，不再需要单独的导入脚本。

## 引擎（纯函数 + 单测）

```
src/engine/finance.js           XIRR、年化、最大回撤、夏普
src/engine/portfolio.js         多笔买入 FIFO、每笔收益/年化/XIRR、组合 XIRR
src/engine/market.js            日 K + 月线合并序列、按日期查价、交易日历、财务质量
src/engine/portfolioBacktest.js 组合回测：投入 / 持仓回放、未上市建仓、分红复投、月追加、基准
src/engine/stockBacktest.js     个股回测：股息率 + 质量闸门、分红、买入持有对照
src/engine/backtest.js          年度调仓计划回测（红利率选股）
src/engine/verdict.js           单股决策：亏损/支付率≥85%/现金流覆盖<0.7/股息率>15% → 回避；财报缺失 → 数据不足
```

### 组合回测的未上市规则

组合里有股票在回测起点还没上市时：它的目标份额**平均摊给当时已上市的股票**（资金不闲置）；上市满 6 个月后做结构再平衡，卖出超配的已上市股票，把它**初始份额 × 期间组合增长**的价值买回来。之后分红复投继续按目标权重补缺口。详见 `../report/UNLISTED-STOCK.md`。

## 测试与体检

```bash
node --test test/*.test.js     # 177 个用例（finance/portfolio/market/verdict/plan/建仓节奏/组合回测/个股回测/数据层/本地账本/格式化/联网解析/差分测试）
node tools/check-static.mjs    # 静态检查：index.html / sw.js SHELL / import / manifest / 数据文件引用
node tools/smoke-all.mjs       # 浏览器全站冒烟：5 页 + 4 选股视图 + 3 我的视图 + 方案编辑/执行清单 + 深浅色 + 移动端（36 项）
node tools/audit-app.mjs       # 数据覆盖/一致性/异常值/新鲜度 + 引擎自检
node tools/check-budget.mjs    # 首屏性能预算：核心数据/JS gzip 体积、懒加载结构、SW 预缓存
node tools/check-xss.mjs       # XSS/转义审计（需 8766 + Chrome 9222；CI 里跟冒烟一起跑）
node tools/check-render-budget.mjs  # 渲染耗时门禁（CPU 4x，冷/热渲染预算；CI 里跟冒烟一起跑）
node tools/check-pwa.mjs       # PWA 可安装性（SW 控制、installability、manifest/图标）
node tools/check-plan-flow.mjs # 执行清单端到端：引擎期望 vs 页面渲染（含现金缺口/记一笔落账/dip 未触发）
node tools/perf.mjs            # 冷/热加载性能（含 ECharts 按需加载核验）
node tools/perf-boot.mjs       # 首屏启动：本地 vs 慢 4G + 4x CPU（骨架出现时间 / 完整首屏）
node tools/perf-render.mjs     # 各页面 render() 耗时（CPU 4x，比较优化前后）
node tools/shot.js             # 界面截图 → ../report/design/
```

`npm run verify` = 单测 + 静态检查 + 性能预算 + 数据体检（不需要浏览器）；`npm run smoke` / `npm run perf` 需要本地 8766 + Chrome 9222。
每次 `git push main` 后 GitHub Actions 会自动跑：177 单测 + 静态检查 + 数据体检 + 首屏性能预算 + 浏览器冒烟 36 项 + 渲染耗时门禁 + XSS 审计 + PWA 可安装性 + 执行清单端到端（`.github/workflows/test.yml`，CI 里自起静态服务与无头 Chrome）；另有每日线上健康检查（`.github/workflows/health.yml`）。失败会在仓库 Actions 页提示。

当前结果：

- 单测 **177/177**（含 35 个回测差分测试：独立朴素参考实现对照 plan 调仓/组合 once/staged/dip/replay/个股/执行清单/月追加/基准/市场工具/纯函数性）；
- 冒烟 **36/36**，0 console 报错；
- 数据体检：全部通过（覆盖 / 时点 / 股息率分布 / 日 K 与行情一致性 / 未上市识别 / 引擎起点净值=本金）；
- 加载性能（1280×1000，本地）：冷加载 99–323ms、热加载 57–224ms、首屏渲染 53–222ms；首屏 JS 330KB（ECharts 1MB 按需加载，仅个股/回测页首次进页加载）。
- 首屏数据：核心 JSON 约 1.75MB（gzip 422KB）——比拆分前的 2.3MB / gzip 595KB 少 **29%**；回测月线 9MB、历史财报 4.4MB 按需加载。
- 线上弱网（1.6Mbps + 150ms RTT + 4x CPU）：骨架 1.5s、完整首屏 **3.9s**（优化前 4.5s）；SW 缓存后二次打开更快。

## 联网与离线

- **行情**：启动后后台批量刷新全市场（qt.gtimg.cn，80 只/批，10 分钟缓存），侧栏显示「已更新 HH:MM」；失败自动用本地快照。
- **日 K**：看哪只拉哪只（腾讯 newfqkline，不复权），IndexedDB 缓存 6 小时；本地只常驻 7 只演示持仓作为离线兜底。
- **离线**：`?offline=1` 或在断网时，页面用本地快照 + 月线近似，核心页面不白屏。
- **离线回测**：「我的 → 设置 → 离线回测数据」可一键把月线/历史财报/指数日线缓存进 Service Worker（约 13MB），之后断网也能打开回测页。
- **隐私**：只请求腾讯公开行情接口，不上传本地持仓；数据仍只存在浏览器 localStorage / IndexedDB。

## 回测口径与局限

- 价格：**不复权**（日 K 2014-06 起，更早用月线月末）；分红单独计现金，4 月末到账（Y-1 年度 × 当时持股）。
- 组合口径：起点按目标结构买入；分红复投 / 不复投双线；现金 1.5% 年息日计；4/12 月末月追加（各入 6 个月）；未上市股票按上面的规则处理。
- 个股口径：4/12 月末决策；股息率 ≥ 买入线 + 质量闸门（不亏损、ROE ≥5%、现金流/EPS ≥0.7、支付率 <85%）；分红下调 ≥5% 清仓。
- 不含佣金、不含红利税；基准中证红利全收益（2014–2026-08 日线，之后月线补齐）。
- **局限**：股票池是当前存活的 5098 只（幸存者偏差）；财务用 Y-1 年报有轻微前视；分红到账统一按 4 月末近似；无涨跌停/停牌限制。

## 目录

```
index.html
styles/      tokens / base / components / pages
src/
  main.js    路由 + 主题 + 页面骨架屏
  data.js    data/*.json + 联网层 → 统一出口（核心 / 日 K 按需 / 月线 / 分位 / 指数）
  store.js   本地账本（买入 / 现金 / 自选 / 方案 / 设置）
  net.js     联网层：行情 / 日 K / 交易日历 + IndexedDB 缓存
  charts.js  日 K 蜡烛 / 组合全景 / 回撤 / 分红 / 瀑布 / 多线
  engine/    finance / portfolio / market / portfolioBacktest / stockBacktest / backtest / verdict
  pages/     today / scan / stock / backtest / mine
  ui/        icons / format / toast / modal / buy
data/        静态 JSON（核心快照 + 演示持仓日 K；其余日 K 按需联网）
sw.js        Service Worker（PWA 离线缓存）
manifest.webmanifest  PWA 清单
tools/       fetch / audit / derivatives / backtest / check-static / perf / perf-boot / perf-render / shot / smoke / ui-audit
test/        node --test 单测
```

## 约束

- 纯静态站点、无构建步骤：改源码后刷新即可，发布 = `git push origin main`（SSH deploy key，免 GitHub 授权）。
- 数据全部本地 JSON；联网只访问腾讯公开行情接口，不上传持仓。
- 不共用原工具的存储键（本工具统一 `d3:` 前缀）。
- 不承诺预测涨跌；只给条件、证据和可复现的回测。
