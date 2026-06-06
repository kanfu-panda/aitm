# Windows 打包 aitm 完整指南

> 给 维护者 v0.8.1 起在 mac 上的 Windows VM 跑 `pnpm tauri build` 出 `.msi` 安装包。
> 也适用于真机 Windows build。
> 完成后产物：`src-tauri/target/release/bundle/msi/aitm_X.Y.Z_x64_en-US.msi`

---

## 0. VM 准备

### 推荐配置
- **Parallels Desktop**（Mac ARM）或 **UTM**（免费）跑 Windows 11
- VM 资源：≥ 8GB RAM, ≥ 60GB 磁盘, ≥ 4 vCPU
- VM arch：跟 release target 对齐
  - x86_64 .msi → x86_64 Windows VM
  - arm64 .msi → ARM Windows VM
- Windows 版本：**Win10 1809+** 或 **Win11**（aitm 最低支持 Win10，VM 用 Win11 更稳）

---

## 1. 装开发依赖（VM 内一次性）

### 1.1 Rust toolchain

去 https://rustup.rs/ 下载 `rustup-init.exe`，跑装。完成后开 PowerShell：

```powershell
rustc --version  # 应显示 rustc 1.8x.x
cargo --version
```

### 1.2 Node.js + pnpm

去 https://nodejs.org/ 下载 LTS（v20+），跑 installer。

```powershell
node --version  # v20+
npm install -g pnpm
pnpm --version
```

### 1.3 Visual Studio 2022 Build Tools

Tauri 在 Windows 需要 **MSVC** linker。装 [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选：
- ✓ "Desktop development with C++" 工作负载
- ✓ Windows 10/11 SDK（最新版）
- ✓ MSVC v143 toolset

装完重启。

### 1.4 WebView2 Runtime

- Win11 默认带 WebView2 — 跳过这步
- Win10 装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Evergreen Bootstrapper）
  > Tauri 默认**不 embed** WebView2 到 installer（保 installer < 20MB），用户首次启动 aitm 时如果检测无 WebView2 会弹引导下载页。
  > 开发期 VM 内必须先装 WebView2 才能跑 `pnpm tauri dev`。

### 1.5 Git + 拉代码

```powershell
git --version  # Win11 自带；Win10 装 https://git-scm.com/
git clone git@github.com:kanfu-panda/aitm.git
cd aitm
```

如果用 SSH 推送：把 mac 上的 SSH key 复制到 VM `C:\Users\<You>\.ssh\` 或新建 key 加到 GitHub。

---

## 2. Build .msi

VM 内 PowerShell：

```powershell
cd aitm
git pull
pnpm install
pnpm tauri build
```

预期产物：
```
src-tauri\target\release\bundle\msi\aitm_X.Y.Z_x64_en-US.msi   # ~10-15MB
src-tauri\target\release\bundle\nsis\aitm_X.Y.Z_x64-setup.exe  # ~10-15MB（如果配了 NSIS）
src-tauri\target\release\aitm.exe                             # 裸 binary
```

**首次 build 时间**：~10-20 分钟（Rust 编译 cargo deps + Tauri bundler 跑）。

---

## 3. 大小目标 < 20MB 检查

```powershell
ls src-tauri\target\release\bundle\msi\
```

如果 .msi 大于 20MB，检查：

1. **是否 embed 了 WebView2 runtime**：看 `src-tauri/tauri.conf.json` 内 `bundle.windows.webviewInstallMode` 应是 `"downloadBootstrapper"` 或 `"skip"`，**不能**是 `"offlineInstaller"`（offline 会把 ~100MB WebView2 打进 installer）
2. **是否多余字体被打包**：检查 `dist/assets/*.woff*` 是否过多 — 当前 aitm 用 IBM Plex Sans / JetBrains Mono 等开源字体走 web fonts
3. **是否 unused dependency**：跑 `cargo bloat --release --crates -n 20` 找大 crate

---

## 4. 真机测试 Checklist

把 `.msi` 拷出 VM 装到真 Windows 机器（VM 内不算真机测试，硬件 / GPU / 字体可能不同）。

跑下面 smoke：

- [ ] 双击 .msi → 安装流程顺畅，桌面 / 开始菜单出现 aitm 图标
- [ ] 启动 aitm → 应能正常启动（Win10 无 WebView2 弹引导，装完再启动）
- [ ] 终端：开 1 个 tab → 应跑 `powershell.exe` 或 `cmd.exe`（默认 `ComSpec` 环境变量）→ 输入 `dir` 看输出
- [ ] **键盘 modifier**：Ctrl+B 应切 FileTree（不是 Cmd+B；Win 上 Cmd 不存在）
- [ ] **字体**：终端应自动用 Cascadia Code（Win11 自带）或 Consolas（Win10 自带）
- [ ] 浏览器面板：开 example.com 应正常渲染
- [ ] AI 对话：选 provider 输 API key 发消息应通
- [ ] 文件预览：FileTree 点 .md → 浮动 dialog 应出现
- [ ] Aptabase：5-15 min 内 Aptabase dashboard 应看到 `app_started` event 含 OS=windows

---

## 5. Release（拷回 macOS）

VM → macOS 拷 `.msi`：

```bash
# 用 Parallels Shared Folders / UTM Drive / 或 scp
scp leo@vm.local:'C:/Users/Leo/aitm/src-tauri/target/release/bundle/msi/*.msi' \
    ./Downloads/
```

到 macOS 主仓库：

```bash
gh release upload v0.8.1 ~/Downloads/aitm_0.8.1_x64_en-US.msi
```

或者直接 VM 内 gh CLI 上传（需在 VM 装 gh + auth）。

---

## 6. 已知坑 + 排查

### 6.1 "linker `link.exe` not found"
装 VS2022 Build Tools 后**重启 VM**。或者 PowerShell 跑：
```powershell
rustup default stable-x86_64-pc-windows-msvc
```

### 6.2 `tauri build` 失败 "WebView2 not found"
开发期 VM 内必须装 WebView2 Runtime（见 §1.4）；用户端 installer 不需要 embed。

### 6.3 NSIS bundle 不输出
默认配置只出 .msi。如果想出 .exe NSIS installer：在 `tauri.conf.json` 加：
```json
"bundle": {
  "targets": ["msi", "nsis"]
}
```

### 6.4 路径反斜杠 / forward slash
Rust `std::path::Path` 跨平台 OK；JS / TS 端如果 hardcode `/` 路径分隔符可能在 Windows 出错——v0.8.0 已检查过没此问题，新加代码保持用 `path.posix.join` 或 Node `path` module。

---

## 7. 后续 Windows ARM64 build（v0.8.2）

同上流程，但：
- VM 用 Windows 11 ARM
- `rustup target add aarch64-pc-windows-msvc`
- `pnpm tauri build --target aarch64-pc-windows-msvc`
- 产物：`aitm_X.Y.Z_arm64_en-US.msi`
