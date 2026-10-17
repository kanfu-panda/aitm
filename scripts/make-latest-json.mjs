#!/usr/bin/env node
/**
 * 生成 tauri-plugin-updater 用的 latest.json。
 *
 * 应用启动/用户手动检查时会去拉
 * `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`，
 * 按里面的 version 跟自己比对，有新版就下 platforms.<target>.url 指的包，
 * 并用 signature 字段（minisign 签名）校验后再安装。
 *
 * 用法（macOS 包已打好、Windows 安装包已下载并签名之后跑）：
 *
 *   node scripts/make-latest-json.mjs --version 1.9.0 --windows-dir <目录> \
 *     [--notes "更新说明"] [--out latest.json]
 *
 * 前置：
 * - `pnpm tauri build` 已生成 `src-tauri/target/release/bundle/macos/aitm.app.tar.gz{,.sig}`
 *   （createUpdaterArtifacts 只在 tauri.macos.conf.json 里开，build 时需设
 *    TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]）
 * - `--windows-dir` 里有 CI 产出的两个 NSIS 安装包及本机签出的 `.sig`：
 *   `aitm_<版本>_x64-setup.exe{,.sig}`、`aitm_<版本>_arm64-setup.exe{,.sig}`
 *   （签名私钥不出本机，所以 Windows 包在 CI 里只打包、回到本机再签）
 *
 * 每个签名都会先用 tauri.conf.json 里的公钥校验，任何一个对不上就报错退出，
 * 不会生成半成品。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLatest, verifySignature, windowsInstallerName } from "./latest-json.mjs";

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

/** 读包与 .sig，校验通过后返回签名文本 */
function readVerified(bundlePath, pubkey, hint) {
  const sigPath = `${bundlePath}.sig`;
  if (!existsSync(bundlePath)) die(`找不到安装包 ${bundlePath}\n  ${hint}`);
  if (!existsSync(sigPath)) die(`找不到签名文件 ${sigPath}\n  ${hint}`);
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!signature) die(`签名文件是空的：${sigPath}`);
  try {
    verifySignature(readFileSync(bundlePath), signature, pubkey);
  } catch (e) {
    die(`${bundlePath} 签名校验失败：${e.message}`);
  }
  return signature;
}

const args = parseArgs(process.argv.slice(2));
const version = args.version;
if (!version) die("缺 --version（如 --version 1.9.0）");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die(`版本号格式不对：${version}`);
if (!args["windows-dir"]) die("缺 --windows-dir（放 Windows 安装包与 .sig 的目录）");

const pubkey = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"))
  .plugins?.updater?.pubkey;
if (!pubkey) die("tauri.conf.json 里没有 plugins.updater.pubkey");

const macSignature = readVerified(
  resolve(ROOT, MAC_BUNDLE),
  pubkey,
  "先跑 pnpm tauri build（需 TAURI_SIGNING_PRIVATE_KEY），确认 createUpdaterArtifacts 已开",
);

const winDir = resolve(args["windows-dir"]);
const windowsSignatures = {};
for (const arch of ["x86_64", "aarch64"]) {
  windowsSignatures[arch] = readVerified(
    join(winDir, windowsInstallerName(version, arch)),
    pubkey,
    "先从 Release 下载 Windows 安装包并用 tauri signer sign 签名（见 docs/maintainer/RELEASE-macos.md）",
  );
}

let latest;
try {
  latest = buildLatest({
    repo: REPO,
    version,
    notes: args.notes,
    // 固定用 UTC，避免不同机器时区导致 pub_date 对不上
    pubDate: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    macSignature,
    windowsSignatures,
  });
} catch (e) {
  die(e.message);
}

const out = resolve(ROOT, args.out ?? "latest.json");
writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
console.log(`✓ 已生成 ${out}（version=${version}，含 ${Object.keys(latest.platforms).join(" / ")}）`);
console.log(`  接着把它和 aitm.app.tar.gz 一起传上去：`);
console.log(`    gh release upload v${version} ${out} ${resolve(ROOT, MAC_BUNDLE)}`);
