import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 应用内自动更新的薄封装。
 *
 * 存在的意义有两个：
 * 1. 把 `@tauri-apps/plugin-updater` 的事件式下载进度收敛成一个 0..1 的数字，
 *    UI 不必关心 Started/Progress/Finished 三种事件
 * 2. 给组件一个可 mock 的边界（直接 mock plugin 包要连 Tauri IPC 内部一起造）
 */

/** 一个待安装的更新。`install` 装完会自动重启应用。 */
export interface PendingUpdate {
  version: string;
  notes?: string;
  /** 下载 + 安装 + 重启。`onProgress` 收到 0..1；服务端没给 Content-Length 时收到 null。 */
  install(onProgress?: (ratio: number | null) => void): Promise<void>;
}

/**
 * 问更新服务器有没有新版本。
 *
 * 无更新返回 null。**失败会抛**（endpoint 404 / 网络不通 / 签名不匹配），
 * 调用方需要自己决定是静默还是回退到手动下载。
 */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body,
    install: async (onProgress) => {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
          onProgress?.(total > 0 ? 0 : null);
        } else if (e.event === "Progress") {
          received += e.data.chunkLength;
          // 拿不到总长度时只能给 null（UI 显示不确定进度）
          onProgress?.(total > 0 ? Math.min(received / total, 1) : null);
        } else if (e.event === "Finished") {
          onProgress?.(1);
        }
      });
      // 新版本已落盘，重启才会生效
      await relaunch();
    },
  };
}
