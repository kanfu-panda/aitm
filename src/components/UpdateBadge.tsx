import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateCheck, type UpdateCheckResult } from "../lib/tauri";

/**
 * 升级提示徽标（v0.2.1）。
 *
 * 启动后**一次性**调 `update_check`（GitHub Releases API），有新版本 →
 * 渲染一个小链接 "↑ vX.Y.Z 可用"，点击在系统浏览器打开 release 页让用户
 * 自行下载安装。
 *
 * 设计决议：
 * - 启动一次，不轮询（用户重启不频繁；偶尔错过一周更新可接受）
 * - API 失败静默 → 不打扰
 * - 点击**打开"关于"页**而不是浏览器：那里能直接应用内下载安装，
 *   装不了时也还有手动下载链接兜底
 *
 * **统一渲染策略**：没有更新或检查未完成 → 返回 null，不占空间。
 */
/** 请求打开设置面板的"关于"页。App.tsx 监听 window 上的这个事件。 */
export const OPEN_ABOUT_EVENT = "aitm:open-about";
export default function UpdateBadge() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    let alive = true;
    updateCheck()
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch((e) => {
        // 静默：mock 环境 / 启动早期 invoke 失败不影响 UI
        console.warn("升级检查失败", e);
      });
  }, []);

  if (!info?.available) return null;

  const handleClick = () => {
    window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT));
  };

  const tooltip = info.release_notes
    ? t("updateBadge.tooltipWithNotes", {
        current: info.current_version,
        latest: info.latest_version,
        notes: info.release_notes,
      })
    : t("updateBadge.tooltipNoNotes", {
        current: info.current_version,
        latest: info.latest_version,
      });

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex items-center gap-1 rounded px-1 text-[var(--c-success-fg)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-success)]"
      title={tooltip}
      aria-label={t("updateBadge.ariaLabel", { version: info.latest_version })}
      data-testid="update-badge"
    >
      <span aria-hidden>↑</span>
      <span>{t("updateBadge.available", { version: info.latest_version })}</span>
    </button>
  );
}
