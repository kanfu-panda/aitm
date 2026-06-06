/* =============================================================================
 * FileTabBar.tsx —— v0.9.0 T5b 编辑器内部 tab bar
 * -----------------------------------------------------------------------------
 * 横向 tab 列表，仿 VSCode 编辑器 tab：
 *   - 点 tab 切 active
 *   - dirty 状态 tab 末尾加 `•` 圆点（CSS 标识，hover 显示 X）
 *   - hover 出关闭按钮 X
 *   - 选中 tab 底部一道 emerald 高亮（终端 TabBar 风格统一）
 *
 * v0.9.1 HR4-6：
 *   - 容器从 `overflow-x-auto`（横滚）改成 `flex-wrap`（多 tab 折行多行展示），
 *     避免 10+ tab 时下方出水平滚动条难看难切；高度自动撑（去掉 h-9）。
 *   - 右键 tab 弹 4-action context menu：关闭 / 关闭其他 / 关闭右侧 / 全部关闭。
 *     菜单实现沿用 TabBar.tsx 自手搓 fixed 定位 + 全局 click/Escape 关闭模式，
 *     不引新依赖。
 *
 * 单一职责：渲染 + 通过 props 回调 onActivate / onCloseRequested /
 * onCloseOthers / onCloseRight / onCloseAll。
 * 不直接调 store：父层 FilePreviewWorkspace 决定 dirty 走弹窗 / 直接关。
 * ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import type { OpenFile } from "../stores/file-editor";
import { File as FileIcon, X } from "./icons";

interface Props {
  files: OpenFile[];
  activeId: string | null;
  /** 点 tab 触发；dirty 状态切走不该 prompt（仅关 tab 才弹）。 */
  onActivate: (id: string) => void;
  /** 点 X / Cmd+W / 右键"关闭" 触发；父层判 dirty 决定弹弹窗 / 直接 closeFile。 */
  onCloseRequested: (id: string) => void;
  /**
   * v0.9.0 HR2-9：双击 tab 标题触发；父层 toggle 编辑器最大化。
   * 仅 active tab 双击有效（避免双击切换 tab 时误触发）。
   */
  onToggleMaximized?: () => void;
  /** v0.9.1 HR4-6 右键"关闭其他"：除 id 外全部走 requestClose。 */
  onCloseOthers?: (id: string) => void;
  /** v0.9.1 HR4-6 右键"关闭右侧"：保留 0..id；关 id 之后所有 tab。 */
  onCloseRight?: (id: string) => void;
  /** v0.9.1 HR4-6 右键"全部关闭"：files 全部走 requestClose。 */
  onCloseAll?: () => void;
}

// v0.10.1 #2：basename + disambiguation 移到 src/lib/file-label.ts 共享。
// 这里仍 re-export basename 让本文件内 close button aria-label 继续用纯 basename
// （不带 disambiguation 后缀），保持 a11y 简短。
import { basename, disambiguateLabels } from "../lib/file-label";

export default function FileTabBar({
  files,
  activeId,
  onActivate,
  onCloseRequested,
  onToggleMaximized,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
}: Props) {
  /** v0.9.1 HR4-6：右键菜单状态。null = 未显示；非空 = 在指定 tab 上点了右键。 */
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  // 右键菜单显示时挂全局 click / Escape 监听，点空白处或按 Esc 关闭
  useEffect(() => {
    if (!contextMenu) return;
    const onDocClick = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // v0.10.1 #2：同 basename 多 tab 时显示 `basename — parent` 区分。
  // useMemo 缓存到 files 引用变化才重算；文件数 100 时算法仍 O(n) 量级。
  // 必须在 early return 之前调（React Hook rule）。
  const labelMap = useMemo(
    () => disambiguateLabels(files.map((f) => f.path)),
    [files],
  );

  if (files.length === 0) return null;

  // 计算右键菜单语义：rightCount 用于禁用"关闭右侧"项
  const ctxIdx = contextMenu
    ? files.findIndex((f) => f.id === contextMenu.tabId)
    : -1;
  const rightCount = ctxIdx >= 0 ? files.length - 1 - ctxIdx : 0;
  const otherCount = files.length - 1;

  return (
    <>
      <div
        role="tablist"
        aria-label="文件编辑器 tab"
        data-testid="file-tab-bar"
        className="flex flex-wrap items-stretch border-b border-[var(--c-border)] bg-[var(--c-bg-elev-1)]"
      >
        {files.map((f) => {
          const active = f.id === activeId;
          return (
            <div
              key={f.id}
              role="tab"
              aria-selected={active}
              data-testid={`file-tab-${f.id}`}
              data-active={active ? "true" : "false"}
              data-dirty={f.dirty ? "true" : "false"}
              title={f.path}
              className={
                "group relative flex h-9 min-w-[80px] max-w-[240px] items-center gap-1.5 border-r border-[var(--c-border)] px-2.5 text-xs cursor-pointer select-none " +
                (active
                  ? "bg-[var(--c-bg-base)] text-[var(--c-text-base)]"
                  : "bg-[var(--c-bg-elev-1)] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]")
              }
              onClick={() => onActivate(f.id)}
              onDoubleClick={(e) => {
                // v0.9.0 HR2-9：双击 active tab → 切最大化 / 恢复。
                // 双击 close 按钮 / 圆点不触发（button 内 e.stopPropagation 已保护）
                if (active && onToggleMaximized) {
                  e.preventDefault();
                  onToggleMaximized();
                }
              }}
              onMouseDown={(e) => {
                // 中键点击 = 关 tab（仿 VSCode / Chrome）
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseRequested(f.id);
                }
              }}
              onContextMenu={(e) => {
                // v0.9.1 HR4-6：右键弹 4-action 菜单
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ tabId: f.id, x: e.clientX, y: e.clientY });
              }}
            >
              <FileIcon
                size={12}
                className="flex-shrink-0 text-[var(--c-text-dim)]"
                aria-hidden
              />
              <span className="truncate">
                {labelMap.get(f.path) ?? basename(f.path)}
              </span>
              {/* 右侧区域：dirty 时显圆点（hover 时变 X）；非 dirty hover 显 X */}
              <button
                type="button"
                aria-label={`关闭 ${basename(f.path)}`}
                data-testid={`file-tab-close-${f.id}`}
                className={
                  "ml-auto flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-text-base)] " +
                  (f.dirty
                    ? "" // dirty 始终显示（圆点 / X 通过子内容切换）
                    : "opacity-0 group-hover:opacity-100")
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseRequested(f.id);
                }}
              >
                {f.dirty ? (
                  <>
                    {/* dirty 圆点：默认显示；group/btn hover 时换 X */}
                    <span
                      className="block h-1.5 w-1.5 rounded-full bg-[var(--c-text-muted)] group-hover:hidden"
                      aria-hidden
                      data-testid={`file-tab-dirty-dot-${f.id}`}
                    />
                    <X
                      size={12}
                      className="hidden group-hover:block"
                      aria-hidden
                    />
                  </>
                ) : (
                  <X size={12} aria-hidden />
                )}
              </button>
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--c-success)]"
                />
              )}
            </div>
          );
        })}
      </div>
      {/* v0.9.1 HR4-6 右键 4-action context menu */}
      {contextMenu && (
        <div
          role="menu"
          aria-label="文件 tab 上下文菜单"
          data-testid="file-tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[180px] rounded border border-[var(--c-border)] bg-[var(--c-bg-elev-2)] py-1 text-xs font-mono text-[var(--c-text-base)] shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="file-tab-ctx-close"
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)]"
            onClick={() => {
              const id = contextMenu.tabId;
              setContextMenu(null);
              onCloseRequested(id);
            }}
          >
            关闭
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="file-tab-ctx-close-others"
            disabled={otherCount === 0 || !onCloseOthers}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)] disabled:cursor-not-allowed disabled:text-[var(--c-text-dim)] disabled:hover:bg-transparent"
            onClick={() => {
              const id = contextMenu.tabId;
              setContextMenu(null);
              onCloseOthers?.(id);
            }}
          >
            关闭其他
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="file-tab-ctx-close-right"
            disabled={rightCount === 0 || !onCloseRight}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)] disabled:cursor-not-allowed disabled:text-[var(--c-text-dim)] disabled:hover:bg-transparent"
            onClick={() => {
              const id = contextMenu.tabId;
              setContextMenu(null);
              onCloseRight?.(id);
            }}
          >
            关闭右侧
          </button>
          <div
            className="my-1 h-px bg-[var(--c-border)]"
            aria-hidden
          />
          <button
            type="button"
            role="menuitem"
            data-testid="file-tab-ctx-close-all"
            disabled={!onCloseAll}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)] disabled:cursor-not-allowed disabled:text-[var(--c-text-dim)] disabled:hover:bg-transparent"
            onClick={() => {
              setContextMenu(null);
              onCloseAll?.();
            }}
          >
            全部关闭
          </button>
        </div>
      )}
    </>
  );
}
