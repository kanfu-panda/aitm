import { create } from "zustand";

interface SidebarState {
  /** AI 侧栏开关（右侧）。 */
  open: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;

  // === Phase 3A T2：左侧 FileTree 面板 ===
  /** 文件树面板开关（左侧）。默认隐藏，节约空间，按 Cmd+B 切换。 */
  fileTreeOpen: boolean;
  toggleFileTree: () => void;
  setFileTreeOpen: (open: boolean) => void;

  // === v0.10.0 HR9-4：文件预览面板临时收起 ===
  /** 文件预览面板可见性。默认 true；用户点 ActivityBar 文件预览图标 toggle。
   *  注意：仅在 openFiles.length > 0 时面板才真的显示（这里的开关只在"有文件时"
   *  控制是否隐藏到 ActivityBar）。openFiles 空时面板自然不渲染，跟此开关无关。 */
  filePreviewVisible: boolean;
  toggleFilePreview: () => void;
  setFilePreviewVisible: (visible: boolean) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),

  fileTreeOpen: false,
  toggleFileTree: () => set((s) => ({ fileTreeOpen: !s.fileTreeOpen })),
  setFileTreeOpen: (fileTreeOpen) => set({ fileTreeOpen }),

  filePreviewVisible: true,
  toggleFilePreview: () =>
    set((s) => ({ filePreviewVisible: !s.filePreviewVisible })),
  setFilePreviewVisible: (filePreviewVisible) => set({ filePreviewVisible }),
}));
