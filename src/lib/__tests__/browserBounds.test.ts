import { describe, expect, it, vi } from "vitest";
import {
  BOUNDS_REPORT_THROTTLE_MS,
  createBoundsReporter,
  type BoundsRect,
} from "../browserBounds";

/**
 * v1.3.0 R3b：bounds 上报时序的纯逻辑单测。
 *
 * 背景：内嵌浏览器的 child webview 是 native overlay，创建时用的是占位尺寸
 * `PLACEHOLDER_BROWSER_BOUNDS`（800×600）。**只要占位尺寸没被真实尺寸覆盖，
 * 网页就会按 800 宽布局**，面板拖多窄都只是被裁剪而不重排。
 *
 * 所以这里锁死一条不变量：**只要容器能测出尺寸，最后一次真正发出的 bounds
 * 必然是真实尺寸，绝不停在占位值上**。真实 WKWebView 的 viewport 行为没法
 * 单测（没有 GUI），能自动化验证的只有"上报一定发生、且不被节流吞掉"。
 */

/** 造一个可控时钟 + 手动驱动的 rAF 队列，避免测试依赖真实计时。 */
function makeHarness(initial: BoundsRect | null = { x: 0, y: 0, w: 370, h: 500 }) {
  let clock = 1000;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  let rect: BoundsRect | null = initial;

  const send = vi.fn<(b: BoundsRect) => void>();

  const reporter = createBoundsReporter({
    measure: () => rect,
    send,
    now: () => clock,
    requestFrame: (cb) => {
      const h = nextHandle++;
      frames.set(h, cb);
      return h;
    },
    cancelFrame: (h) => {
      frames.delete(h);
    },
  });

  return {
    reporter,
    send,
    /** 推进时钟（毫秒）。 */
    tick: (ms: number) => {
      clock += ms;
    },
    /** 跑完当前排队的所有帧回调（模拟浏览器下一帧）。 */
    flushFrames: () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
    },
    pendingFrames: () => frames.size,
    setRect: (r: BoundsRect | null) => {
      rect = r;
    },
  };
}

const REAL: BoundsRect = { x: 0, y: 0, w: 370, h: 500 };
/** webview 创建时用的占位尺寸（见 lib/browserOpenRequest.ts）。 */
const PLACEHOLDER: BoundsRect = { x: 0, y: 0, w: 800, h: 600 };

describe("createBoundsReporter", () => {
  it("首次 report 立即用容器真实尺寸发出（不等下一帧）", () => {
    const h = makeHarness();
    h.reporter.report();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(REAL);
  });

  it("节流窗口内的连续 report 只立即发一次，剩下的合并到下一帧补发（不吞掉最后一次）", () => {
    const h = makeHarness();
    h.reporter.report(); // 立即发（第 1 次）
    h.send.mockClear();

    // 同一节流窗口内狂点：不应立即再发，但要排一个补发帧
    h.tick(BOUNDS_REPORT_THROTTLE_MS - 1);
    h.reporter.report();
    h.reporter.report();
    h.reporter.report();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.pendingFrames()).toBe(1);

    // 下一帧到来 → 最后一次被补发，尺寸仍是真实值
    h.flushFrames();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(REAL);
  });

  it("超过节流窗口后的 report 重新立即发出", () => {
    const h = makeHarness();
    h.reporter.report();
    h.tick(BOUNDS_REPORT_THROTTLE_MS);
    h.reporter.report();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.pendingFrames()).toBe(0);
  });

  it("reportNow 绕过节流强制发出（mount 兜底帧用）", () => {
    const h = makeHarness();
    h.reporter.report();
    h.send.mockClear();

    // 完全没推进时钟 = 还在节流窗口内，reportNow 仍要发
    h.reporter.reportNow();
    h.reporter.reportNow();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenLastCalledWith(REAL);
  });

  it("容器测不出尺寸（已卸载）时不发 IPC", () => {
    const h = makeHarness(null);
    h.reporter.report();
    h.reporter.reportNow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("dispose 取消排队中的补发帧，之后不再发", () => {
    const h = makeHarness();
    h.reporter.report();
    h.tick(1);
    h.reporter.report(); // 排一个补发帧
    expect(h.pendingFrames()).toBe(1);

    h.send.mockClear();
    h.reporter.dispose();
    expect(h.pendingFrames()).toBe(0);
    h.flushFrames();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("不变量：tab id 就绪后走完 BrowserPanel 的 4 轮兜底，最终生效尺寸必是真实尺寸而非占位 800×600", () => {
    // 复刻 BrowserPanel effect 的兜底序列：第 0 帧 report、第 1/2 帧 reportNow、
    // 250ms reportNow。无论中间怎么排布，最后一次真正发出的都必须是真实尺寸。
    const h = makeHarness();

    h.reporter.report(); // 第 0 帧
    h.reporter.reportNow(); // 第 1 帧
    h.reporter.reportNow(); // 第 2 帧
    h.tick(250);
    h.reporter.reportNow(); // 250ms 兜底
    h.flushFrames(); // 期间可能排过的补发帧

    expect(h.send.mock.calls.length).toBeGreaterThan(0);
    // 每一次上报都用真实尺寸；占位值永远不会被上报
    for (const [b] of h.send.mock.calls) {
      expect(b).toEqual(REAL);
      expect(b.w).not.toBe(PLACEHOLDER.w);
    }
  });

  it("不变量：容器尺寸变化后，最后生效的一定是最新尺寸（拖窄面板不会停在旧宽度）", () => {
    const h = makeHarness();
    h.reporter.report(); // 宽面板

    // 模拟拖动：一帧内多次 RO 回调，尺寸逐步收窄
    h.tick(1);
    h.setRect({ x: 0, y: 0, w: 600, h: 500 });
    h.reporter.report();
    h.setRect({ x: 0, y: 0, w: 380, h: 500 });
    h.reporter.report();
    h.setRect({ x: 0, y: 0, w: 300, h: 500 });
    h.reporter.report();

    h.flushFrames();
    // 补发帧是**重新 measure** 的，所以拿到的是拖动结束时的最新尺寸
    expect(h.send).toHaveBeenLastCalledWith({ x: 0, y: 0, w: 300, h: 500 });
  });
});
