import { beforeEach, describe, expect, it, vi } from "vitest";

/** 每个用例可覆盖：plugin 的 check() 返回什么 */
let mockUpdate: {
  version: string;
  body?: string;
  downloadAndInstall: (cb: (e: unknown) => void) => Promise<void>;
} | null = null;

const relaunchSpy = vi.fn(async () => {});

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => mockUpdate),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunchSpy(),
}));

import { checkForUpdate } from "../updater";

/** 造一个按给定事件序列回放的假 update */
function 假更新(events: unknown[]) {
  return {
    version: "1.4.0",
    body: "notes",
    downloadAndInstall: async (cb: (e: unknown) => void) => {
      for (const e of events) cb(e);
    },
  };
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    relaunchSpy.mockClear();
    mockUpdate = null;
  });

  it("无更新时返回 null", async () => {
    expect(await checkForUpdate()).toBeNull();
  });

  it("有更新时带出版本号与说明", async () => {
    mockUpdate = 假更新([]);
    const u = await checkForUpdate();
    expect(u?.version).toBe("1.4.0");
    expect(u?.notes).toBe("notes");
  });

  it("把分块下载事件折算成 0..1 的进度，并在装完后重启", async () => {
    mockUpdate = 假更新([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Finished", data: {} },
    ]);
    const seen: (number | null)[] = [];
    const u = await checkForUpdate();
    await u!.install((r) => seen.push(r));

    expect(seen).toEqual([0, 0.25, 0.5, 1]);
    expect(relaunchSpy).toHaveBeenCalledTimes(1);
  });

  it("服务端不给总长度时进度为 null，而不是除零算出 Infinity", async () => {
    mockUpdate = 假更新([
      { event: "Started", data: {} },
      { event: "Progress", data: { chunkLength: 25 } },
    ]);
    const seen: (number | null)[] = [];
    const u = await checkForUpdate();
    await u!.install((r) => seen.push(r));

    expect(seen).toEqual([null, null]);
  });

  it("累计块长超过总长时进度封顶到 1", async () => {
    mockUpdate = 假更新([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 150 } },
    ]);
    const seen: (number | null)[] = [];
    const u = await checkForUpdate();
    await u!.install((r) => seen.push(r));

    expect(seen).toEqual([0, 1]);
  });
});
