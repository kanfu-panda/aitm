/** PDF 预览的辅助函数：缩放档位与扩展名判断。 */

/** 缩放档位：25%–400%。 */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** 从当前比例出发，取放大 / 缩小方向上最近的档位；已到边界返回 null。 */
export function nextZoom(current: number, dir: "in" | "out"): number | null {
  // 适应宽度得到的比例通常不在档位上，用一点容差避免"放大"停在原地
  const eps = 1e-3;
  if (dir === "in") {
    return ZOOM_STEPS.find((s) => s > current + eps) ?? null;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - eps) return ZOOM_STEPS[i];
  }
  return null;
}

/** 按扩展名判断是否为 PDF（不区分大小写）。 */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}
