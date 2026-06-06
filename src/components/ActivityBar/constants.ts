/**
 * v0.4.1 ActivityBar 物理常量。
 *
 * Plan §4.4 / §4.7：vertical (left/right) bar 总宽 44px，
 * horizontal (top/bottom) bar 总高 36px；按钮和图标尺寸两套以适配。
 *
 * 严禁在组件文件里硬编码这些数字。
 */

/** vertical（left/right）模式下的图标尺寸（icon-md）。 */
export const ICON_SIZE_VERTICAL = 20;
/** horizontal（top/bottom）模式下的图标尺寸（略小，节省纵向空间）。 */
export const ICON_SIZE_HORIZONTAL = 18;

/** vertical 模式按钮尺寸 40×40px。 */
export const ITEM_SIZE_VERTICAL = 40;
/** horizontal 模式按钮尺寸 32×32px（适配 36px bar）。 */
export const ITEM_SIZE_HORIZONTAL = 32;

/** vertical 模式 ActivityBar 总宽。 */
export const BAR_WIDTH_VERTICAL = 44;
/** horizontal 模式 ActivityBar 总高。 */
export const BAR_HEIGHT_HORIZONTAL = 36;

/** Tooltip 显示前的 hover 延迟（ms）。 */
export const TOOLTIP_DELAY_MS = 600;

/**
 * ActivityBar 四向位置。
 *
 * - `right`（默认）/ `left` → vertical bar
 * - `top` / `bottom` → horizontal bar
 *
 * 详见 plan §4.3 四向布局规格表。
 */
export type ActivityBarPosition = "right" | "left" | "top" | "bottom";
