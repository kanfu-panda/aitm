# 发版流程（macOS 与 Windows 应用内自动更新）

Windows 安装包由 CI 在 tag 推送后生成，签名与清单在本机完成；macOS 全程在本机。

## 一次发布要产出什么

挂到同一个 GitHub Release 上、与更新有关的东西：

| 产物 | 作用 |
|---|---|
| `aitm_<版本>_aarch64.dmg` | 首次安装 / 手动升级用（已签名 + 公证） |
| `aitm.app.tar.gz` | **应用内自动更新**下载的增量包 |
| `aitm.app.tar.gz.sig` | 上面那个包的 minisign 签名（不上传也行，签名值已内联进 latest.json） |
| `aitm_<版本>_x64-setup.exe` / `aitm_<版本>_arm64-setup.exe` | Windows 安装包（CI 上传）；同时是 Windows **应用内自动更新**下载的包 |
| `latest.json` | 更新器的清单：版本号 + 各平台下载地址 + 签名 |

少了 `latest.json`，老用户的"检查更新"会退回到"给个下载链接让你手动装"。

## 两套密钥，别搞混

- **Apple Developer ID**：给 `.app` / `.dmg` 签名 + 公证，决定 Gatekeeper 放不放行。
- **更新签名密钥（minisign）**：给 `aitm.app.tar.gz` 和 Windows 安装包签名，决定应用愿不愿意安装这个更新包。
  - 公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
  - 私钥在 `~/.tauri/aitm-updater.key`（**绝不进仓库**），密码存在 keychain
  - 私钥丢了 = 所有已装用户再也收不到自动更新（只能手动下 dmg 重装），务必备份

## 步骤

### 1. 改版本号（三处必须一致）

`src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json`。

### 2. 打包（带更新产物）

`bundle.createUpdaterArtifacts` 已开，所以 build 时**必须**提供更新签名私钥，否则 bundler 直接报错：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/aitm-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a aitm -s aitm-updater-key -w)"
pnpm tauri build
unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

产物在 `src-tauri/target/release/bundle/`：`dmg/` 下是安装包，`macos/` 下是
`aitm.app.tar.gz` 和 `.sig`。

### 3. 公证 dmg

```bash
DMG=src-tauri/target/release/bundle/dmg/aitm_<版本>_aarch64.dmg
xcrun notarytool submit "$DMG" --keychain-profile "aitm-notary" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -v "$DMG"   # 应为 accepted / Notarized Developer ID
```

### 4. 给 Windows 安装包签名

等 CI「发布 Windows」跑完、两个 setup.exe 已挂到 Release 上，再下载回本机签名。
私钥不上传 GitHub，所以 CI 只打包不签名。

```bash
WIN=$(mktemp -d)
gh release download v<版本> -R kanfu-panda/aitm -p '*-setup.exe' -D "$WIN"
export TAURI_PRIVATE_KEY_PATH="$HOME/.tauri/aitm-updater.key"
export TAURI_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a aitm -s aitm-updater-key -w)"
for f in "$WIN"/*-setup.exe; do pnpm tauri signer sign "$f"; done
unset TAURI_PRIVATE_KEY_PASSWORD
```

注意 `tauri signer sign` 读的环境变量是 `TAURI_PRIVATE_KEY_*`，与第 2 步 build 用的
`TAURI_SIGNING_PRIVATE_KEY_*` 名字不同。

Windows 两个架构都只给 NSIS 安装包（`-setup.exe`）签名：当前打包工具不会在程序里写入
安装方式，更新器只按 `windows-<架构>` 查找，分不出用户装的是 MSI 还是 NSIS。用 MSI
装的用户更新后会多出一份 NSIS 安装。

### 5. 生成 latest.json

```bash
node scripts/make-latest-json.mjs --version <版本> --windows-dir "$WIN" --notes "一句话更新说明"
```

脚本读第 2 步的 macOS `.sig` 与第 4 步的两个 Windows `.sig`，**先用 `tauri.conf.json`
里的公钥逐个校验**，全部通过才内联进清单；任何一个缺失或对不上都直接报错，不会生成
半成品。

### 6. 传上去

```bash
gh release upload v<版本> \
  "$DMG" \
  src-tauri/target/release/bundle/macos/aitm.app.tar.gz \
  latest.json
```

`latest.json` 的名字**不能改**——更新器写死了拉
`releases/latest/download/latest.json`。

### 7. 验一遍（别跳）

macOS 与 Windows 各拿一台装着**上一个版本**的机器（或虚拟机），打开 设置 → 关于 → 检查更新，
应该看到新版本号和"下载并安装"，装完自动重启，重启后关于页显示新版本号。

只看 `latest.json` 传上去了就宣布发版完成，是不够的——签名对不上时更新器会静默失败，
只有真的装一次才能发现。

## 常见坑

- **build 报 "A public key has been found, but no private key"**：第 2 步的两个环境变量没设。
- **更新器报签名校验失败**：`latest.json` 里的 signature 是上一个版本的（重跑第 5 步）。
  私钥与公钥不是一对的情况，第 5 步的脚本已经会拦下。
- **检查更新一直说"已是最新"**：`latest.json` 里的 `version` 没跟着 bump。
- **老版本用户收不到自动更新**：v1.3.0 及更早的包里没有更新器，只能手动下 dmg 装一次，
  之后才进得了自动更新的轨道。
- **Windows 检查更新退回"手动下载"**：`latest.json` 里没有 `windows-x86_64` /
  `windows-aarch64`（第 5 步漏了 `--windows-dir`，或用的是旧脚本生成的清单）。
