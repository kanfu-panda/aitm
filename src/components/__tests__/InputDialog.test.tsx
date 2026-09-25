import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestTerminalFocusMock = vi.fn();
vi.mock("../../lib/terminalFocus", () => ({
  requestTerminalFocus: () => requestTerminalFocusMock(),
}));

vi.mock("../../lib/useBrowserModalGuard", () => ({
  useBrowserModalGuard: () => {},
}));

import InputDialog from "../InputDialog";

afterEach(() => {
  cleanup();
  requestTerminalFocusMock.mockReset();
});

/** 带一个触发按钮的受控外壳：模拟面板上的「新建」按钮打开对话框。 */
function Harness({
  focusTerminalOnSubmit,
  onSubmit = () => {},
}: {
  focusTerminalOnSubmit?: boolean;
  onSubmit?: () => void;
}) {
  return <HarnessInner opts={{ focusTerminalOnSubmit, onSubmit }} />;
}

import { useState } from "react";
function HarnessInner({
  opts,
}: {
  opts: { focusTerminalOnSubmit?: boolean; onSubmit: () => void };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        新建
      </button>
      <InputDialog
        open={
          open
            ? {
                title: "新建会话",
                initialValue: "demo",
                onSubmit: opts.onSubmit,
                focusTerminalOnSubmit: opts.focusTerminalOnSubmit,
              }
            : null
        }
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("InputDialog 关闭后的焦点去向", () => {
  it("应该_当配置了提交后聚焦终端且提交成功时_关闭后请求聚焦终端而不是还给触发按钮", async () => {
    render(<Harness focusTerminalOnSubmit />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("input-dialog-ok"));

    await waitFor(() =>
      expect(screen.queryByTestId("input-dialog")).toBeNull(),
    );
    await waitFor(() => expect(requestTerminalFocusMock).toHaveBeenCalledTimes(1));
    expect(document.activeElement).not.toBe(trigger);
  });

  it("应该_当用户取消时_不请求聚焦终端（焦点按默认还给触发按钮）", async () => {
    render(<Harness focusTerminalOnSubmit />);
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.click(await screen.findByTestId("input-dialog-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("input-dialog")).toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(requestTerminalFocusMock).not.toHaveBeenCalled();
  });

  it("应该_当没有配置该选项时_提交后也不请求聚焦终端", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.click(await screen.findByTestId("input-dialog-ok"));

    await waitFor(() =>
      expect(screen.queryByTestId("input-dialog")).toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(requestTerminalFocusMock).not.toHaveBeenCalled();
  });
});
