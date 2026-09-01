# 项目交接说明（给维护者 / 接手的 AI）

> 先读本文了解全貌与铁律，再动手。**发版流程见 [RELEASE.md](./RELEASE.md)**，用户/功能说明见 [README.md](./README.md)。

## 这是什么
`Kiro 任务监控` —— macOS 桌面浮窗（Electron），实时监控本机**所有 Kiro 会话**的任务状态
（运行中 / 已完成 / 出错 / 卡住 / 等待你），出错可一键重试、完成弹通知。仅 macOS。

## 架构地图
```
main.js              Electron 主进程：浮窗/托盘/原生通知/轮询调度/IPC/自动更新(electron-updater)
preload.js           contextBridge 安全桥接（window.api.*）
src/
  watcher.js         ★核心：扫描会话 + tail 消息流 → 推导每个会话的实时状态（deriveState）
  openWindows.js     只读 Kiro 窗口状态（storage.json + workspaceStorage/*/state.vscdb）→
                     判断哪些会话真正打开/聚焦，供 watcher 过滤残留、标注 isFocused
  usage.js           只读 Kiro 全局 state.vscdb 缓存的套餐用量（额度/已用/超额/重置日），
                     主进程每 60s 刷新推给浮窗，底部展示；只读、非实时、读不到即降级不显示
  trayIcon.js        运行时无依赖生成菜单栏 ◐ 模板图标(setTemplateImage)；因 build/ 不打包，
                     故在代码里画 PNG。菜单栏标题只显示运行中会话数，详情放 tooltip
  retry.js           一键重试/聚焦窗口：kiro CLI(`kiro <路径>`) 优先，osascript 兜底
  config.js          配置读写（userData/config.json）
  kiroPaths.js       ~/.kiro 与 Kiro 应用数据（Application Support/Kiro）路径
renderer/            浮窗 UI（index.html / styles.css / renderer.js）
tools/
  watch-cli.js       无界面终端版监控（不启动 Electron，最快的调试/验证入口）
  make-icon.js       无依赖生成 build/icon.png
electron-builder.yml 打包/签名/公证/发布配置
.github/workflows/release.yml   打 tag 触发的自动发版流水线
```

## 状态判定：数据来源（改 watcher 前必读）
工具**只读**本地文件、绝不写入 Kiro 的任何数据。信号来自：
- `~/.kiro/sessions/<workspaceHash>/<sessionId>/session.json`
  → `title` / `workspacePaths` / `status`(`in_progress|failed|completed|waiting_on_user|idle`) / `modelId`
- 同目录 `messages.jsonl`（逐行 `{id,timestamp,payload}`），关键 `payload.type`：
  - `turn_start` / `turn_end`（`turn_end.stopReason`：`end_turn`=正常；`error|failed|aborted`=**失败需重试**；`cancelled`=取消）
  - `pending_interaction` / `interaction_resolved`（未解决=**停下等用户**）
  - `tool_call` / `tool_result`（按 `toolCallId` 配对）：有未配对的 = 有**在途工具**在跑，卡住宽限更长
- **失败/取消是事件驱动的**（`turn_end.stopReason` = `error|failed|aborted|cancelled`），即时可靠、不依赖超时——这是主要告警来源。
- 状态优先级与卡死兜底：见 `src/watcher.js` 的 `deriveState`。`stuck` 只兜底"静默中断"（进程被杀/休眠/断网，没写 `turn_end`）：
  上下文感知——无在途工具时超 `stuckSeconds`(默认 240s) 判 `stuck`；有工具在执行时用 `toolStuckSeconds`(默认 1800s=30min)。
  配置 `stuckDetection` **默认 false**（超时判定整体关闭，长任务永不误报，代价是察觉不到静默中断）；置 true 才启用兜底。
- 单个超长 turn 的 `turn_start` 可能超出 tail 窗口（默认 512KB）→ 回退用 `session.json.status`，状态仍准，仅耗时未知。
- **只显示真正打开的会话**：`openWindows.js` 只读 `~/Library/Application Support/Kiro/User/globalStorage/storage.json`
  （当前打开/激活的窗口）与各窗口 `workspaceStorage/<hash>/state.vscdb`（`kiro.kiroAgent.sessionPanels.entries/focused`，
  用系统 `sqlite3 -readonly` 读），据此过滤历史残留会话并标注 `isFocused`。读不到时安全回退为不过滤。
- **套餐用量**：`usage.js` 只读全局 `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb`
  里 `key='kiro.kiroAgent'` 的 value(JSON) → 字段 `kiro.resourceNotifications.usageState`
  （`usageLimit`/`currentUsage`/`currentOverages`/`overageCharges`/`resetDate` 等），归一化后展示。
  这是 **Kiro 自己写的缓存快照、非实时 API**：只能读到 Kiro 上次写入的值（UI 用 `timestamp` 标注新鲜度）。

## 铁律（容易踩雷）
1. **只读 `~/.kiro`**：任何情况下都不要写入/修改 Kiro 的会话文件。
2. **不要改 `appId`（`com.damonamber.kiro-task-monitor`）或 .app 名**：会重置用户的「辅助功能/自动化」授权并断开自动更新身份连续性。
3. **聚焦 / 一键重试**：优先用 `kiro <工作区路径>`(VS Code 风格 CLI) 把窗口带到前台——可靠跨 Space、能切到**全屏**窗口；CLI 不可用才退回 AppleScript(按窗口标题匹配工作区名，全屏时可能切不过去)。重试再 `⌘L` 聚焦聊天输入框后粘贴「继续」回车,依赖 macOS「辅助功能」权限。同一工作区多标签时，`⌘L` 只作用于**当前激活标签**（已知限制）。
4. **发版只走打 tag → CI**（见 RELEASE.md）；`.env` 只用于本地应急且**永不提交**；CI 凭据在 GitHub Secrets。
5. **版本号与 git tag 必须一致**：一律用 `npm version` 同步，别手动分开操作。
6. **功能有增改，必须同步更新落地页**：任何新增/改动的用户可见功能，都要在同一次改动里更新 `docs/index.html`
   的相关文案（功能卡片、状态图例、「怎么使用」等）；若界面有变化，还要重做首屏截图 `docs/screenshot.png`。
   **不得在发布含新功能的版本时漏改落地页。**（详见下节「落地页同步规则」）

## 落地页同步规则（docs/ 站点）

站点是 GitHub Pages（源 `main` `/docs`），面向对外用户。分清哪些自动、哪些必须手动：

- **自动**（无需改页面）：下载按钮链接、版本号徽章——页面用 JS 实时读取 GitHub 最新 Release。发版后自动指向新版。
- **手动**（每次功能变更必须更新）：功能描述、状态图例、「怎么使用」、系统要求、首屏截图。这些是静态 HTML。

要求：
1. 新增/修改功能时，**在同一 PR/提交里**同步更新 `docs/index.html` 的对应描述；功能被移除也要删掉对应描述。
2. 截图 `docs/screenshot.png` **只能用虚构示例数据**（如 `payment-service`、`api-gateway` 等），
   **严禁出现用户真实项目名/任务标题**。需要重做时，用组件库同款样式（见 `renderer/styles.css`）渲染虚构数据后截图。
3. 对外站点**只讲怎么用，不讲实现原理**（不出现 `~/.kiro`、`turn_end.stopReason`、`⌘L` 等技术细节）。
4. 发版前按 RELEASE.md 的「发版前检查清单」逐项核对，落地页与新功能一致后再打 tag。

## 常用命令
```bash
npm start            # 启动浮窗（开发模式，不检查更新）
npm run watch        # 终端版监控，验证状态判定最快（无需 Electron）
npm run icon         # 重新生成 app 图标
npm run dist         # 本地打未签名包（验证打包链路，不上传）
# 发版见 RELEASE.md： npm version patch && git push origin main --follow-tags
```

## 验证改动
- 改 `watcher.js` 后：`npm run watch:once` 对照真实会话看判定是否合理；必要时和 `~/.kiro` 里对应会话的
  `session.json.status` / `messages.jsonl` 末尾事件核对。
- 改 UI 后：`npm start` 起浮窗肉眼验证。
- 改重试逻辑：注意会真的向某个 Kiro 会话发送「继续」，测试时选一个安全的会话。
