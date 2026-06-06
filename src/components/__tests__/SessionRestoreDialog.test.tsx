import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SessionRestoreDialog from "../SessionRestoreDialog";
import type { SessionSnapshot } from "../../lib/tauri";

const sampleSnapshot: SessionSnapshot = {
  schema_version: 1,
  saved_at_ms: 1_700_000_000_000,
  tabs: [
    { tab_id: "t1", title: "main", cwd: "/proj", unread: 0, group_id: "g-initial" },
    { tab_id: "t2", title: "logs", cwd: "/var/log", unread: 3, group_id: "g-initial" },
  ],
  active_tab_id: "t1",
};

describe("SessionRestoreDialog", () => {
  it("snapshot=null → 不渲染", () => {
    const onR = vi.fn();
    const onF = vi.fn();
    const onS = vi.fn();
    render(
      <SessionRestoreDialog
        snapshot={null}
        onRestore={onR}
        onFresh={onF}
        onSkip={onS}
      />,
    );
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
  });

  it("snapshot 有 2 tab → 渲染列表 + 3 按钮", () => {
    render(
      <SessionRestoreDialog
        snapshot={sampleSnapshot}
        onRestore={vi.fn()}
        onFresh={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/2 个 tab/).length).toBeGreaterThan(0);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("logs")).toBeTruthy();
    expect(screen.getByText("/proj")).toBeTruthy();
    expect(screen.getByTestId("restore-btn-restore")).toBeTruthy();
    expect(screen.getByTestId("restore-btn-fresh")).toBeTruthy();
    expect(screen.getByTestId("restore-btn-skip")).toBeTruthy();
  });

  it("点恢复按钮 → onRestore 调用 + 其他 callback 不调", () => {
    const onR = vi.fn();
    const onF = vi.fn();
    const onS = vi.fn();
    render(
      <SessionRestoreDialog
        snapshot={sampleSnapshot}
        onRestore={onR}
        onFresh={onF}
        onSkip={onS}
      />,
    );
    fireEvent.click(screen.getByTestId("restore-btn-restore"));
    expect(onR).toHaveBeenCalledTimes(1);
    expect(onF).not.toHaveBeenCalled();
    expect(onS).not.toHaveBeenCalled();
  });

  it("点全新启动 → onFresh", () => {
    const onF = vi.fn();
    render(
      <SessionRestoreDialog
        snapshot={sampleSnapshot}
        onRestore={vi.fn()}
        onFresh={onF}
        onSkip={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("restore-btn-fresh"));
    expect(onF).toHaveBeenCalledTimes(1);
  });

  it("点跳过 → onSkip", () => {
    const onS = vi.fn();
    render(
      <SessionRestoreDialog
        snapshot={sampleSnapshot}
        onRestore={vi.fn()}
        onFresh={vi.fn()}
        onSkip={onS}
      />,
    );
    fireEvent.click(screen.getByTestId("restore-btn-skip"));
    expect(onS).toHaveBeenCalledTimes(1);
  });
});
