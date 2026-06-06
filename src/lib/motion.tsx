/**
 * v0.4.1: framer-motion 适配层
 *
 * 强制走 LazyMotion + m + domAnimation 子集，避免全量 motion 导致 bundle
 * 失控（plan §6.4 R10）：
 * - 用 `m` 不用 `motion`（少 ~30KB）
 * - 用 `LazyMotion` + `domAnimation` 按需加载动画 feature
 * - 实测目标：增加 < 25KB gzip（含 LazyMotion + AnimatePresence + m.div）
 *
 * 使用方式：
 *   // App root 包一层
 *   <MotionRoot><App /></MotionRoot>
 *
 *   // 业务组件
 *   import { m } from '@/lib/motion';
 *   <m.div animate={{ opacity: 1 }} />
 *
 */

import { LazyMotion, domAnimation, m } from "framer-motion";
import type { ReactNode } from "react";

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}

export { m };
