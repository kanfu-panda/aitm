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
 * - 启动查一次，之后每 6 小时再查一次。终端是开着不关的应用，一台机器连开
 *   一周很常见；"只在启动查一次"意味着这一周里发的版本用户完全不知道。
 * - API 失败静默 → 不打扰，也不中断后续轮询（下个周期照常再试）
 * - 点击**打开"关于"页**而不是浏览器：那里能直接应用内下载安装，
 *   装不了时也还有手动下载链接兜底
 *
 * **统一渲染策略**：没有更新或检查未完成 → 返回 null，不占空间。
 */
/** 请求打开设置面板的"关于"页。App.tsx 监听 window 上的这个事件。 */
export const OPEN_ABOUT_EVENT = "aitm:open-about";

/**
 * 后台轮询检查更新的间隔（6 小时）。
 *
 * 取值权衡：GitHub Releases API 对未认证请求限 60 次/小时/IP，6 小时一次
 * 连开一个月也才 120 次，完全够不着限流；同时"发版后最迟半天被发现"对
 * 一个终端应用来说够及时了。别再往下调——这是无认证的公共 API。
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default function UpdateBadge() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () => {
      updateCheck()
        .then((r) => {
          if (alive) setInfo(r);
        })
        .catch((e) => {
          // 静默：mock 环境 / 启动早期 invoke 失败不影响 UI。
          // 不 return / 不清 interval —— 一次网络抖动不该让这台机器
          // 从此再也不检查更新。
          console.warn("升级检查失败", e);
        });
    };
    check();
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
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
