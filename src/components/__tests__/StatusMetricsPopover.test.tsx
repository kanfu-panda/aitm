import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import StatusMetricsPopover from "../StatusMetricsPopover";

const M = { rss_mb: 84, cpu_pct: 12.4, active_sessions: 3 };

describe("状态栏资源弹窗", () => {
  it("平时折叠：只显示会话数，不摊开三段数据占满状态栏", () => {
    render(<StatusMetricsPopover metrics={M} />);
    expect(screen.getByTestId("status-metrics-trigger").textContent).toContain("3");
    expect(screen.queryByTestId("status-metrics-panel")).toBeNull();
  });

  it("点击展开，三项都在", () => {
    render(<StatusMetricsPopover metrics={M} />);
    fireEvent.click(screen.getByTestId("status-metrics-trigger"));
    const panel = screen.getByTestId("status-metrics-panel");
    expect(panel.textContent).toContain("3");
    expect(panel.textContent).toContain("12%");
    expect(panel.textContent).toContain("84 MB");
  });

  it("标明内存是 RSS 口径 —— 不让用户把偏高的数字当成真实占用", () => {
    render(<StatusMetricsPopover metrics={M} />);
    fireEvent.click(screen.getByTestId("status-metrics-trigger"));
    expect(screen.getByTestId("status-metrics-panel").textContent).toContain("RSS");
  });

  it("再点一次收起", () => {
    render(<StatusMetricsPopover metrics={M} />);
    const trigger = screen.getByTestId("status-metrics-trigger");
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("status-metrics-panel")).toBeNull();
  });

  it("点面板外部收起", () => {
    render(<StatusMetricsPopover metrics={M} />);
    fireEvent.click(screen.getByTestId("status-metrics-trigger"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("status-metrics-panel")).toBeNull();
  });

  it("Esc 收起", () => {
    render(<StatusMetricsPopover metrics={M} />);
    fireEvent.click(screen.getByTestId("status-metrics-trigger"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("status-metrics-panel")).toBeNull();
  });

  it("CPU 高于 50% 时触发器变警告色", () => {
    render(<StatusMetricsPopover metrics={{ ...M, cpu_pct: 80 }} />);
    const dot = screen.getByTestId("status-metrics-trigger").querySelector("span");
    expect(dot?.className).toContain("warn");
  });

  it("指标还没到达时显示占位，不渲染空面板", () => {
    render(<StatusMetricsPopover metrics={null} />);
    expect(screen.queryByTestId("status-metrics-trigger")).toBeNull();
  });
});
