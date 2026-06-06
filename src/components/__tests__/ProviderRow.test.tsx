import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRow } from "../ProviderList";
import type { ProviderConfigDto } from "../../lib/tauri";

// 把 tauri.ts 里 ProviderRow 用到的两个函数 mock 掉。
// providersGetConfig 不在 ProviderRow 内调用（在父组件 ProviderList），这里不必 mock。
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    providersSaveConfig: vi.fn(),
    providersTestConnection: vi.fn(),
  };
});

import {
  providersSaveConfig,
  providersTestConnection,
} from "../../lib/tauri";

const mockSave = providersSaveConfig as unknown as ReturnType<typeof vi.fn>;
const mockTest = providersTestConnection as unknown as ReturnType<typeof vi.fn>;

function makeDto(overrides: Partial<ProviderConfigDto> = {}): ProviderConfigDto {
  return {
    id: "qwen",
    display_name: "Qwen DashScope",
    enabled: true,
    api_key_masked: "sk-***xyz",
    key_source: "config",
    base_url: "",
    default_base_url: "https://dashscope.example.com/v1",
    models: [],
    ...overrides,
  };
}

describe("ProviderRow", () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockTest.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("已配置时显示 mask 提示文字", () => {
    render(<ProviderRow dto={makeDto()} onSaved={() => {}} />);
    expect(
      screen.getByText(/已配置：sk-\*\*\*xyz，留空保留原值/),
    ).toBeInTheDocument();
  });

  it("disable 切换 + 留空 keyInput → 保存时 api_key 为空字符串（保留原 key）", async () => {
    mockSave.mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<ProviderRow dto={makeDto()} onSaved={onSaved} />);

    // 切 enabled → dirty
    fireEvent.click(screen.getByLabelText("Qwen DashScope"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave).toHaveBeenCalledWith({
      id: "qwen",
      enabled: false,
      api_key: "", // 留空 = 不变
      base_url: "",
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("输入新 key → 保存 payload 含新 key", async () => {
    mockSave.mockResolvedValue(undefined);
    render(<ProviderRow dto={makeDto()} onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText("Qwen DashScope API Key"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: "sk-new" }),
    );
  });

  it("保存按钮在无变更时禁用并显示 '已是最新'", () => {
    render(<ProviderRow dto={makeDto()} onSaved={() => {}} />);
    const btn = screen.getByRole("button", { name: "已是最新" });
    expect(btn).toBeDisabled();
  });

  it("点测试连接 → testing 文案 → 显示成功结果", async () => {
    let resolveTest!: (v: {
      ok: boolean;
      elapsed_ms: number;
      message: string;
    }) => void;
    mockTest.mockReturnValue(
      new Promise((res) => {
        resolveTest = res;
      }),
    );

    render(<ProviderRow dto={makeDto()} onSaved={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    // testing 中
    expect(
      screen.getByRole("button", { name: "测试中…" }),
    ).toBeInTheDocument();

    resolveTest({ ok: true, elapsed_ms: 123, message: "OK (123 ms)" });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("OK (123 ms)"),
    );
    expect(screen.getByRole("status").textContent).toContain("✓");
  });

  it("测试失败显示红色 ✗ + 消息", async () => {
    mockTest.mockResolvedValue({
      ok: false,
      elapsed_ms: 50,
      message: "API key 无效（401/403）",
    });

    render(<ProviderRow dto={makeDto()} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "API key 无效（401/403）",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("✗");
  });

  it("key_source=none 且未输入 key → 测试连接按钮禁用", () => {
    render(
      <ProviderRow
        dto={makeDto({ key_source: "none", api_key_masked: "" })}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
  });

  it("key_source=none 但输入了新 key → 测试连接按钮可点", () => {
    render(
      <ProviderRow
        dto={makeDto({ key_source: "none", api_key_masked: "" })}
        onSaved={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Qwen DashScope API Key"), {
      target: { value: "sk-new" },
    });
    expect(screen.getByRole("button", { name: "测试连接" })).not.toBeDisabled();
  });
});
