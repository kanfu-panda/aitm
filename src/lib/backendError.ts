import i18n from "./i18n";

/**
 * 把后端错误转成当前界面语言的文本。
 *
 * 后端会显示到界面上的错误由 `ui_error::ui_err` 生成，是一段 JSON：
 * `{"code":"fs.notDir","params":{"path":"/a"},"message":"不是目录：/a"}`。
 * 识别出来就查语言包 `backendErrors.<code>` 并填入 params；语言包里没有时
 * 显示中文兜底 message。不是这种格式的错误（旧数据、第三方报错）原样显示。
 */
export function formatBackendError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const coded = parseCoded(raw);
  if (!coded) return raw;
  // 参数本身也可能是编码（如工具错误里套着具体工具的细节），逐个格式化
  const params = Object.fromEntries(
    Object.entries(coded.params).map(([k, v]) => [k, formatBackendError(v)]),
  );
  return i18n.t(`backendErrors.${coded.code}`, {
    ...params,
    defaultValue: coded.message,
  });
}

interface CodedError {
  code: string;
  params: Record<string, string>;
  message: string;
}

function parseCoded(raw: string): CodedError | null {
  if (!raw.startsWith('{"code"')) return null;
  try {
    const v = JSON.parse(raw) as Partial<CodedError>;
    if (typeof v.code !== "string" || typeof v.message !== "string") return null;
    return { code: v.code, params: v.params ?? {}, message: v.message };
  } catch {
    return null;
  }
}
