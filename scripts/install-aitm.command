#!/usr/bin/env bash
#
# install-aitm.command — aitm dmg 内嵌的安装辅助脚本（macOS）
#
# macOS 双击 `.command` 文件自动用 Terminal 跑，体验比 `.sh` 友好。
#
# 流程（dmg 已挂载、Finder 打开 dmg 内容）：
# 1. 检查 /Applications/aitm.app 是否存在
#    - 在 → 仅清 quarantine（用户已拖过）
#    - 不在 → 从同目录的 aitm.app 自动 cp 到 /Applications/，再清 quarantine
# 2. 成功提示，等用户按键关闭 Terminal 窗口
#
# 为何需要：aitm 暂无 Apple Developer 证书；未签名 dmg 通过下载传输到 macOS
# 后被 Gatekeeper 加 com.apple.quarantine 标记 → 双击 .app 报"已损坏"。
# 本脚本自动 xattr 清除该标记。

set -euo pipefail

echo ""
echo "=========================================="
echo "  aitm 安装"
echo "=========================================="
echo ""

# 脚本所在目录 = 挂载的 dmg 根目录
DMG_ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$DMG_ROOT/aitm.app"
APP_DEST="/Applications/aitm.app"

# 检测是否已拖
if [[ -d "$APP_DEST" ]]; then
    echo "✓ 已发现 /Applications/aitm.app"
else
    echo "→ /Applications/ 没有 aitm.app，正在自动拷贝..."

    if [[ ! -d "$APP_SRC" ]]; then
        echo ""
        echo "❌ 错误：在 dmg 里找不到 aitm.app"
        echo "   脚本路径：$DMG_ROOT"
        echo "   请确认这个 .command 文件是在已挂载的 aitm dmg 内运行的。"
        echo ""
        read -rsn1 -p "按任意键退出..."
        echo ""
        exit 1
    fi

    cp -R "$APP_SRC" /Applications/
    echo "✓ 已拷贝 aitm.app 到 /Applications/"
fi

# 清 quarantine 标记
echo "→ 清除 macOS quarantine 标记..."
xattr -cr "$APP_DEST"
echo "✓ 完成"

echo ""
echo "=========================================="
echo "  ✅ 安装成功"
echo "=========================================="
echo ""
echo "  通过 Launchpad / Spotlight 搜 \"aitm\" 启动即可。"
echo ""
echo "  如未来 aitm 改用 Apple Developer 签名后，"
echo "  双击 dmg 后直接拖到 Applications 即可，无需此脚本。"
echo ""
read -rsn1 -p "按任意键关闭此窗口..."
echo ""
