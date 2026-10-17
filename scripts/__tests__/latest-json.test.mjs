// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  buildLatest,
  verifySignature,
  windowsInstallerName,
} from "../latest-json.mjs";

const REPO = "kanfu-panda/aitm";

/**
 * 按 minisign 格式造一对测试密钥与签名（与 tauri signer 的产物同构）：
 * - 公钥文本：`untrusted comment` + base64("Ed" | 8 字节 key id | 32 字节公钥)
 * - 签名文本：base64("ED" | key id | ed25519(BLAKE2b-512(文件))) + trusted comment + 全局签名
 * 两者在 tauri 里都再整体 base64 一次，这里照做。
 */
function makeKey(keyIdHex = "0102030405060708") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = Buffer.from(keyIdHex, "hex");
  const pkLine = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const pubText = `untrusted comment: minisign public key: ${keyIdHex}\n${pkLine}\n`;
  return { privateKey, keyId, pubkey: Buffer.from(pubText).toString("base64") };
}

function makeSig(key, bytes, { keyId = key.keyId, trusted = "timestamp:1\tfile:x" } = {}) {
  const digest = createHash("blake2b512").update(bytes).digest();
  const sig = sign(null, digest, key.privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key.privateKey);
  const sigLine = Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64");
  const text =
    `untrusted comment: signature from tauri secret key\n${sigLine}\n` +
    `trusted comment: ${trusted}\n${global.toString("base64")}`;
  return Buffer.from(text).toString("base64");
}

describe("verifySignature", () => {
  const key = makeKey();
  const bytes = Buffer.from("aitm installer bytes");

  it("签名与公钥、文件都对得上时通过", () => {
    expect(() => verifySignature(bytes, makeSig(key, bytes), key.pubkey)).not.toThrow();
  });

  it("文件内容被改过时报签名不匹配", () => {
    const sig = makeSig(key, bytes);
    expect(() => verifySignature(Buffer.from("tampered"), sig, key.pubkey)).toThrow(/签名不匹配/);
  });

  it("用另一把私钥签的包报密钥不一致", () => {
    const other = makeKey("1111111111111111");
    expect(() => verifySignature(bytes, makeSig(other, bytes), key.pubkey)).toThrow(/与 tauri.conf.json 中的公钥不一致/);
  });

  it("key id 相同但私钥不同时报签名不匹配", () => {
    const impostor = makeKey("0102030405060708");
    expect(() => verifySignature(bytes, makeSig(impostor, bytes), key.pubkey)).toThrow(/签名不匹配/);
  });

  it("trusted comment 被改过时报全局签名不匹配", () => {
    const text = Buffer.from(makeSig(key, bytes), "base64")
      .toString()
      .replace("file:x", "file:y");
    expect(() =>
      verifySignature(bytes, Buffer.from(text).toString("base64"), key.pubkey),
    ).toThrow(/trusted comment/);
  });

  it("签名文本格式不对时给出明确错误", () => {
    expect(() =>
      verifySignature(bytes, Buffer.from("garbage").toString("base64"), key.pubkey),
    ).toThrow(/签名格式/);
  });

  it("签名算法不是 ED（预哈希）时拒绝", () => {
    const text = Buffer.from(makeSig(key, bytes), "base64").toString().split("\n");
    const raw = Buffer.from(text[1], "base64");
    raw.write("Ed", 0);
    text[1] = raw.toString("base64");
    expect(() =>
      verifySignature(bytes, Buffer.from(text.join("\n")).toString("base64"), key.pubkey),
    ).toThrow(/签名算法/);
  });

  it("公钥格式不对时给出明确错误", () => {
    expect(() =>
      verifySignature(bytes, makeSig(key, bytes), Buffer.from("x\ny\n").toString("base64")),
    ).toThrow(/公钥格式/);
  });
});

describe("windowsInstallerName", () => {
  it("按 Tauri NSIS 产物命名", () => {
    expect(windowsInstallerName("1.9.0", "x86_64")).toBe("aitm_1.9.0_x64-setup.exe");
    expect(windowsInstallerName("1.9.0", "aarch64")).toBe("aitm_1.9.0_arm64-setup.exe");
  });

  it("未知架构直接报错", () => {
    expect(() => windowsInstallerName("1.9.0", "i686")).toThrow(/架构/);
  });
});

describe("buildLatest", () => {
  const base = {
    repo: REPO,
    version: "1.9.0",
    notes: "说明",
    pubDate: "2026-10-13T00:00:00Z",
    macSignature: "MAC",
    windowsSignatures: { x86_64: "WIN64", aarch64: "WINARM" },
  };

  it("包含 macOS 与两个 Windows 架构，下载地址指向同一 tag", () => {
    expect(buildLatest(base)).toEqual({
      version: "1.9.0",
      notes: "说明",
      pub_date: "2026-10-13T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "MAC",
          url: `https://github.com/${REPO}/releases/download/v1.9.0/aitm.app.tar.gz`,
        },
        "windows-x86_64": {
          signature: "WIN64",
          url: `https://github.com/${REPO}/releases/download/v1.9.0/aitm_1.9.0_x64-setup.exe`,
        },
        "windows-aarch64": {
          signature: "WINARM",
          url: `https://github.com/${REPO}/releases/download/v1.9.0/aitm_1.9.0_arm64-setup.exe`,
        },
      },
    });
  });

  it("缺任一 Windows 架构的签名时报错，不产出半成品", () => {
    expect(() =>
      buildLatest({ ...base, windowsSignatures: { x86_64: "WIN64" } }),
    ).toThrow(/aarch64/);
  });

  it("没给更新说明时用默认文案", () => {
    expect(buildLatest({ ...base, notes: undefined }).notes).toBe("aitm v1.9.0");
  });
});
