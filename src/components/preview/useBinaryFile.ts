/* =============================================================================
 * useBinaryFile.ts —— 按路径读取预览文件原始字节的状态机
 * -----------------------------------------------------------------------------
 * 图片 / 表格 / Word / PPT 查看器共用：loading → ready(data) / tooLarge / error。
 * path 或 reloadKey（文件 mtime）变化时重新读取；换路径或卸载后到达的旧结果直接丢弃。
 * ========================================================================== */

import { useEffect, useState } from "react";
import { fsReadBinary } from "../../lib/tauri";
import { backendErrorCode } from "../../lib/backendError";

export type BinaryState =
  | { status: "loading" }
  | { status: "ready"; data: ArrayBuffer }
  | { status: "tooLarge"; size: number; max: number }
  | { status: "error"; error: unknown };

export function useBinaryFile(path: string, reloadKey: number | undefined): BinaryState {
  const [state, setState] = useState<BinaryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fsReadBinary(path).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (cancelled) return;
        const coded = backendErrorCode(error);
        if (coded?.code === "fs.fileTooLarge") {
          setState({
            status: "tooLarge",
            size: Number(coded.params.size),
            max: Number(coded.params.max),
          });
        } else {
          setState({ status: "error", error });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  return state;
}
