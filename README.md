# Kiro 任务监控（Kiro Task Monitor）

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

**一键重试**：通过 AppleScript 把对应工作区的 Kiro 窗口置前 → 按 `⌘L` 聚焦聊天输入框 → 粘贴「继续」→ 回车。
Kiro 的窗口标题恰好是工作区文件夹名（如 `mijia-net`），因此能精准定位到目标窗口。

---

## 安装（面向用户）

从 [GitHub Releases](https://github.com/DamonAmber/kiro-task-monitor/releases) 下载最新的
`KiroTaskMonitor-<版本>-universal.dmg`，拖进「应用程序」即可。已签名 + 公证，双击直接打开，无需绕过 Gatekeeper。
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
| 卡住判定阈值（秒） | 运行中无写入超过该值判为卡住 | 120 |
| 显示最近（小时） | 只显示最近 N 小时活跃的会话 | 24 |
| 窗口置顶 | 浮窗始终置顶 | 开 |

配置保存在 `~/Library/Application Support/kiro-task-monitor/config.json`。

---

## 已知限制

- **同一工作区多个会话标签**：一个工作区在 Kiro 里只有一个窗口，`⌘L` 聚焦的是该窗口**当前激活的会话标签**。若失败的会话不在前台标签，重试可能发到别的标签。建议把要重试的会话切到前台，或每个工作区一个会话时最稳。
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
  retry.js           AppleScript 一键重试 / 聚焦窗口
  config.js          配置读写
  kiroPaths.js       ~/.kiro 路径
renderer/            浮窗界面（HTML / CSS / JS）
build/
  icon.png           app 图标源（electron-builder 自动转 .icns）
  entitlements.mac.plist  硬化运行时权限（公证所需）
scripts/
  release.sh         一键发版（读 .env → 签名+公证+上传）
tools/
  make-icon.js       无依赖生成图标
  watch-cli.js       无界面的终端版监控（验证用）
RELEASE.md           发版 / 签名 / 公证 / 自动更新完整指南
.env.example         凭据模板（复制为 .env 填写）
```
