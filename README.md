# Kiro 任务监控（Kiro Task Monitor）

[![Release](https://github.com/DamonAmber/kiro-task-monitor/actions/workflows/release.yml/badge.svg)](https://github.com/DamonAmber/kiro-task-monitor/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/DamonAmber/kiro-task-monitor?label=%E4%B8%8B%E8%BD%BD&sort=semver)](https://github.com/DamonAmber/kiro-task-monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/DamonAmber/kiro-task-monitor/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://github.com/DamonAmber/kiro-task-monitor/releases)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

Mac 桌面上的一个小浮窗，实时监控**所有** Kiro 会话（跨工作区）的任务进度：

- 🔵 **运行中** —— agent 正在执行，显示已运行时长
- 🟢 **已完成** —— 一轮正常结束（轮到你了 / 任务完成），弹出通知
- 🔴 **出错** —— agent 因报错停下（`error`/`failed`/`aborted`），**一键重试**
- 🟣 **疑似卡住 / 已中断** —— 运行中长时间无写入（超时兜底判卡住）；或确知 Kiro 已退出/崩溃导致中断（标为「已中断」），**一键重试**
- 🟡 **等待你确认** —— agent 停下等待你的确认或输入
- ⚪️ 已取消 / 空闲

外加一条 💳 **套餐用量**：浮窗底部一条进度条，随时看清 Kiro 套餐额度**剩余 / 已用百分比 / 是否超额 / 重置倒计时**，接近上限变黄、超额变红。

同时还能**只读监控 Claude Code 会话**（运行中 / 完成 / 失败 / 中断），在同一浮窗里用来源色片（<code>Kiro</code> 蓝 / <code>Claude</code> 橙）区分。Claude 会话只做展示、不提供一键重试（终端无法可靠定位与注入）。

还支持 📱 **局域网访问**：在设置里开启后，同一 Wi-Fi 下的手机 / 平板 / 另一台电脑用浏览器输入 PIN 即可全屏查看所有会话状态（横竖屏自适应），适合把一台闲置设备立成任务看板——只读、用 PIN 保护。

解决的痛点：Kiro 任务执行久、经常因各种原因中断需要手动回复「继续」，但你不盯着就不知道它什么时候完成或失败，导致重试不及时、浪费时间。

---

## 工作原理

工具**只读**本地的 Kiro 会话记录，不依赖任何 Kiro 内部接口，也不修改它的任何文件：

- `~/.kiro/sessions/<workspaceHash>/<sessionId>/session.json`
  —— 会话标题、所属工作区、模型、`status`（`in_progress`/`failed`/`completed`/`waiting_on_user`/`idle`）。
- `~/.kiro/sessions/.../messages.jsonl`
  —— 事件流，逐行 `{id, timestamp, payload}`。关键事件：
  - `turn_start` / `turn_end`（`turn_end.stopReason` = `end_turn` 正常 / `error`·`failed`·`aborted` 失败 / `cancelled` 取消）
  - `pending_interaction` / `interaction_resolved`（等待你确认）

状态推导逻辑见 `src/watcher.js`（`deriveState`），并对"运行中但长时间无写入"做卡死兜底。

**失败是事件驱动的,即时且可靠**:agent 报错/被取消时 Kiro 会写下 `turn_end`(`stopReason` 为 `error`/`failed`/`aborted`/`cancelled`),据此直接判「出错/已取消」,**完全不依赖超时**。这是最主要、最可靠的告警来源。

**"卡住"只是兜底,且可关闭**:唯一没有事件信号的情况是——进程被杀/电脑休眠/断网,导致 Kiro 还没写 `turn_end` 就没了(称「静默中断」)。它在文件层面和"慢查询还在跑"完全一样,只能靠超时去猜。为尽量不误报,超时判定是上下文感知的:用 `tool_call`/`tool_result` 的 `toolCallId` 配对,判断是否有**在途工具**——
- 有工具在执行(慢查询/长命令/构建/测试)→ 用更长宽限(`toolStuckSeconds`,默认 1800s=30min);
- 无工具、纯粹长时间无写入 → 才用较短阈值(`stuckSeconds`,默认 240s)。

考虑到数据库查询等任务常长时间静默(20-30 分钟),**「卡死超时兜底」(`stuckDetection`)默认关闭**——只靠失败事件告警、长任务永不误报。若你希望连"静默中断"也能兜底提醒,可在设置里开启。

**只跟踪真正打开着的会话**：`~/.kiro/sessions` 里会堆积大量历史会话，仅看文件修改时间无法区分"窗口里开着的会话"和"昨天用过、早已关闭的残留会话"。为此工具再**只读**一份 Kiro 应用（VS Code 内核）的本地窗口状态：

- `~/Library/Application Support/Kiro/User/globalStorage/storage.json` —— 当前打开的窗口列表与最近激活窗口。
- 每个窗口的 `workspaceStorage/<hash>/state.vscdb`（SQLite，用系统 `sqlite3 -readonly` 读取）—— 该窗口侧边栏打开了哪些会话、当前聚焦的是哪个。

据此默认只显示"当前 Kiro 窗口里真正打开着的会话"，并标记每个窗口**聚焦（激活）**的那个会话（浮窗里显示「当前」标签）。若这份窗口状态读不到，则安全回退到"按最近活动时间显示"的旧行为，绝不让监控变空白。详见 `src/openWindows.js`。

**Claude Code 会话（只读）**：另读 Claude Code 的本地数据（全程只读）：`~/.claude/sessions/<pid>.json` 给出每个会话的 `status`（实测 `busy`=运行中 / `idle`=完成待你）、`sessionId`、`cwd`、名称；`pgrep -x claude` 判断进程存活（兼作中断判定与结束会话过滤）；`~/.claude/projects/*/<sessionId>.jsonl` 末行的 `isApiErrorMessage`/`error` 判失败。只做**经实测能判准**的状态：运行中 / 完成 / 失败 / 中断——**不做**一键重试、也不区分「等你授权」（终端 TUI 交互不落盘，判不准就不做）。详见 `src/claudeWatcher.js`。

**及时与性能**：用 `fs.watch` 监听会话目录写入，状态变化**亚秒级**反映（去抖后触发一次扫描），并保留定时轮询兜底。为降开销，未变化的会话按 `mtime`/`size` 跳过重复读取与 JSON 解析（`src/watcher.js` 的扫描缓存）；窗口状态（含 Kiro 进程存活检测）改为**异步、缓存、约 8s 刷新**，不再每轮同步 `spawn sqlite3`。

**中断判定（准确）**：确知 Kiro 进程已退出（崩溃 / 被杀 / 正常退出）时，仍标记为运行中的会话会被可靠判为「**已中断**」（紫色、可重试），无需靠超时去猜；此时不弹通知也不自动重试（用户已不在 Kiro）。休眠唤醒后会重建通知基线，避免对睡眠期间的状态跳变补发一堆通知。

**套餐用量**：Kiro 会把订阅用量快照缓存进 `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb`（`ItemTable` 里 `key='kiro.kiroAgent'` 的 value(JSON) → 字段 `kiro.resourceNotifications.usageState`，含 `usageLimit`/`currentUsage`/`currentOverages`/`overageCharges`/`resetDate` 等）。工具用系统 `sqlite3 -readonly` **只读**取出并归一化（剩余额度、已用百分比、是否超额、重置倒计时），主进程每 60s 刷新一次推给浮窗，在底部展示。注意这是 **Kiro 自己写入的缓存快照、非实时 API**——只要 Kiro 在正常使用就会周期刷新；读不到时安全降级为不显示。详见 `src/usage.js`。

**聚焦 / 一键重试**：优先用 Kiro 命令行 `kiro <工作区路径>` 把对应窗口带到前台——由 Kiro 自己切换窗口,能可靠跨 Space、把**全屏**窗口也切过去(这是 AppleScript 的 `AXRaise` 做不到的);若 CLI 不可用再退回 AppleScript(按窗口标题匹配工作区名)。重试在此基础上再 `⌘L` 聚焦聊天输入框 → 粘贴「继续」→ 回车。

---

## 下载安装（面向用户）

🌐 **官网（介绍 + 下载）**：https://damonamber.github.io/kiro-task-monitor/

👉 或直接 **[前往 Releases 下载最新版](https://github.com/DamonAmber/kiro-task-monitor/releases/latest)**

下载其中的 `KiroTaskMonitor-<版本>-universal.dmg`，打开后把 app 拖进「应用程序」即可运行
（Apple Silicon 与 Intel 通用）。已签名 + 公证，双击直接打开，**无需右键绕过 Gatekeeper**。
安装后**每次启动自动检查更新**，新版无感升级。

> ⚠️ **务必从「应用程序」里打开**：若直接在 DMG 或「下载」目录里运行，macOS 会以只读方式运行（App Translocation），
> 导致**无法自动更新**（报错 `Cannot update while running on a read-only volume`）。App 启动时若检测到这种情况会**引导你一键移动到「应用程序」**；移动后即可正常自动升级，只需一次。

首次点「重试」时会请求 **辅助功能** 与 **自动化（控制 Kiro）** 权限，允许一次即可。

## 开发 / 本地运行

```bash
cd Kiro-helper
npm install       # 首次安装依赖
npm start         # 启动浮窗（开发模式，不检查更新）
npm run icon      # 重新生成 app 图标 build/icon.png
npm run dist      # 本地打未签名包（验证打包链路，产物在 dist/）
```

## 发布新版

签名、公证、上传 GitHub Releases、自动更新的完整流程见 **[RELEASE.md](./RELEASE.md)**。
日常发版只需：

```bash
npm version patch && bash scripts/release.sh
```

启动后：

- 浮窗默认停在屏幕**右上角**，始终置顶、跨全屏显示，标题栏可拖动。
- 菜单栏出现一个 `◐` 图标（模板图，自适应深浅色菜单栏），后面跟当前**运行中**的会话数；无运行中时只显示图标。有任务**出错 / 卡住 / 中断**时，图标右上角显示一个**红点**提醒。把光标停上去，提示里给出运行中 / 待处理 / 等待确认的数量。
  - **左键点图标**：显示 / 隐藏浮窗
  - **右键点图标**：快捷开关（自动重试、完成通知、置顶）、退出
- 浮窗右上角 ⚙ 打开设置，— 隐藏浮窗。设置里可**手动「检查更新」**，并在下载完成后一键**「重启并更新」**（不用再自己退出重开）。

### 无界面快速验证（不启动 Electron）

```bash
npm run watch        # 终端里每 2s 刷新一次所有会话状态
npm run watch:once   # 只扫描打印一次
```

---

## 一键重试需要「辅助功能」权限

自动置前窗口、发送「继续」用到了系统事件模拟，需要授权：

**系统设置 › 隐私与安全性 › 辅助功能** → 勾选 **Electron**（开发运行时）或打包后的 **Kiro 任务监控**。

**授权自检（v0.9.0+）**：应用启动就会检查该授权是否到位，缺了会在浮窗顶部弹一条常驻提醒 + 「去授权」按钮（一键跳到对应系统设置），并弹一次系统通知；授予后回到浮窗自动复查。设置面板「系统授权」区块可随时查看各项自检结果（辅助功能 / 会话数据可读 / sqlite3 / Kiro 窗口状态）并手动「重新检查」。仅查看监控状态无需任何授权。

**诊断报告（v0.9.0+）**：设置面板「诊断报告」点「生成报告」，导出一个结构化 JSON（默认**脱敏**：不含真实项目名、会话标题、绝对路径，只留 hash + 结构信息），用于反馈「识别不到会话 / 状态不对」。报告里含环境、权限自检、打开窗口构成（能看出是否踩到**多根工作区**盲区）、以及**每个会话为何被显示/隐藏**的原因（与真实过滤规则同源）。需要精确定位时可勾选「包含项目名 / 会话标题」。

---

## 设置项

| 选项 | 说明 | 默认 |
|------|------|------|
| 出错 / 卡住时通知 | 失败弹通知 + 提示音 | 开 |
| 完成时通知 | 任务完成弹通知（过滤秒回的短轮次） | 开 |
| 等待确认时通知 | agent 停下等你确认时通知 | 开 |
| 失败播放提示音 | 播放系统 Basso 提示音 | 开 |
| 出错时**自动**重试 | 检测到失败立即自动发送「继续」（谨慎开启） | 关 |
| 重试发送内容 | 重试时发送的文本 | `继续` |
| 重试后自动回车 | 粘贴后是否自动发送 | 开 |
| 只显示**已打开**的会话 | 只跟踪当前 Kiro 窗口里真正打开着的会话，剔除历史残留（正在运行 / 待处理的活跃会话不受此过滤影响，始终显示） | 开 |
| 每个窗口只看**当前**会话 | 每个打开的窗口只显示它当前聚焦（激活）的那个会话 | 关 |
| 卡死超时兜底 | 默认关：只靠失败事件判断，长任务（如 20-30 分钟的查询）永不误报卡住。开启后额外用超时兜底"静默中断"（进程崩溃/休眠等没写 `turn_end` 的情况） | 关 |
| 卡住阈值·无工具（秒） | 无工具在执行、且运行中无写入超过该值 → 判为卡住 | 240 |
| 卡住阈值·工具执行中（秒） | 有工具在跑（慢查询/长命令/构建/测试）时用的更长宽限 | 1800 |
| 显示最近（小时） | 二级过滤：在已打开的会话中再按最近 N 小时活跃筛选 | 24 |
| 底部显示**套餐用量** | 浮窗底部显示 Kiro 套餐额度剩余 / 已用百分比 / 超额 / 重置倒计时 | 开 |
| 监控 **Claude Code** 会话 | 同时只读监控 Claude Code 会话（运行/完成/失败/中断），来源色片区分 | 开 |
| **极简模式** | 单行紧凑卡片、隐藏次要信息（来源改用左边框色区分），窗口可缩到很小；普通/极简两种尺寸各自记忆 | 关 |
| **局域网访问** | 开启后起一个只读 Web 服务，手机 / 平板浏览器输入 PIN 即可全屏查看（横竖屏自适应）；列出全部可用网址并标出 Wi-Fi（多网卡时选对那个），PIN 可随时「换一个」 | 关 |
| 窗口置顶 | 浮窗始终置顶 | 开 |

配置保存在 `~/Library/Application Support/kiro-task-monitor/config.json`。

---

## 已知限制

- **同一工作区多个会话标签**：一个工作区在 Kiro 里只有一个窗口，`⌘L` 聚焦的是该窗口**当前激活的会话标签**。若失败的会话不在前台标签，重试可能发到别的标签。浮窗已用「当前」标签标出每个窗口聚焦的会话；可开启「每个窗口只看当前会话」只跟踪它，或每个工作区一个会话时最稳。
- 重试是通过模拟按键实现的，触发瞬间会把 Kiro 窗口带到前台。
- 仅支持 macOS。

---

## 目录结构

```
main.js              Electron 主进程：浮窗 / 托盘 / 通知 / 轮询 / IPC / 自动更新
preload.js           渲染进程安全桥接
electron-builder.yml 打包配置（dmg+zip / 签名 / 公证 / GitHub 发布）
src/
  watcher.js         核心：扫描 session.json + tail messages.jsonl → 推导状态
  openWindows.js     只读 Kiro 窗口状态 → 判断哪些会话真正打开/聚焦（过滤残留）
  usage.js           只读 Kiro 全局缓存的套餐用量（额度/已用/超额/重置日）
  permissions.js     系统授权/能力自检（辅助功能 / 会话数据可读 / sqlite3 / Kiro 窗口状态）→ 缺授权推提醒
  diagnostics.js     一键诊断报告：汇总环境/权限/窗口构成/逐会话隐藏原因 → 默认脱敏 JSON，供反馈定位
  claudeWatcher.js   只读监控 Claude Code 会话（~/.claude sessions + transcript + pgrep）
  trayIcon.js        运行时无依赖生成菜单栏 ◐ 模板图标（深浅色菜单栏自适应）
  retry.js           一键重试 / 聚焦窗口（kiro CLI 优先，AppleScript 兜底）
  webServer.js       局域网只读 Web 服务（HTTP + SSE，PIN 鉴权）→ 手机/平板浏览器全屏查看
  config.js          配置读写
  kiroPaths.js       ~/.kiro 与 Kiro 应用数据路径
renderer/            浮窗界面（HTML / CSS / JS）
webui/               局域网访问的响应式网页（登录页 + 应用页 + PWA manifest，横竖屏自适应）
build/
  icon.png           app 图标源（electron-builder 自动转 .icns）
  entitlements.mac.plist  硬化运行时权限（公证所需）
scripts/
  release.sh         本地应急发版（读 .env → 签名+公证+上传）
tools/
  make-icon.js       无依赖生成图标
  watch-cli.js       无界面的终端版监控（验证用）
.github/workflows/
  release.yml        打 tag 触发的自动发版流水线（正规发版路径）
AGENTS.md            维护者 / 接手 AI 的交接说明（架构 · 铁律）
RELEASE.md           发版手册（签名 · 公证 · 自动更新 · 凭据重建 · 排障）
.env.example         本地应急发版的凭据模板（复制为 .env 填写）
```

## 维护 / 交接

接手本项目（无论人或 AI）先读 **[AGENTS.md](./AGENTS.md)**（架构与铁律），发版按 **[RELEASE.md](./RELEASE.md)**。
一句话规矩：只读 `~/.kiro`、不改 `appId`、发版一律 `npm version` + 打 tag 触发 CI、`.env` 永不提交。
