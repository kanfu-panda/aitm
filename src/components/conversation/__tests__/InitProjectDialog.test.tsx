import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 在 import 组件之前 mock IPC，确保模块装载时 hook 拿到 mock 引用
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    projectInit: vi.fn().mockResolvedValue({
      uuid: "uuid-1",
      root_path: "/Users/leo/demo/myapp",
      name: "myapp",
    }),
    markIgnored: vi.fn().mockResolvedValue(undefined),
    aiChatResume: vi.fn().mockResolvedValue(undefined),
    // v0.4.2 T3：useBrowserModalGuard 弹窗时让 webview 让位
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
  };
});

// chat store 的 loadFromScope 走真实路径会触发 IPC（convList 等），
// 测里只关心调用顺序，整体 stub。
vi.mock("../../../stores/chat", () => {
  const loadFromScope = vi.fn().mockResolvedValue(undefined);
  return {
    useChatStore: Object.assign(
      // selector 形式：useChatStore((s) => ...)
      (selector: (s: { loadFromScope: typeof loadFromScope }) => unknown) =>
        selector({ loadFromScope }),
      {
        getState: () => ({ loadFromScope }),
      },
    ),
  };
});

import InitProjectDialog, { applyChoice } from "../InitProjectDialog";
import {
  aiChatResume,
  browserHideAllActive,
  browserShowAllActive,
  markIgnored,
  projectInit,
} from "../../../lib/tauri";
import { useChatStore } from "../../../stores/chat";
import type { AiInitRequiredEvent } from "../../../lib/tauri";

const mockProjectInit = projectInit as unknown as ReturnType<typeof vi.fn>;
const mockMarkIgnored = markIgnored as unknown as ReturnType<typeof vi.fn>;
const mockAiChatResume = aiChatResume as unknown as ReturnType<typeof vi.fn>;
const mockHide = browserHideAllActive as unknown as ReturnType<typeof vi.fn>;
const mockShow = browserShowAllActive as unknown as ReturnType<typeof vi.fn>;
const mockLoadFromScope = (
  useChatStore as unknown as { getState: () => { loadFromScope: ReturnType<typeof vi.fn> } }
).getState().loadFromScope;

const PAYLOAD: AiInitRequiredEvent = {
  conversation_id: "conv-1",
  cwd: "/Users/leo/demo/myapp",
  default_name: "myapp",
};

describe("InitProjectDialog", () => {
  beforeEach(() => {
    mockProjectInit.mockClear();
    mockMarkIgnored.mockClear();
    mockAiChatResume.mockClear();
    mockLoadFromScope.mockClear();
    mockHide.mockClear();
    mockShow.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("payload=null 不渲染对话框", () => {
    render(<InitProjectDialog payload={null} onResolved={() => {}} />);
    expect(screen.queryByText(/在这里开始一个 AI 项目/)).toBeNull();
  });

  it("有 payload：渲染标题 + 路径 + 默认项目名", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    expect(await screen.findByText(/在这里开始一个 AI 项目/)).toBeInTheDocument();
    expect(screen.getByText(PAYLOAD.cwd)).toBeInTheDocument();
    const nameInput = screen.getByLabelText("项目名") as HTMLInputElement;
    expect(nameInput.value).toBe("myapp");
  });

  it("3 个选项 + 确定 + 关闭按钮文案正确", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    await screen.findByText(/在这里开始一个 AI 项目/);

    expect(screen.getByLabelText("是，初始化为项目（推荐）")).toBeInTheDocument();
    expect(screen.getByLabelText("不用，这次临时用一下")).toBeInTheDocument();
    expect(screen.getByLabelText("别再问我这个目录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确定" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭 AI 侧边栏" }),
    ).toBeInTheDocument();
  });

  it("默认选中'初始化为项目'", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    const initRadio = (await screen.findByLabelText(
      "是，初始化为项目（推荐）",
    )) as HTMLInputElement;
    expect(initRadio.checked).toBe(true);
  });

  it("选'初始化为项目' + 确定 → projectInit + loadFromScope + aiChatResume + onResolved", async () => {
    const onResolved = vi.fn();
    render(<InitProjectDialog payload={PAYLOAD} onResolved={onResolved} />);
    await screen.findByText(/在这里开始一个 AI 项目/);

    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() =>
      expect(mockProjectInit).toHaveBeenCalledWith(PAYLOAD.cwd, "myapp"),
    );
    await waitFor(() =>
      expect(mockLoadFromScope).toHaveBeenCalledWith({
        kind: "project",
        uuid: "uuid-1",
        root_path: "/Users/leo/demo/myapp",
      }),
    );
    await waitFor(() =>
      expect(mockAiChatResume).toHaveBeenCalledWith(PAYLOAD.conversation_id, {
        kind: "project",
        uuid: "uuid-1",
        root_path: "/Users/leo/demo/myapp",
      }),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(mockMarkIgnored).not.toHaveBeenCalled();
  });

  it("用户改项目名后 → projectInit 用新名", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    const nameInput = (await screen.findByLabelText("项目名")) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "我的新项目" } });

    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() =>
      expect(mockProjectInit).toHaveBeenCalledWith(PAYLOAD.cwd, "我的新项目"),
    );
  });

  it("选'临时用一下' + 确定 → 不调 projectInit / markIgnored；调 aiChatResume(global)", async () => {
    const onResolved = vi.fn();
    render(<InitProjectDialog payload={PAYLOAD} onResolved={onResolved} />);
    await screen.findByText(/在这里开始一个 AI 项目/);

    fireEvent.click(screen.getByLabelText("不用，这次临时用一下"));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() =>
      expect(mockAiChatResume).toHaveBeenCalledWith(PAYLOAD.conversation_id, {
        kind: "global",
      }),
    );
    expect(mockProjectInit).not.toHaveBeenCalled();
    expect(mockMarkIgnored).not.toHaveBeenCalled();
    expect(mockLoadFromScope).toHaveBeenCalledWith({ kind: "global" });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("选'别再问我这个目录' + 确定 → markIgnored + aiChatResume(global)", async () => {
    const onResolved = vi.fn();
    render(<InitProjectDialog payload={PAYLOAD} onResolved={onResolved} />);
    await screen.findByText(/在这里开始一个 AI 项目/);

    fireEvent.click(screen.getByLabelText("别再问我这个目录"));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() =>
      expect(mockMarkIgnored).toHaveBeenCalledWith(PAYLOAD.cwd),
    );
    await waitFor(() =>
      expect(mockAiChatResume).toHaveBeenCalledWith(PAYLOAD.conversation_id, {
        kind: "global",
      }),
    );
    expect(mockProjectInit).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("init 选项下：项目名为空 → 确定按钮 disabled", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    const nameInput = (await screen.findByLabelText("项目名")) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "   " } });

    const confirmBtn = screen.getByRole("button", { name: "确定" });
    expect(confirmBtn).toBeDisabled();
  });

  // v0.4.2 T3：useBrowserModalGuard 接入验证（WKWebView 让位）
  it("payload 非 null（dialog 弹起）调 browserHideAllActive（webview 让位）", async () => {
    render(<InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />);
    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));
  });

  it("payload=null 不调 browserHideAllActive", () => {
    render(<InitProjectDialog payload={null} onResolved={() => {}} />);
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("payload 由非 null → null（rerender 关闭）调 browserShowAllActive", async () => {
    const { rerender } = render(
      <InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />,
    );
    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));

    rerender(<InitProjectDialog payload={null} onResolved={() => {}} />);
    await waitFor(() => expect(mockShow).toHaveBeenCalledTimes(1));
  });

  it("payload 切换会重置选择 + 名字（避免上次决议泄漏）", async () => {
    const { rerender } = render(
      <InitProjectDialog payload={PAYLOAD} onResolved={() => {}} />,
    );
    const initRadio = (await screen.findByLabelText(
      "是，初始化为项目（推荐）",
    )) as HTMLInputElement;
    expect(initRadio.checked).toBe(true);

    fireEvent.click(screen.getByLabelText("不用，这次临时用一下"));

    // 新 payload（如另起一次）应回到默认 init 选中 + 新 default_name
    const PAYLOAD2: AiInitRequiredEvent = {
      conversation_id: "conv-2",
      cwd: "/Users/leo/work/foo",
      default_name: "foo",
    };
    rerender(<InitProjectDialog payload={PAYLOAD2} onResolved={() => {}} />);

    await waitFor(() => {
      const reset = screen.getByLabelText(
        "是，初始化为项目（推荐）",
      ) as HTMLInputElement;
      expect(reset.checked).toBe(true);
      const nm = screen.getByLabelText("项目名") as HTMLInputElement;
      expect(nm.value).toBe("foo");
    });
  });
});

// 直接测 applyChoice helper —— Radix Dialog portal 在 jsdom 里 OK，
// 但抽出 helper 让"调用顺序"断言更紧（顺序：loadFromScope 先于 aiChatResume）。
describe("applyChoice helper", () => {
  beforeEach(() => {
    mockProjectInit.mockClear();
    mockMarkIgnored.mockClear();
    mockAiChatResume.mockClear();
    mockLoadFromScope.mockClear();
  });

  it("init：调用顺序 projectInit → loadFromScope → aiChatResume", async () => {
    const calls: string[] = [];
    mockProjectInit.mockImplementationOnce(async () => {
      calls.push("projectInit");
      return { uuid: "u", root_path: "/p", name: "n" };
    });
    mockLoadFromScope.mockImplementationOnce(async () => {
      calls.push("loadFromScope");
    });
    mockAiChatResume.mockImplementationOnce(async () => {
      calls.push("aiChatResume");
    });

    await applyChoice("init", PAYLOAD, "myapp");

    expect(calls).toEqual(["projectInit", "loadFromScope", "aiChatResume"]);
  });

  it("temp_global：仅 loadFromScope → aiChatResume；不碰 projectInit/markIgnored", async () => {
    await applyChoice("temp_global", PAYLOAD, "myapp");
    expect(mockProjectInit).not.toHaveBeenCalled();
    expect(mockMarkIgnored).not.toHaveBeenCalled();
    expect(mockLoadFromScope).toHaveBeenCalledWith({ kind: "global" });
    expect(mockAiChatResume).toHaveBeenCalledWith("conv-1", { kind: "global" });
  });

  it("ignore：markIgnored 失败也继续走 global（不卡死 chat）", async () => {
    mockMarkIgnored.mockRejectedValueOnce(new Error("disk full"));
    await applyChoice("ignore", PAYLOAD, "myapp");
    expect(mockMarkIgnored).toHaveBeenCalledWith(PAYLOAD.cwd);
    expect(mockLoadFromScope).toHaveBeenCalledWith({ kind: "global" });
    expect(mockAiChatResume).toHaveBeenCalledWith("conv-1", { kind: "global" });
  });

  it("init 名字 trim 为空 → 用 default_name 兜底", async () => {
    await applyChoice("init", PAYLOAD, "   ");
    expect(mockProjectInit).toHaveBeenCalledWith(PAYLOAD.cwd, "myapp");
  });
});
