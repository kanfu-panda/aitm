import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SplitDivider from "../SplitDivider";

/**
 * v0.6.0-A T2 SplitDivider 组件单测。
 *
 * 测试策略：
 * - 把 requestAnimationFrame mock 成同步执行（cb 立刻跑），方便断言 onChange
 *   随 mousemove 立即被调用。
 * - 用 fireEvent.mouseDown / fireEvent.mouseMove(document) 驱动 document 级监听。
 */

describe("SplitDivider", () => {
  // 用宽松类型避免 vi.spyOn + globalThis 重载推断冲突；
  // 重要的是 mockImplementation / mockRestore 这俩方法可用。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rafSpy: any;

  beforeEach(() => {
    // rAF 同步执行：测试里立即拿到 onChange 调用次数
    rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(((cb: (t: number) => void) => {
        cb(0);
        return 0;
      }) as typeof requestAnimationFrame);
  });

  afterEach(() => {
    rafSpy?.mockRestore();
    vi.clearAllMocks();
  });

  it("渲染含 role=separator + aria-orientation=vertical + aria-valuenow 反映当前 value", () => {
    render(
      <SplitDivider
        value={250}
        onChange={() => {}}
        defaultValue={280}
        direction="left"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("250");
    expect(sep.getAttribute("aria-valuemin")).toBe("180");
    expect(sep.getAttribute("aria-valuemax")).toBe("600");
  });

  it("direction=right：mousedown + 右移 50px → onChange 收到 value+50", () => {
    const onChange = vi.fn();
    render(
      <SplitDivider
        value={300}
        onChange={onChange}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 150 });
    expect(onChange).toHaveBeenCalledWith(350);
    // cleanup：触发 mouseup 解绑监听
    fireEvent.mouseUp(document);
  });

  it("direction=left：mousedown + 右移 50px → onChange 收到 value-50", () => {
    const onChange = vi.fn();
    render(
      <SplitDivider
        value={300}
        onChange={onChange}
        defaultValue={280}
        direction="left"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 150 });
    expect(onChange).toHaveBeenCalledWith(250);
    fireEvent.mouseUp(document);
  });

  it("超出 max → clamp 到 max", () => {
    const onChange = vi.fn();
    render(
      <SplitDivider
        value={500}
        onChange={onChange}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 0, button: 0 });
    // 右移 1000px → raw=1500 → clamp 到 600
    fireEvent.mouseMove(document, { clientX: 1000 });
    expect(onChange).toHaveBeenCalledWith(600);
    fireEvent.mouseUp(document);
  });

  it("低于 min → clamp 到 min", () => {
    const onChange = vi.fn();
    render(
      <SplitDivider
        value={200}
        onChange={onChange}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 500, button: 0 });
    // 左移 500px → raw=200-500=-300 → clamp 到 180
    fireEvent.mouseMove(document, { clientX: 0 });
    expect(onChange).toHaveBeenCalledWith(180);
    fireEvent.mouseUp(document);
  });

  it("mouseup 调 onCommit；mousemove 期间不调 onCommit", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SplitDivider
        value={300}
        onChange={onChange}
        onCommit={onCommit}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 130 });
    fireEvent.mouseMove(document, { clientX: 160 });
    // mousemove 期间 onCommit 不该被调
    expect(onCommit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    // mouseup → onCommit 拿到最后一帧的 value（300+60=360）
    fireEvent.mouseUp(document);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(360);
  });

  it("双击 → onChange(defaultValue) + onCommit(defaultValue)", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SplitDivider
        value={250}
        onChange={onChange}
        onCommit={onCommit}
        defaultValue={280}
        direction="left"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.doubleClick(sep);
    expect(onChange).toHaveBeenCalledWith(280);
    expect(onCommit).toHaveBeenCalledWith(280);
  });

  it("多次连续 mousemove 仅触发一次 rAF（验证节流）", () => {
    // 把 rAF 恢复成"不立刻执行 cb"，统计 schedule 次数
    rafSpy.mockRestore();
    const scheduleSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((() => {
        return 1;
      }) as typeof requestAnimationFrame);

    const onChange = vi.fn();
    render(
      <SplitDivider
        value={300}
        onChange={onChange}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    // 连续 3 次 mousemove → 应只 schedule 一次 rAF（因 cb 没跑 rafScheduledRef 一直 true）
    fireEvent.mouseMove(document, { clientX: 110 });
    fireEvent.mouseMove(document, { clientX: 120 });
    fireEvent.mouseMove(document, { clientX: 130 });
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    // cb 没跑 → onChange 也没被调
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    scheduleSpy.mockRestore();
  });

  it("ariaLabel prop 透传到 DOM aria-label", () => {
    render(
      <SplitDivider
        value={300}
        onChange={() => {}}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
        ariaLabel="调整 AI 侧栏宽度"
      />,
    );
    const sep = screen.getByLabelText("调整 AI 侧栏宽度");
    expect(sep.getAttribute("role")).toBe("separator");
  });

  it("未传 ariaLabel → 默认 aria-label=调整宽度", () => {
    render(
      <SplitDivider
        value={300}
        onChange={() => {}}
        defaultValue={320}
        direction="right"
        min={180}
        max={600}
      />,
    );
    const sep = screen.getByLabelText("调整宽度");
    expect(sep).toBeInTheDocument();
  });
});
