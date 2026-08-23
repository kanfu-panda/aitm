/**
 * 内嵌浏览器的页面缩放档位。
 *
 * ## 为什么需要缩放
 *
 * 浏览器面板常常只有两三百逻辑像素宽。webview 拿到的尺寸是准的（`set_bounds`
 * 按面板实宽下发），但**做 UA 嗅探的站点**看到桌面 Safari UA 就发 PC 版页面，
 * PC 版有固定最小宽度，塞进窄面板只能被裁掉。整体缩小是最省事的补救 —— 不用
 * 重新加载、不丢登录态。
 *
 * ## 档位而不是连续值
 *
 * 跟主流浏览器一致走固定档位：连续缩放用键盘调很难停在整数比例，档位能保证
 * "按几下回到 100%"这件事是确定的。
 */

/** 缩放档位，从小到大。100% 必须在其中（reset 目标）。 */
export const ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
] as const;

/** 默认（也是 reset 回到的）比例。 */
export const DEFAULT_ZOOM = 1;

/**
 * 把任意比例吸附到最近的档位。
 *
 * 存量数据 / 手改配置可能给出不在档位上的值，先归一再调整，避免越调越偏。
 */
export function snapZoom(factor: number): number {
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - factor) < Math.abs(best - factor) ? step : best,
  );
}

/**
 * 在档位上走一步。`direction` 为 +1 放大、-1 缩小。
 *
 * already 到头时原样返回（不报错、不回绕）——回绕会让"一直按放大"突然变成最小，
 * 是明确的反直觉行为。
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const snapped = snapZoom(current);
  const idx = ZOOM_STEPS.indexOf(snapped as (typeof ZOOM_STEPS)[number]);
  const next = idx + direction;
  if (next < 0 || next >= ZOOM_STEPS.length) return snapped;
  return ZOOM_STEPS[next];
}

/** 给 UI 显示用的百分比文本，如 `0.67` → `"67%"`。 */
export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}
