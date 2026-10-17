/**
 * latest.json 的纯逻辑部分（无文件读写、无进程退出），供 make-latest-json.mjs 调用与单测。
 *
 * - `verifySignature`：用 tauri.conf.json 里的公钥校验 minisign 签名，
 *   在上传前就发现"签名私钥和公钥不是一对 / 签错了文件"，而不是等用户更新失败
 * - `buildLatest`：拼出 tauri-plugin-updater 读取的清单
 */

import { createHash, createPublicKey, verify } from "node:crypto";

/** ed25519 公钥的 SPKI DER 前缀，后接 32 字节原始公钥即可交给 node:crypto */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Windows 安装包架构 → Tauri NSIS 产物文件名里的架构段 */
const WINDOWS_ARCH = { x86_64: "x64", aarch64: "arm64" };

/** tauri 把 minisign 文本整体 base64 后存放；解开后取非注释行 */
function decodeMinisign(b64) {
  const lines = Buffer.from(b64.trim(), "base64").toString("utf8").split("\n");
  return lines.map((l) => l.trim()).filter(Boolean);
}

function parsePubkey(pubkeyB64) {
  const lines = decodeMinisign(pubkeyB64);
  const raw = lines[1] ? Buffer.from(lines[1], "base64") : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("公钥格式不对：应为 minisign 公钥（Ed + 8 字节 key id + 32 字节公钥）");
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

/**
 * 校验 `bytes` 的 minisign 签名，不通过直接抛错（附原因）。
 *
 * tauri signer 产出的是预哈希签名（算法标记 `ED`）：对文件的 BLAKE2b-512 摘要签名；
 * 另有一段"全局签名"覆盖 签名 + trusted comment，防止注释被篡改。两段都要验。
 */
export function verifySignature(bytes, signatureB64, pubkeyB64) {
  const pub = parsePubkey(pubkeyB64);
  const lines = decodeMinisign(signatureB64);
  const sigLine = lines[1] ? Buffer.from(lines[1], "base64") : Buffer.alloc(0);
  const trusted = lines[2]?.startsWith("trusted comment: ")
    ? lines[2].slice("trusted comment: ".length)
    : null;
  if (sigLine.length !== 74 || trusted === null || !lines[3]) {
    throw new Error("签名格式不对：应为 tauri signer 产出的 .sig 内容");
  }
  if (sigLine.subarray(0, 2).toString() !== "ED") {
    throw new Error("签名算法不对：应为 ED（BLAKE2b 预哈希），请用 tauri signer 重新签名");
  }
  if (!sigLine.subarray(2, 10).equals(pub.keyId)) {
    throw new Error("签名所用密钥与 tauri.conf.json 中的公钥不一致（key id 不同）");
  }
  const sig = sigLine.subarray(10);
  const digest = createHash("blake2b512").update(bytes).digest();
  if (!verify(null, digest, pub.key, sig)) {
    throw new Error("签名不匹配：文件内容与签名对不上，或签名私钥与公钥不是一对");
  }
  const global = Buffer.from(lines[3], "base64");
  if (!verify(null, Buffer.concat([sig, Buffer.from(trusted)]), pub.key, global)) {
    throw new Error("全局签名不匹配：trusted comment 被改动过");
  }
}

/** Tauri NSIS 安装包文件名，如 `aitm_1.9.0_x64-setup.exe` */
export function windowsInstallerName(version, arch) {
  const seg = WINDOWS_ARCH[arch];
  if (!seg) throw new Error(`不支持的 Windows 架构：${arch}`);
  return `aitm_${version}_${seg}-setup.exe`;
}

/**
 * 拼出 latest.json。
 *
 * Windows 两个架构都指向 NSIS 安装包：当前打包工具不会在程序里写入安装方式，
 * 更新器只按 `windows-<架构>` 查找，无法区分用户是用 MSI 还是 NSIS 装的。
 */
export function buildLatest({ repo, version, notes, pubDate, macSignature, windowsSignatures }) {
  const tag = `v${version}`;
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const platforms = {
    "darwin-aarch64": { signature: macSignature, url: `${base}/aitm.app.tar.gz` },
  };
  for (const arch of Object.keys(WINDOWS_ARCH)) {
    const signature = windowsSignatures?.[arch];
    if (!signature) throw new Error(`缺少 Windows ${arch} 安装包的签名`);
    platforms[`windows-${arch}`] = {
      signature,
      url: `${base}/${windowsInstallerName(version, arch)}`,
    };
  }
  return { version, notes: notes ?? `aitm ${tag}`, pub_date: pubDate, platforms };
}
