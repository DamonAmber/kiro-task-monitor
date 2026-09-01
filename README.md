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
- 🟣 **疑似卡住** —— 运行中但长时间无任何写入（崩溃/挂起兜底），**一键重试**
- 🟡 **等待你确认** —— agent 停下等待你的确认或输入
- ⚪️ 已取消 / 空闲

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

**只跟踪真正打开着的会话**：`~/.kiro/sessions` 里会堆积大量历史会话，仅看文件修改时间无法区分"窗口里开着的会话"和"昨天用过、早已关闭的残留会话"。为此工具再**只读**一份 Kiro 应用（VS Code 内核）的本地窗口状态：

- `~/Library/Application Support/Kiro/User/globalStorage/storage.json` —— 当前打开的窗口列表与最近激活窗口。
- 每个窗口的 `workspaceStorage/<hash>/state.vscdb`（SQLite，用系统 `sqlite3 -readonly` 读取）—— 该窗口侧边栏打开了哪些会话、当前聚焦的是哪个。

据此默认只显示"当前 Kiro 窗口里真正打开着的会话"，并标记每个窗口**聚焦（激活）**的那个会话（浮窗里显示「当前」标签）。若这份窗口状态读不到，则安全回退到"按最近活动时间显示"的旧行为，绝不让监控变空白。详见 `src/openWindows.js`。

**一键重试**：通过 AppleScript 把对应工作区的 Kiro 窗口置前 → 按 `⌘L` 聚焦聊天输入框 → 粘贴「继续」→ 回车。
Kiro 的窗口标题恰好是工作区文件夹名（如 `mijia-net`），因此能精准定位到目标窗口。

---

## 下载安装（面向用户）

🌐 **官网（介绍 + 下载）**：https://damonamber.github.io/kiro-task-monitor/

👉 或直接 **[前往 Releases 下载最新版](https://github.com/DamonAmber/kiro-task-monitor/releases/latest)**

下载其中的 `KiroTaskMonitor-<版本>-universal.dmg`，打开后把 app 拖进「应用程序」即可运行
（Apple Silicon 与 Intel 通用）。已签名 + 公证，双击直接打开，**无需右键绕过 Gatekeeper**。
安装后**每次启动自动检查更新**，新版无感升级。

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
- 菜单栏出现 `K` 图标：`K ✓` 全部空闲 / `K …n` n 个运行中 / `K ❗n` n 个出错待处理。
  - **左键点图标**：显示 / 隐藏浮窗
  - **右键点图标**：快捷开关（自动重试、完成通知、置顶）、退出
- 浮窗右上角 ⚙ 打开设置，— 隐藏浮窗。

### 无界面快速验证（不启动 Electron）

```bash
npm run watch        # 终端里每 2s 刷新一次所有会话状态
npm run watch:once   # 只扫描打印一次
```

---

## 一键重试需要「辅助功能」权限

自动置前窗口、发送「继续」用到了系统事件模拟，需要授权：

**系统设置 › 隐私与安全性 › 辅助功能** → 勾选 **Electron**（开发运行时）或打包后的 **Kiro 任务监控**。

首次点击「重试」若无权限，会弹通知引导你去开启。开启后再次点击即可。

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
| 只显示**已打开**的会话 | 只跟踪当前 Kiro 窗口里真正打开着的会话，剔除历史残留 | 开 |
| 每个窗口只看**当前**会话 | 每个打开的窗口只显示它当前聚焦（激活）的那个会话 | 关 |
| 卡住判定阈值（秒） | 运行中无写入超过该值判为卡住 | 120 |
| 显示最近（小时） | 二级过滤：在已打开的会话中再按最近 N 小时活跃筛选 | 24 |
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
  retry.js           AppleScript 一键重试 / 聚焦窗口
  config.js          配置读写
  kiroPaths.js       ~/.kiro 与 Kiro 应用数据路径
renderer/            浮窗界面（HTML / CSS / JS）
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
