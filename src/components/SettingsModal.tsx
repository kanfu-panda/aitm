import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settings";
import { THEMES } from "../lib/themes";
import { SUPPORTED_LANGUAGES } from "../lib/i18n";
import ProviderList from "./ProviderList";
import SafetySection from "./safety/SafetySection";
import PrivacySection from "./privacy/PrivacySection";
import BrowserSettingsSection from "./browser/BrowserSettingsSection";
import KeybindingsSection from "./settings/KeybindingsSection";
import type {
  ActivityBarPosition,
  SidePanelPosition,
  ThemeMode,
} from "../lib/tauri";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TabValue =
  | "appearance"
  | "terminal"
  | "providers"
  | "safety"
  | "privacy"
  | "browser"
  | "keybindings"
  | "language";

export default function SettingsModal({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const init = useSettingsStore((s) => s.init);
  const loaded = useSettingsStore((s) => s.loaded);
  // tab 切换是 component state，不持久化跨重启（关闭重开记忆 OK）
  // 默认仍是"终端"（保持 v0.4.0 行为）；外观段位放在第一项是为了让用户
  // 第一次找"主题切换 / ActivityBar 位置"时一眼看到。
  const [activeTab, setActiveTab] = useState<TabValue>("terminal");

  // 首次打开时拉一次后端 settings
  useEffect(() => {
    if (open && !loaded) {
      init();
    }
  }, [open, loaded, init]);

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* z-50：active tab 容器有 zIndex:1，modal portal 必须高于它 */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[600px] max-h-[90vh] w-[720px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-[var(--c-border)] bg-[var(--c-bg-elev-1)] text-[var(--c-text-base)] shadow-2xl focus:outline-none">
          <Dialog.Title className="border-b border-[var(--c-border)] px-5 py-3 text-base font-medium">
            {t("settingsModal.title")}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {t("settingsModal.title")}
          </Dialog.Description>

          <Tabs.Root
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as TabValue)}
            orientation="vertical"
            className="flex min-h-0 flex-1"
          >
            <Tabs.List
              aria-label={t("settingsModal.tablistLabel")}
              className="flex w-[150px] flex-shrink-0 flex-col border-r border-[var(--c-border)] bg-[var(--c-bg-base)] py-2"
            >
              <TabTrigger value="appearance" label={t("settingsModal.sections.appearance")} />
              <TabTrigger value="terminal" label={t("settingsModal.sections.terminal")} />
              <TabTrigger value="providers" label={t("settingsModal.sections.ai")} />
              <TabTrigger value="safety" label={t("settingsModal.sections.safety")} />
              <TabTrigger value="privacy" label={t("settingsModal.sections.privacy")} />
              <TabTrigger value="browser" label={t("settingsModal.sections.browser")} />
              <TabTrigger value="keybindings" label={t("settingsModal.sections.keybindings")} />
              <TabTrigger value="language" label={t("settingsModal.sections.language")} />
            </Tabs.List>

            <div className="min-w-0 flex-1 overflow-y-auto p-5">
              <Tabs.Content value="appearance" className="focus:outline-none">
                <AppearanceTab />
              </Tabs.Content>
              <Tabs.Content value="terminal" className="focus:outline-none">
                <TerminalTab />
              </Tabs.Content>
              <Tabs.Content value="providers" className="focus:outline-none">
                <ProviderList />
              </Tabs.Content>
              <Tabs.Content value="safety" className="focus:outline-none">
                <SafetySection />
              </Tabs.Content>
              <Tabs.Content value="privacy" className="focus:outline-none">
                <PrivacySection />
              </Tabs.Content>
              <Tabs.Content value="browser" className="focus:outline-none">
                <BrowserSettingsSection />
              </Tabs.Content>
              <Tabs.Content value="keybindings" className="focus:outline-none">
                <KeybindingsSection />
              </Tabs.Content>
              <Tabs.Content value="language" className="focus:outline-none">
                <LanguageSection />
              </Tabs.Content>
            </div>
          </Tabs.Root>

          <Dialog.Close asChild>
            <button
              className="absolute right-3 top-3 rounded p-1 text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
              aria-label={t("common.close")}
            >
              ×
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TabTrigger({ value, label }: { value: TabValue; label: string }) {
  return (
    <Tabs.Trigger
      value={value}
      data-testid={`settings-tab-${value}`}
      className={
        // v0.10.4 hotfix：whitespace-nowrap 防日文 "ショートカット" 折成两行；
        // 列宽已拉到 150px 给长 label buffer，未来若有更长 label 再扩或用动态宽。
        "relative w-full whitespace-nowrap px-4 py-2 text-left text-sm text-[var(--c-text-muted)] outline-none " +
        "hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] " +
        "data-[state=active]:bg-[var(--c-bg-elev-2)] data-[state=active]:text-[var(--c-text-base)] " +
        "data-[state=active]:before:absolute data-[state=active]:before:left-0 " +
        "data-[state=active]:before:top-1.5 data-[state=active]:before:h-5 " +
        "data-[state=active]:before:w-0.5 data-[state=active]:before:rounded " +
        "data-[state=active]:before:bg-[var(--c-success)]"
      }
    >
      {label}
    </Tabs.Trigger>
  );
}

/**
 * v0.4.1 T2/T5：外观设置 tab。
 *
 * 当前段位：
 * - **ActivityBar 位置**（T2）：4 向 radio（right / left / top / bottom）
 * - **主题模式**（T5）：3 态 radio（auto / dark / light）
 *
 * 主题模式切换走 settings store → main.tsx 的 subscription → applyTheme
 * 写 <html data-theme> + TerminalView 自动切配对 xterm theme。
 * UI 简化版：不放"dark/light 双下拉"，xterm 配对走 themes.ts 的
 * `getPairedTheme`（用户在终端 tab 选的 theme 即基准 theme）。
 */
function AppearanceTab() {
  const { t } = useTranslation();
  const position = useSettingsStore(
    (s) => s.settings.ui.activity_bar_position,
  );
  const themeMode = useSettingsStore((s) => s.settings.ui.theme_mode);
  const update = useSettingsStore((s) => s.update);

  const positionOptions: Array<{ value: ActivityBarPosition; label: string }> = [
    { value: "right", label: t("appearance.position.right") },
    { value: "left", label: t("appearance.position.left") },
    { value: "top", label: t("appearance.position.top") },
    { value: "bottom", label: t("appearance.position.bottom") },
  ];

  const themeOptions: Array<{ value: ThemeMode; label: string }> = [
    { value: "auto", label: t("appearance.themeModeOption.auto") },
    { value: "dark", label: t("appearance.themeModeOption.dark") },
    { value: "light", label: t("appearance.themeModeOption.light") },
  ];

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("appearance.layout")}
        </h3>
        <div>
          <div
            className="mb-2 text-xs text-[var(--c-text-muted)]"
            id="activity-bar-position-label"
          >
            {t("appearance.activityBarPosition")}
          </div>
          <div
            role="radiogroup"
            aria-labelledby="activity-bar-position-label"
            className="flex flex-wrap gap-2"
          >
            {positionOptions.map((opt) => {
              const active = position === opt.value;
              return (
                <label
                  key={opt.value}
                  className={
                    "flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-xs transition-colors " +
                    (active
                      ? "border-[var(--c-success)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                      : "border-[var(--c-border-strong)] bg-[var(--c-bg-base)] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]")
                  }
                >
                  <input
                    type="radio"
                    name="activity-bar-position"
                    value={opt.value}
                    checked={active}
                    onChange={() =>
                      update({ ui: { activity_bar_position: opt.value } })
                    }
                    className="accent-[var(--c-success)]"
                    aria-label={t("appearance.activityBarAriaItem", { label: opt.label })}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-[var(--c-text-dim)]">
            {t("appearance.activityBarHelp")}
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("appearance.themeMode")}
        </h3>
        <div>
          <div
            className="mb-2 text-xs text-[var(--c-text-muted)]"
            id="theme-mode-label"
          >
            {t("appearance.themeModeHelpHeader")}
          </div>
          <div
            role="radiogroup"
            aria-labelledby="theme-mode-label"
            className="flex flex-wrap gap-2"
          >
            {themeOptions.map((opt) => {
              const active = themeMode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={
                    "flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-xs transition-colors " +
                    (active
                      ? "border-[var(--c-success)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                      : "border-[var(--c-border-strong)] bg-[var(--c-bg-base)] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]")
                  }
                >
                  <input
                    type="radio"
                    name="theme-mode"
                    value={opt.value}
                    checked={active}
                    onChange={() =>
                      update({ ui: { theme_mode: opt.value } })
                    }
                    className="accent-[var(--c-success)]"
                    aria-label={t("appearance.themeModeAriaItem", { label: opt.label })}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-[var(--c-text-dim)]">
            {t("appearance.themeModeFooter")}
          </p>
        </div>
      </section>

      <SidePanelPositionSection />

      <NotificationSection />

      <GeneralSection />
    </div>
  );
}

/**
 * v0.9.0 T4：通用设置（关闭应用二次确认 toggle）。
 *
 * 默认开启；关掉之后红叉 / Cmd+Q 直接退出（跟 v0.8.x 之前行为一致）。
 * 跟 NotificationSection 一致的 checkbox 风格，立即生效 + 持久化到 settings.toml。
 */
function GeneralSection() {
  const { t } = useTranslation();
  const confirmQuit = useSettingsStore((s) => s.settings.ui.confirm_quit);
  const update = useSettingsStore((s) => s.update);

  return (
    <section>
      <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
        {t("appearance.general")}
      </h3>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--c-text-muted)]">
        <input
          type="checkbox"
          checked={confirmQuit}
          onChange={(e) =>
            update({ ui: { confirm_quit: e.target.checked } })
          }
          className="accent-[var(--c-success)]"
          aria-label={t("appearance.confirmQuitLabel")}
          data-testid="confirm-quit-toggle"
        />
        <span>{t("appearance.confirmQuitLabel")}</span>
      </label>
      <p className="mt-2 text-[10px] text-[var(--c-text-dim)]">
        {t("appearance.confirmQuitHelp")}
      </p>
    </section>
  );
}

/**
 * v0.5.0-B：AI 侧栏 / 文件树左右位置可配置（B2 维护者 2026-05-14 提的需求）。
 *
 * 跟 ActivityBar 4 向可配置 (v0.4.1 T2) 同一交互风格：radio + 立即生效 +
 * 持久化到 settings.toml。
 *
 * 默认 AiSidebar=right / FileTree=left（保持 v0.5.0-A 行为不破老用户习惯）。
 */
function SidePanelPositionSection() {
  const { t } = useTranslation();
  const aiPos = useSettingsStore((s) => s.settings.ui.ai_sidebar_position);
  const ftPos = useSettingsStore((s) => s.settings.ui.file_tree_position);
  const update = useSettingsStore((s) => s.update);

  const positionLabel = (v: SidePanelPosition) =>
    v === "left" ? t("appearance.position.left") : t("appearance.position.right");

  const renderRadio = (
    name: string,
    label: string,
    current: SidePanelPosition,
    onChange: (v: SidePanelPosition) => void,
    testIdPrefix: string,
  ) => (
    <div className="mb-3">
      <div className="mb-2 text-xs text-[var(--c-text-muted)]">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {(["left", "right"] as const).map((v) => {
          const active = current === v;
          return (
            <label
              key={v}
              className={
                "flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-xs transition-colors " +
                (active
                  ? "border-[var(--c-success)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                  : "border-[var(--c-border-strong)] bg-[var(--c-bg-base)] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]")
              }
            >
              <input
                type="radio"
                name={name}
                value={v}
                checked={active}
                onChange={() => onChange(v)}
                className="accent-[var(--c-success)]"
                aria-label={t("appearance.sidePanelAriaItem", {
                  label,
                  position: positionLabel(v),
                })}
                data-testid={`${testIdPrefix}-${v}`}
              />
              <span>{positionLabel(v)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <section>
      <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
        {t("appearance.sidePanelLayout")}
      </h3>
      {renderRadio(
        "ai-sidebar-position",
        t("appearance.aiSidebarPosition"),
        aiPos,
        (v) => update({ ui: { ai_sidebar_position: v } }),
        "ai-sidebar-pos",
      )}
      {renderRadio(
        "file-tree-position",
        t("appearance.fileTreePosition"),
        ftPos,
        (v) => update({ ui: { file_tree_position: v } }),
        "file-tree-pos",
      )}
      <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
        {t("appearance.sidePanelHelp")}
      </p>
    </section>
  );
}

/**
 * v0.5.0-A：通知设置 section（系统通知声音开关）。
 *
 * 放在"外观"tab 内（属于全局体验设置范畴）；目前只有 sound 一个开关，
 * 未来扩展通知历史 / per-tab 静音等也在这里加。
 */
function NotificationSection() {
  const { t } = useTranslation();
  const sound = useSettingsStore((s) => s.settings.notifications.sound);
  const update = useSettingsStore((s) => s.update);

  return (
    <section>
      <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
        {t("appearance.notifications")}
      </h3>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--c-text-muted)]">
        <input
          type="checkbox"
          checked={sound}
          onChange={(e) =>
            update({ notifications: { sound: e.target.checked } })
          }
          className="accent-[var(--c-success)]"
          aria-label={t("appearance.notificationSoundLabel")}
        />
        <span>{t("appearance.notificationSoundLabel")}</span>
      </label>
      <p className="mt-2 text-[10px] text-[var(--c-text-dim)]">
        {t("appearance.notificationSoundHelp")}
      </p>
    </section>
  );
}

function TerminalTab() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("terminal.font")}
        </h3>
        <div className="space-y-3">
          <FontFamilyField
            value={settings.terminal.font_family}
            onChange={(font_family) => update({ terminal: { font_family } })}
          />

          <label className="block">
            <div className="mb-1 flex justify-between text-xs text-[var(--c-text-muted)]">
              <span>{t("terminal.fontSize")}</span>
              <span className="font-mono text-[var(--c-text-muted)]">
                {settings.terminal.font_size} px
              </span>
            </div>
            <input
              type="range"
              min={9}
              max={24}
              step={1}
              value={settings.terminal.font_size}
              onChange={(e) =>
                update({ terminal: { font_size: Number(e.target.value) } })
              }
              className="w-full accent-[var(--c-text-dim)]"
            />
          </label>

          <label className="block">
            <div className="mb-1 flex justify-between text-xs text-[var(--c-text-muted)]">
              <span>{t("terminal.lineHeight")}</span>
              <span className="font-mono text-[var(--c-text-muted)]">
                {settings.terminal.line_height.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={1.0}
              max={2.0}
              step={0.05}
              value={settings.terminal.line_height}
              onChange={(e) =>
                update({ terminal: { line_height: Number(e.target.value) } })
              }
              className="w-full accent-[var(--c-text-dim)]"
            />
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("terminal.cursor")}
        </h3>
        <div className="flex gap-2">
          {(["block", "underline", "bar"] as const).map((style) => (
            <button
              key={style}
              onClick={() => update({ terminal: { cursor_style: style } })}
              className={
                "rounded border px-3 py-1 text-xs " +
                (settings.terminal.cursor_style === style
                  ? "border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                  : "border-[var(--c-border)] bg-[var(--c-bg-elev-1)] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]")
              }
            >
              {t(`terminal.cursorStyle.${style}`)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("terminal.theme")}
        </h3>
        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-label={t("terminal.themeRadioGroupAria")}
        >
          {THEMES.map((th) => (
            <ThemeSwatch
              key={th.id}
              themeId={th.id}
              displayName={th.display_name}
              preview={th.preview}
              active={settings.terminal.theme === th.id}
              onSelect={() => update({ terminal: { theme: th.id } })}
            />
          ))}
        </div>
        <p className="mt-2 text-[10px] text-[var(--c-text-dim)]">
          {t("terminal.themeHelp")}
        </p>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("terminal.shell")}
        </h3>
        <label className="block">
          <div className="mb-1 text-xs text-[var(--c-text-muted)]">
            {t("terminal.shellDefaultLabel")}
          </div>
          <input
            type="text"
            placeholder={t("terminal.shellPlaceholder")}
            value={settings.shell.default_shell}
            onChange={(e) => update({ shell: { default_shell: e.target.value } })}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
            {t("terminal.shellHelp")}
          </p>
        </label>
      </section>

      {/* v0.10.6 T4：CodeMirror 编辑器字号（独立于终端字号，按 lastSurface 路由）。
          注：plan §5.7 提议独立 EditorSection.tsx + 新 tab "editor"，
          但目前只一个字段，独立 tab 太空——折中放在 Terminal tab 末尾的
          "编辑器" section 内（i18n key 仍走 settings.editor.fontSize）。 */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("settings.editor.title")}
        </h3>
        <label className="block">
          <div className="mb-1 text-xs text-[var(--c-text-muted)]">
            {t("settings.editor.fontSize")}
          </div>
          <select
            value={settings.editor.font_size}
            onChange={(e) =>
              update({ editor: { font_size: Number(e.target.value) } })
            }
            className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
          >
            {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
            {t("settings.editor.fontSizeHelp")}
          </p>
        </label>
      </section>
    </div>
  );
}

interface ThemeSwatchProps {
  themeId: string;
  displayName: string;
  preview: [string, string, string, string];
  active: boolean;
  onSelect: () => void;
}

/**
 * 主题色卡按钮：上方一个 mini 预览（4 色块拼成 ▦），下方主题名。
 * active 项 --c-success 边框；hover 时 --c-border-strong → --c-text-dim。
 */
function ThemeSwatch({
  themeId,
  displayName,
  preview,
  active,
  onSelect,
}: ThemeSwatchProps) {
  const { t } = useTranslation();
  const [bg, fg, accent1, accent2] = preview;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={t("terminal.themeAriaItem", { name: displayName })}
      onClick={onSelect}
      className={
        "flex flex-col items-center gap-1 rounded border p-1.5 transition-colors " +
        (active
          ? "border-[var(--c-success)] bg-[var(--c-bg-elev-1)]"
          : "border-[var(--c-border-strong)] bg-[var(--c-bg-base)] hover:border-[var(--c-text-dim)]")
      }
    >
      {/* 4 色 mini 预览：左上 bg、右上 fg、左下 accent1、右下 accent2 */}
      <div
        className="grid h-10 w-16 grid-cols-2 grid-rows-2 overflow-hidden rounded-sm"
        data-testid={`theme-preview-${themeId}`}
      >
        <div style={{ backgroundColor: bg }} />
        <div style={{ backgroundColor: fg }} />
        <div style={{ backgroundColor: accent1 }} />
        <div style={{ backgroundColor: accent2 }} />
      </div>
      <span className="text-[10px] text-[var(--c-text-muted)]">{displayName}</span>
    </button>
  );
}

/**
 * 字体预设：value 是 CSS 字体栈，label 是显示名。
 * 第一项 Menlo 是 aitm 默认字体；其标签带"（默认）"后缀，i18n 走 terminal.fontPresetMenloDefault。
 * 其余字体名是品牌名（不翻译）；用 `useFontPresets()` 在组件内拼接 i18n 标签。
 */
const FONT_PRESET_VALUES = [
  { value: "Menlo, Monaco, 'JetBrains Mono', monospace", label: null },
  { value: "'JetBrains Mono', Menlo, monospace", label: "JetBrains Mono" },
  { value: "'Fira Code', Menlo, monospace", label: "Fira Code" },
  { value: "'Source Code Pro', Menlo, monospace", label: "Source Code Pro" },
  { value: "'SF Mono', Menlo, monospace", label: "SF Mono" },
  { value: "'Cascadia Code', Menlo, monospace", label: "Cascadia Code" },
  { value: "'IBM Plex Mono', Menlo, monospace", label: "IBM Plex Mono" },
  { value: "Monaco, monospace", label: "Monaco" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "Courier, monospace", label: "Courier" },
] as const;

const CUSTOM_VALUE = "__custom__";

interface FontFamilyFieldProps {
  value: string;
  onChange: (v: string) => void;
}

function FontFamilyField({ value, onChange }: FontFamilyFieldProps) {
  const { t } = useTranslation();
  const matched = FONT_PRESET_VALUES.some((p) => p.value === value);
  const selectValue = matched ? value : CUSTOM_VALUE;

  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-xs text-[var(--c-text-muted)]">
        <span>{t("terminal.fontFamilyLabel")}</span>
        <span className="text-[var(--c-text-dim)]">{t("terminal.fontFamilyHelp")}</span>
      </div>
      <select
        value={selectValue}
        onChange={(e) => {
          if (e.target.value !== CUSTOM_VALUE) {
            onChange(e.target.value);
          }
        }}
        className="mb-2 w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
      >
        {FONT_PRESET_VALUES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label ?? t("terminal.fontPresetMenloDefault")}
          </option>
        ))}
        <option value={CUSTOM_VALUE} disabled>
          {t("terminal.fontPresetCustomLabel")}
        </option>
      </select>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-xs text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
        style={{ fontFamily: value }}
        placeholder={t("terminal.fontFamilyPlaceholder")}
      />
      <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
        {t("terminal.fontFamilyFooter")}
      </p>
    </label>
  );
}

/**
 * v0.10.4 i18n：语言切换设置段。
 *
 * 选项：英文（默认）/ 简体中文 / 日本語。变更 → 通过 settings store update
 * 持久化到 settings.ui.language；main.tsx 的 settings subscribe 自动调
 * i18n.changeLanguage 触发全 UI 重渲染（react-i18next 内部用 context）。
 */
function LanguageSection() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.settings.ui.language);
  const update = useSettingsStore((s) => s.update);
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-medium">{t("settingsModal.sections.language")}</h3>
      <div className="space-y-2">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <label
            key={lang.code}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--c-bg-elev-2)]"
          >
            <input
              type="radio"
              name="language"
              value={lang.code}
              checked={language === lang.code}
              onChange={() => update({ ui: { language: lang.code } })}
              data-testid={`language-radio-${lang.code}`}
              className="accent-[var(--c-success)]"
            />
            <span className="text-sm">{lang.label}</span>
            <span className="text-[10px] text-[var(--c-text-dim)]">({lang.code})</span>
          </label>
        ))}
      </div>
      <p className="text-[10px] text-[var(--c-text-dim)]">
        {t("settingsModal.languageHelp")}
      </p>
    </section>
  );
}
