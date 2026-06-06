#!/usr/bin/env bash
#
# install-aitm.sh — aitm macOS 首次安装辅助脚本
#
# 为何需要：
#   aitm 暂无 Apple Developer 证书（计划未来以公司名义申请），dmg 未签名。
#   macOS 把通过浏览器 / AirDrop / 飞书 / IM 等下载的未签名 .app 自动加
#   `com.apple.quarantine` 扩展属性 → 双击启动报 "aitm 已损坏，无法打开"
#   （实际上是 Gatekeeper 拒绝运行，文案误导）。
#
#   本脚本：mount dmg → 拷 .app 到 /Applications/ → 用 xattr 清 quarantine
#   标记。完成后正常 Launchpad / Spotlight 启动即可。
#
# 用法：
#   bash install-aitm.sh                       # 自动找 ~/Downloads/aitm_*_aarch64.dmg 最新版
#   bash install-aitm.sh /path/to/aitm.dmg     # 显式指定 dmg
#
# 安全：脚本只动 /Applications/aitm.app 和指定 dmg；不需要 sudo。

set -euo pipefail

# ===== 参数 =====

if [[ $# -ge 1 ]]; then
    DMG="$1"
else
    DMG=$(ls -t ~/Downloads/aitm_*_aarch64.dmg 2>/dev/null | head -1 || true)
    if [[ -z "$DMG" ]]; then
        echo "ERROR: 没在 ~/Downloads/ 找到 aitm_*_aarch64.dmg" >&2
        echo "用法: bash install-aitm.sh [/path/to/aitm.dmg]" >&2
        exit 1
    fi
    echo ">>> 自动发现 dmg：$DMG"
fi

if [[ ! -f "$DMG" ]]; then
    echo "ERROR: dmg 不存在：$DMG" >&2
    exit 1
fi

# ===== 解 dmg quarantine（防 mount 后 .app 继承）=====

echo ">>> 解 dmg quarantine 标记"
xattr -cr "$DMG" 2>/dev/null || true

# ===== Mount =====

# hdiutil attach 输出 device + mountpoint，最后一行通常是 Volumes 路径
MOUNT_INFO=$(hdiutil attach -nobrowse -readonly "$DMG")
MOUNT_DIR=$(echo "$MOUNT_INFO" | tail -1 | awk '{for(i=3;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}')

if [[ -z "$MOUNT_DIR" || ! -d "$MOUNT_DIR" ]]; then
    echo "ERROR: hdiutil 挂载失败" >&2
    echo "$MOUNT_INFO" >&2
    exit 1
fi
echo ">>> dmg 挂载在 $MOUNT_DIR"

# 退出时务必 detach（避免 dmg 留 mount）
cleanup() { hdiutil detach -quiet "$MOUNT_DIR" 2>/dev/null || true; }
trap cleanup EXIT

# ===== 找 .app =====

APP_SRC=$(ls -d "$MOUNT_DIR"/*.app 2>/dev/null | head -1 || true)
if [[ -z "$APP_SRC" ]]; then
    echo "ERROR: dmg 里找不到 .app" >&2
    exit 1
fi
APP_NAME=$(basename "$APP_SRC")
APP_DEST="/Applications/$APP_NAME"

# ===== 已装则替换 =====

if [[ -d "$APP_DEST" ]]; then
    echo ">>> /Applications/$APP_NAME 已存在，删旧版"
    rm -rf "$APP_DEST"
fi

# ===== Copy =====

echo ">>> 复制 $APP_NAME → /Applications/"
cp -R "$APP_SRC" /Applications/

# ===== 解 quarantine =====

echo ">>> 清 quarantine 标记"
xattr -cr "$APP_DEST"

# ===== 完成 =====

echo ""
echo "✅ 安装完成。"
echo "   通过 Launchpad / Spotlight 搜 \"${APP_NAME%.app}\" 启动即可。"
echo "   如未来 aitm 改用 Apple Developer 签名后，无需此脚本。"
