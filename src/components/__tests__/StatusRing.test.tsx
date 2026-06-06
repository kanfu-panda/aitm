import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import StatusRing from "../StatusRing";

describe("StatusRing", () => {
  it("running → bg-[var(--c-info)]，无 pulse", () => {
    const { getByTestId } = render(<StatusRing level="running" />);
    const el = getByTestId("tab-status-running");
    expect(el.className).toContain("bg-[var(--c-info)]");
    expect(el.className).not.toContain("animate-pulse");
  });

  it("done → bg-[var(--c-success)]，无 pulse", () => {
    const { getByTestId } = render(<StatusRing level="done" />);
    const el = getByTestId("tab-status-done");
    expect(el.className).toContain("bg-[var(--c-success)]");
    expect(el.className).not.toContain("animate-pulse");
  });

  it("waiting → bg-[var(--c-warn)] + animate-pulse（强调等审批）", () => {
    const { getByTestId } = render(<StatusRing level="waiting" />);
    const el = getByTestId("tab-status-waiting");
    expect(el.className).toContain("bg-[var(--c-warn)]");
    expect(el.className).toContain("animate-pulse");
  });

  it("error → bg-[var(--c-error)]", () => {
    const { getByTestId } = render(<StatusRing level="error" />);
    const el = getByTestId("tab-status-error");
    expect(el.className).toContain("bg-[var(--c-error)]");
  });

  it("a11y：role=status + aria-label 中文标签", () => {
    const { getByLabelText } = render(<StatusRing level="waiting" />);
    const el = getByLabelText("通知：等待审批");
    expect(el.getAttribute("role")).toBe("status");
  });
});
