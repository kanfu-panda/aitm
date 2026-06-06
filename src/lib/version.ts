export function appVersion(): string {
  // Phase 0 先硬编码并与 package.json 对齐。
  // Phase 1 接通 Tauri IPC 后改为读取 Rust 端的 version::current()。
  return "0.0.1";
}

export function isSemverLike(v: string): boolean {
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^\d+$/.test(p));
}
