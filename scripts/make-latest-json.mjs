#!/usr/bin/env node
/**
 * 生成 tauri-plugin-updater 用的 latest.json。
 *
 * 应用启动/用户手动检查时会去拉
 * `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`，
 * 按里面的 version 跟自己比对，有新版就下 platforms.<target>.url 指的包，
 * 并用 signature 字段（minisign 签名）校验后再安装。
 *
 * 用法（在打完包、拿到 .app.tar.gz.sig 之后跑）：
 *
 *   node scripts/make-latest-json.mjs --version 1.4.0 [--notes "更新说明"] [--out latest.json]
 *
 * 前置：`pnpm tauri build` 必须已经生成 updater 产物，也就是
 * `src-tauri/target/release/bundle/macos/aitm.app.tar.gz{,.sig}`
 * （需要 tauri.conf.json 里 bundle.createUpdaterArtifacts = true，
 *  且 build 时设了 TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]）。
 *
 * 目前只产 macOS arm64 一档 —— Windows 包在 CI 里出、签名私钥不出本机，
 * 所以 Windows 走"提示 + 手动下载安装包"那条路，不进 latest.json。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "kanfu-panda/aitm";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Tauri bundler 输出的 macOS 更新包（文件名固定，不带版本号） */
const MAC_BUNDLE = "src-tauri/target/release/bundle/macos/aitm.app.tar.gz";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) die(`无法识别的参数：${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const version = args.version;
if (!version) die("缺 --version（如 --version 1.4.0）");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die(`版本号格式不对：${version}`);

const sigPath = resolve(ROOT, `${MAC_BUNDLE}.sig`);
if (!existsSync(sigPath)) {
  die(
    `找不到签名文件 ${sigPath}\n` +
      `  先跑 pnpm tauri build（需 TAURI_SIGNING_PRIVATE_KEY），确认 createUpdaterArtifacts 已开`,
  );
}
const signature = readFileSync(sigPath, "utf8").trim();
if (!signature) die(`签名文件是空的：${sigPath}`);

const tag = `v${version}`;
const latest = {
  version,
  notes: args.notes ?? `aitm ${tag}`,
  // 固定用 UTC，避免不同机器时区导致 pub_date 对不上
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  platforms: {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/${REPO}/releases/download/${tag}/aitm.app.tar.gz`,
    },
  },
};

const out = resolve(ROOT, args.out ?? "latest.json");
writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
console.log(`✓ 已生成 ${out}（version=${version}）`);
console.log(`  接着把它和 aitm.app.tar.gz 一起传上去：`);
console.log(`    gh release upload ${tag} ${out} ${resolve(ROOT, MAC_BUNDLE)}`);
