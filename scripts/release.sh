#!/usr/bin/env bash
# 一键发版：读取 .env → 生成图标 → 签名 + 公证 + 打包 → 上传 GitHub Releases。
# 用法：npm version patch && bash scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 载入本地凭据（不提交）
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# 校验必需的环境变量
missing=0
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID GH_TOKEN; do
  if [ -z "${!v:-}" ]; then echo "缺少环境变量: $v（见 .env.example / RELEASE.md）"; missing=1; fi
done
[ "$missing" = "1" ] && exit 1

echo "▶ 生成图标"
node tools/make-icon.js

echo "▶ 签名 + 公证 + 打包 + 发布（版本 $(node -p "require('./package.json').version")）"
npx electron-builder --publish always

echo "✅ 发布完成，去 GitHub Releases 查看：https://github.com/DamonAmber/kiro-task-monitor/releases"
