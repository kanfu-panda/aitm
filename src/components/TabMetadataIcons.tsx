import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { tabGetMetadata, type TabMetadata } from "../lib/tauri";
import { GitBranch, Activity } from "./icons";

interface Props {
  /** 后端 SessionId；为 null（session 还没开）时不轮询 */
  sessionId: string | null;
  /** true 时 5s 轮询；用于 active tab。非 active tab 传 false 节省 IPC */
  poll: boolean;
}

/**
 * v0.5.0-B：Tab 主行右侧的元信息图标 + 简略 tooltip。
 *
 * 设计要点（plan §2.6 主行图标方案）：
 * - 不撑高 tab 行（h-9 不变）
 * - 仅在 metadata 至少有一项非默认时渲染对应 icon
 * - hover 显示文本 tooltip（用原生 title 属性，不引第三方 Tooltip 避免重）
 * - 5s 轮询频率比后端 2s 刷新慢，足够新鲜
 * - 非 active tab 也保留显示（最近一次拉到的 cache），但不主动刷新
 */
export default function TabMetadataIcons({ sessionId, poll }: Props) {
  const { t } = useTranslation();
  const [meta, setMeta] = useState<TabMetadata | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setMeta(null);
      return;
    }
    let alive = true;
    const fetchOnce = () => {
      tabGetMetadata(sessionId)
        .then((m) => {
          if (alive) setMeta(m);
        })
        .catch(() => {
          // 静默：mock teardown / IPC 暂时不可用 → 保持现有 meta 不更新
        });
    };
    fetchOnce(); // 立即拉一次
    if (!poll) return () => {
      alive = false;
    };
    const interval = setInterval(fetchOnce, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [sessionId, poll]);

  if (!meta) return null;

  const hasBranch = !!meta.git_branch;
  const hasPorts = meta.listening_ports.length > 0;
  if (!hasBranch && !hasPorts) return null;

  // 拼 tooltip 文本（人类可读）
  const lines: string[] = [];
  if (hasBranch) {
    let s = t("tabMetadata.branchLabel", { name: meta.git_branch! });
    if (meta.git_dirty) s += t("tabMetadata.branchDirty");
    if (meta.git_unpushed_count !== null && meta.git_unpushed_count > 0) {
      s += t("tabMetadata.branchUnpushed", { count: meta.git_unpushed_count });
    }
    lines.push(s);
  }
  if (meta.cwd) lines.push(t("tabMetadata.cwdLabel", { path: meta.cwd }));
  if (hasPorts)
    lines.push(
      t("tabMetadata.portsLabel", {
        ports: meta.listening_ports.join(", "),
      }),
    );
  const title = lines.join("\n");

  return (
    <span
      className="flex items-center gap-1 text-[var(--c-text-dim)]"
      title={title}
      data-testid="tab-metadata-icons"
    >
      {hasBranch && (
        <span
          className="flex items-center gap-0.5"
          data-testid="tab-meta-git"
        >
          <GitBranch size={12} aria-label={t("tabMetadata.gitBranchAria")} />
          {meta.git_dirty && (
            <span
              className="h-1 w-1 rounded-full bg-[var(--c-warn)]"
              aria-label={t("tabMetadata.dirtyAria")}
              data-testid="tab-meta-dirty"
            />
          )}
        </span>
      )}
      {hasPorts && (
        <span data-testid="tab-meta-ports">
          <Activity size={12} aria-label={t("tabMetadata.portsAria")} />
        </span>
      )}
    </span>
  );
}
