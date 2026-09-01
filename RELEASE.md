# 发版指南（签名 · 公证 · 自动更新）

本应用通过 **electron-builder** 打包、**Developer ID 签名 + 公证**，发布到 **GitHub Releases**；
安装后由 **electron-updater** 在每次启动时自动检查更新、后台下载、退出时静默安装。
你频繁迭代时，日常只需两条命令，用户端零操作。

---

## 一次性准备

### 1. 建 GitHub 仓库
在 GitHub 上创建 `DamonAmber/kiro-task-monitor`（public 即可，自动更新下载无需 token）。
本地关联并推送代码。

### 2. 签名证书：`Developer ID Application`
用于在 App Store 之外分发的桌面应用签名。

- **获取**：Xcode › Settings › Accounts › 选中你的 Apple ID › Manage Certificates › 左下 `+` › 选 **Developer ID Application**。
  （或在 https://developer.apple.com/account/resources/certificates 手动创建后下载。）
- **放哪**：双击 `.cer` 导入后，它就躺在你的 **「登录」钥匙串**里（钥匙串访问 App 可见，名字形如
  `Developer ID Application: Your Name (ABCDE12345)`）。
- **不用给我，也不用写进任何文件**。electron-builder 默认会自动从钥匙串发现它。

> 验证是否就位：`security find-identity -v -p codesigning`，能看到 `Developer ID Application: ...` 即可。

### 3. 公证凭据（三个环境变量）
苹果要求分发的 app 经过公证（notarization），否则用户打开会被 Gatekeeper 拦。

- `APPLE_ID`：你的 Apple ID 邮箱
- `APPLE_APP_SPECIFIC_PASSWORD`：在 https://appleid.apple.com › 登录与安全 › **App 专用密码** 生成（形如 `xxxx-xxxx-xxxx-xxxx`）
- `APPLE_TEAM_ID`：10 位团队 ID，见 https://developer.apple.com/account 的 Membership 页

### 4. 发布 token
- `GH_TOKEN`：在 https://github.com/settings/tokens 生成经典 token，勾选 **repo** 权限。electron-builder 用它把产物上传到 Releases。

### 5. 把凭据放进 `.env`（本地，不提交）
```bash
cp .env.example .env
# 用编辑器填入上面 4 个值
```
`.env` 已在 `.gitignore` 中，不会被提交。签名证书不在这里（在钥匙串）。

---

## 日常发版（两步）

```bash
npm version patch      # 或 minor / major，自动改 package.json 版本号并打 git tag
bash scripts/release.sh
```

`release.sh` 会：载入 `.env` → 生成图标 → 签名 → 公证 → 打包 `dmg`+`zip` → 上传到 GitHub Releases。
完成后用户端下次启动即自动更新。

> 也可用 GitHub Actions：推送 tag 时在 CI 里跑 `electron-builder --publish always`，
> 把上面 4 个值配成仓库 Secrets 即可。需要的话我再帮你加 workflow。

---

## 本地验证（不签名、不上传）

只想确认打包链路和产物结构，不碰证书：
```bash
npm run dist     # 已设 CSC_IDENTITY_AUTO_DISCOVERY=false，跳过签名/公证，只在 dist/ 产出未签名包
```

---

## 用户端体验

- 首次：从 Releases 下载 `KiroTaskMonitor-<版本>-universal.dmg`，拖进 Applications。因为已签名公证，双击即可打开，无需右键绕过 Gatekeeper。
- 首次点「重试」时，系统会提示授予 **辅助功能** 与 **自动化（控制 Kiro）** 权限，允许一次即可，之后跨版本更新保留。
- 之后每次发新版，用户无需操作，启动后自动升级。

---

## 常见问题

- **公证失败 / 卡住**：确认 `APPLE_TEAM_ID` 正确、App 专用密码没过期；首次公证可能要几分钟。
- **权限更新后失效**：只要签名身份（Developer ID）和 `appId` 不变，辅助功能授权会保留；换证书会需要用户重新授权。
- **universal 包体积大**：同时含 arm64/x64。若只面向 Apple Silicon，可把 `electron-builder.yml` 里 `arch: [universal]` 改为 `[arm64]`。
