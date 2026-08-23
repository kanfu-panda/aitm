import type { DiagnosticsInfo } from "./tauri";

/** 开源仓的新建 issue 地址。 */
const NEW_ISSUE_URL = "https://github.com/kanfu-panda/aitm/issues/new";

/**
 * 预填进 issue body 的诊断文本长度上限。
 *
 * GitHub 对 URL 长度没有明文规定，但浏览器和中间层普遍在 8KB 左右开始出问题，
 * 而中文经 `encodeURIComponent` 后一个字符要占 9 字节。留 2000 字符的余量足够
 * 装下诊断信息，真超了说明有异常内容，截断比整个链接打不开好。
 */
export const ISSUE_BODY_MAX = 2000;

/** 目录路径取不到时的占位，避免把 "null" 直接摆给用户看。 */
const UNKNOWN = "（取不到）";

/**
 * 把诊断信息拼成可直接粘进 issue 的纯文本。
 *
 * 只放用户机器上的公开环境信息：版本、平台、日志 / 配置**目录**、UA。
 * 不放配置内容——`~/.aitm/config.toml` 里有 API key，只给目录路径。
 *
 * userAgent 单独传进来而不在函数里读 `navigator`，是为了能在单测里固定它。
 */
export function buildDiagnosticsText(
  info: DiagnosticsInfo,
  userAgent: string,
): string {
  return [
    `aitm 版本: ${info.version}`,
    `平台: ${info.os} ${info.arch}`,
    `日志目录: ${info.log_dir ?? UNKNOWN}`,
    `配置目录: ${info.config_dir ?? UNKNOWN}`,
    `UA: ${userAgent}`,
  ].join("\n");
}

/**
 * 生成带预填 body 的"新建 issue"链接。
 *
 * 比"复制到剪贴板再让用户自己粘"少一步，也避免了剪贴板权限在 webview 里
 * 时灵时不灵的问题。
 *
 * `logTail` 是日志尾部（可选）。只有环境信息的 issue 对排查几乎没帮助——真正
 * 有用的是报错现场。日志放在环境信息**之后**：整体超长时先砍日志，保证版本
 * 平台这些永远不会被截掉。
 */
export function buildIssueUrl(
  diagnostics: string,
  logTail?: string | null,
): string {
  let body = diagnostics;
  if (logTail?.trim()) {
    const room = ISSUE_BODY_MAX - diagnostics.length - LOG_SECTION_OVERHEAD;
    if (room > 0) {
      // 超长时留尾部：日志越靠后越接近现场
      const tail =
        logTail.length > room ? logTail.slice(logTail.length - room) : logTail;
      body = `${diagnostics}\n\n最近日志：\n\`\`\`\n${tail}\n\`\`\``;
    }
  }
  return `${NEW_ISSUE_URL}?body=${encodeURIComponent(
    body.length > ISSUE_BODY_MAX ? body.slice(0, ISSUE_BODY_MAX) : body,
  )}`;
}

/** 日志段的固定开销（标题 + 两道代码围栏 + 换行），算可用空间时要扣掉。 */
const LOG_SECTION_OVERHEAD = "\n\n最近日志：\n```\n\n```".length;
