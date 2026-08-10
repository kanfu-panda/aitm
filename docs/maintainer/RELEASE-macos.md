# macOS 发版流程（含应用内自动更新）

面向维护者。Windows 产物由 CI 在 tag 推送后生成，本文只讲 macOS 本地这条线。

## 一次发布要产出什么

挂到同一个 GitHub Release 上的四样东西：

| 产物 | 作用 |
|---|---|
| `aitm_<版本>_aarch64.dmg` | 首次安装 / 手动升级用（已签名 + 公证） |
| `aitm.app.tar.gz` | **应用内自动更新**下载的增量包 |
| `aitm.app.tar.gz.sig` | 上面那个包的 minisign 签名（不上传也行，签名值已内联进 latest.json） |
| `latest.json` | 更新器的清单：版本号 + 下载地址 + 签名 |

少了 `latest.json`，老用户的"检查更新"会退回到"给个下载链接让你手动装"。

## 两套密钥，别搞混

- **Apple Developer ID**：给 `.app` / `.dmg` 签名 + 公证，决定 Gatekeeper 放不放行。
- **更新签名密钥（minisign）**：给 `aitm.app.tar.gz` 签名，决定应用愿不愿意安装这个更新包。
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

### 4. 生成 latest.json

```bash
node scripts/make-latest-json.mjs --version <版本> --notes "一句话更新说明"
```

脚本会读第 2 步产出的 `.sig` 并内联进去；`.sig` 不存在会直接报错，不会生成半成品。

### 5. 传上去

```bash
gh release upload v<版本> \
  "$DMG" \
  src-tauri/target/release/bundle/macos/aitm.app.tar.gz \
  latest.json
```

`latest.json` 的名字**不能改**——更新器写死了拉
`releases/latest/download/latest.json`。

### 6. 验一遍（别跳）

拿一台装着**上一个版本**的机器（或把本机的 aitm 降级），打开 设置 → 关于 → 检查更新，
应该看到新版本号和"下载并安装"，装完自动重启，重启后关于页显示新版本号。

只看 `latest.json` 传上去了就宣布发版完成，是不够的——签名对不上时更新器会静默失败，
只有真的装一次才能发现。

## 常见坑

- **build 报 "A public key has been found, but no private key"**：第 2 步的两个环境变量没设。
- **更新器报签名校验失败**：`tauri.conf.json` 里的 pubkey 和签包用的私钥不是一对，
  或 `latest.json` 里的 signature 是上一个版本的（重跑第 4 步）。
- **检查更新一直说"已是最新"**：`latest.json` 里的 `version` 没跟着 bump。
- **老版本用户收不到自动更新**：v1.3.0 及更早的包里没有更新器，只能手动下 dmg 装一次，
  之后才进得了自动更新的轨道。
