// 设置面板：开合订阅 overlays；表单打开时从 getSettings() 绑定一次，每次变更整装新 Settings 提交。
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type ThemePreset,
  type AppTheme,
  type CursorStyle,
  type CloseBehavior,
  type TabBarMode,
  type AppLanguage,
} from "../themes";
import {
  useOverlays,
  closeSettings,
  confirmDialog,
  showCtxMenu,
  closeCtxMenu,
  setUpdateDot,
  toast,
  type CtxItem,
} from "../state/overlays";
import { icon } from "../svg-icons";
import { t } from "../i18n";
import { getSettings, updateSettings } from "../controller";
import { useAppStore } from "../state/store";
import { AgentVersions } from "./AgentVersions";
import { BrandLogo } from "./BrandLogo";
import { RemoteSettings } from "./RemoteSettings";
import { escapeHtml } from "../lib/format";
import type { AgentKind } from "../../../shared/store-types";

function clamp(n: number, min: number, max: number, fb: number): number {
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, n));
}

// npm 镜像候选：只收真正实现 npm registry 协议的源（部分镜像站不反代 registry，装包会 404）；
// 测速走主进程 npm:ping（渲染层 CSP 不放行外网 fetch）。
const NPM_MIRRORS: { name: string; url: string }[] = [
  { name: "腾讯云", url: "https://mirrors.cloud.tencent.com/npm/" },
  { name: "阿里云", url: "https://registry.npmmirror.com" },
  { name: "npm 官方", url: "https://registry.npmjs.org" },
];

const AGENT_TABS: { kind: AgentKind; label: string }[] = [
  { kind: "claude", label: "Claude" },
  { kind: "codex", label: "Codex" },
];

function normUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function npmRegLabel(reg: string): string {
  const cur = normUrl(reg);
  const m = NPM_MIRRORS.find((x) => normUrl(x.url) === cur);
  if (m) return `${t(m.name)} · ${hostOf(m.url)}`;
  return `${t("自定义")} · ${hostOf(cur)}`;
}

// 时延徽标 HTML：undefined = 测速中，-1 = 超时/不通
function latBadge(ms: number | undefined): string {
  if (ms === undefined) return "<span>…</span>";
  if (ms < 0) return `<span class="lat-bad">${t("超时")}</span>`;
  const cls =
    ms < 100
      ? "lat-fast"
      : ms < 200
      ? "lat-ok"
      : ms <= 500
      ? "lat-slow"
      : "lat-bad";
  return `<span class="${cls}">${ms}ms</span>`;
}

// 面板表单快照：文本/数字输入存原始串，提交时才 clamp，输入框不被改写
interface Form {
  family: string;
  size: string;
  line: string;
  scrollback: string;
  npmReg: string;
  theme: string;
  appTheme: string;
  tabBarMode: string;
  downgradeSec: string;
  closeBehavior: string;
  cursor: CursorStyle;
  cursorBlink: boolean;
  dangerMode: boolean;
  disableUpd: boolean;
  codexDangerMode: boolean;
  codexDisableUpd: boolean;
  showFloater: boolean;
  language: AppLanguage;
}

// Settings → 控件值；动态目录尚未返回时也保留已保存的模型值，避免静默丢配置。
function formFromSettings(s: Settings): Form {
  return {
    family: s.font.family,
    size: String(s.font.size),
    line: String(s.font.lineHeight),
    scrollback: String(s.terminal.scrollback),
    npmReg: s.npmRegistry,
    theme: s.terminal.theme,
    appTheme: s.appTheme,
    tabBarMode: s.tabBarMode || "vertical",
    downgradeSec: String(s.statusDowngradeSec),
    closeBehavior: s.closeBehavior || "quit",
    cursor: s.cursor.style,
    cursorBlink: s.cursor.blink,
    dangerMode: s.dangerousSkipPermissions,
    disableUpd: s.disableAutoupdater,
    codexDangerMode: s.codexDangerousSkipPermissions,
    codexDisableUpd: s.codexDisableAutoupdater,
    showFloater: s.showFloater,
    language: s.language || "zh",
  };
}

export function SettingsPanel() {
  const open = useOverlays((s) => s.settingsOpen);
  const rev = useAppStore((s) => s.rev);
  void rev; // 设置在别处变化时刷新「正在使用」卡片

  const [form, setForm] = useState<Form>(() =>
    formFromSettings(DEFAULT_SETTINGS)
  );
  // commit 可能同 tick 连发，走 ref 保证读到最新快照
  const formRef = useRef(form);
  formRef.current = form;
  const [section, setSection] = useState("appearance");
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const [agentTab, setAgentTab] = useState<AgentKind>("claude");
  // 找不到的智能体只显示版本区，方便安装
  const [agentAvail, setAgentAvail] = useState<Record<AgentKind, boolean>>({
    claude: true,
    codex: true,
  });
  const [langOpen, setLangOpen] = useState(false);
  const [langHintShown, setLangHintShown] = useState(false);
  const lastDisableUpdRef = useRef<boolean | null>(null);
  const scrimDownRef = useRef(false);
  const langBtnRef = useRef<HTMLButtonElement>(null);
  // npm 镜像下拉：时延按 url 记账
  const [npmOpen, setNpmOpen] = useState(false);
  const [npmLat, setNpmLat] = useState<Record<string, number | undefined>>({});
  const npmLatRef = useRef(npmLat);
  npmLatRef.current = npmLat;
  const npmBtnRef = useRef<HTMLButtonElement | null>(null);

  const [aboutVer, setAboutVer] = useState("—");
  const aboutVerLoadedRef = useRef(false);
  const [aboutChecking, setAboutChecking] = useState(false);
  const [aboutHint, setAboutHint] = useState("");
  const [aboutDownloading, setAboutDownloading] = useState(false);
  const [aboutUpdReady, setAboutUpdReady] = useState(false);
  const [aboutInstalling, setAboutInstalling] = useState(false);
  const [aboutUpdateVersion, setAboutUpdateVersion] = useState("");
  const [aboutPercent, setAboutPercent] = useState(0);
  const updateDot = useOverlays((s) => s.updateDot);
  const updateActionRef = useRef<"idle" | "checking" | "downloading" | "installing">("idle");

  // 开机自启：状态在系统登录项里，打开面板时读一次
  const [autoLaunch, setAutoLaunchState] = useState(false);
  useEffect(() => {
    void window.term.getAutoLaunch().then(setAutoLaunchState);
  }, []);

  function deferCurrentUpdate(hint: string): void {
    setAboutHint(hint);
    void window.term.deferUpdate().catch(() => {});
  }

  function promptUpdateDownload(version: string): void {
    setAboutUpdateVersion(version);
    confirmDialog({
      title: t("发现新版本"),
      message: t("发现新版本 {0}，是否现在下载？", escapeHtml(`v${version}`)),
      okLabel: t("下载更新"),
      cancelLabel: t("暂不下载"),
      testIdPrefix: "update-download",
      danger: false,
      onOk: () => startUpdateDownload(version),
      onCancel: () => deferCurrentUpdate(
        t("已发现新版本 {0}，可稍后下载。", `v${version}`)
      ),
    });
  }

  function startUpdateDownload(version: string): void {
    if (updateActionRef.current !== "idle") return;
    updateActionRef.current = "downloading";
    setAboutUpdateVersion(version);
    setAboutDownloading(true);
    setAboutUpdReady(false);
    setAboutPercent(0);
    setAboutHint("");
    void window.term.downloadUpdate().then((result) => {
      if (result.ok || updateActionRef.current !== "downloading") return;
      updateActionRef.current = "idle";
      setAboutDownloading(false);
      const message = result.error === "not-owner" || result.error === "busy"
        ? t("更新操作正在其他窗口中进行。")
        : t("下载失败，请检查网络后重试。");
      setAboutHint(message);
      toast(message);
    }).catch(() => {
      if (updateActionRef.current !== "downloading") return;
      updateActionRef.current = "idle";
      setAboutDownloading(false);
      const message = t("下载失败，请检查网络后重试。");
      setAboutHint(message);
      toast(message);
    });
  }

  function promptUpdateRestart(version: string): void {
    confirmDialog({
      title: t("更新已下载"),
      message: t(
        "新版本 {0} 已下载完成。立即重启将终止所有终端会话，并打开安装程序。",
        escapeHtml(`v${version}`)
      ),
      okLabel: t("立即重启"),
      cancelLabel: t("稍后"),
      testIdPrefix: "update-restart",
      danger: false,
      onOk: requestUpdateInstall,
      onCancel: () => void window.term.deferUpdate().catch(() => {}),
    });
  }

  function requestUpdateInstall(): void {
    if (updateActionRef.current !== "idle") return;
    updateActionRef.current = "installing";
    setAboutInstalling(true);
    setAboutHint("");
    void window.term.installUpdate().then((result) => {
      if (result.ok || updateActionRef.current !== "installing") return;
      updateActionRef.current = "idle";
      setAboutInstalling(false);
      setAboutUpdReady(true);
      const message = result.error === "not-owner" || result.error === "busy"
        ? t("更新操作正在其他窗口中进行。")
        : t("安装程序启动失败，请重试。");
      setAboutHint(message);
      toast(message);
    }).catch(() => {
      updateActionRef.current = "idle";
      setAboutInstalling(false);
      setAboutUpdReady(true);
      const message = t("安装程序启动失败，请重试。");
      setAboutHint(message);
      toast(message);
    });
  }

  async function handleCheckUpdate(): Promise<void> {
    if (updateActionRef.current !== "idle") return;
    updateActionRef.current = "checking";
    setAboutChecking(true);
    setAboutHint("");
    try {
      const result = await window.term.checkUpdate();
      if (result.status === "update") {
        promptUpdateDownload(result.latest);
      } else if (result.status === "downloaded") {
        setAboutUpdateVersion(result.latest);
        setAboutUpdReady(true);
      } else if (result.status === "latest") {
        setAboutHint(t("已是最新版本。"));
      } else if (result.status === "busy") {
        setAboutHint(t("更新操作正在其他窗口中进行。"));
      } else if (result.error === "notfound") {
        setAboutHint(t("暂无可用的发布版本。"));
      } else if (result.error === "dev") {
        setAboutHint(t("开发模式下不可用。"));
      } else {
        setAboutHint(t("检查失败，请检查网络后重试。"));
      }
    } catch {
      setAboutHint(t("检查失败，请检查网络后重试。"));
    } finally {
      updateActionRef.current = "idle";
      setAboutChecking(false);
    }
  }

  useEffect(() => {
    return window.term.onUpdateEvent((event) => {
      if (event.kind === "progress") {
        updateActionRef.current = "downloading";
        setAboutUpdateVersion(event.version);
        setAboutDownloading(true);
        setAboutPercent(Number.isFinite(event.percent) ? Math.min(100, Math.max(0, event.percent)) : 0);
        setAboutHint("");
      } else if (event.kind === "downloaded") {
        updateActionRef.current = "idle";
        setAboutDownloading(false);
        setAboutInstalling(false);
        setAboutUpdateVersion(event.version);
        setAboutUpdReady(true);
        setAboutHint("");
        // 正在看「关于」时不用再提醒
        const st = useOverlays.getState();
        if (!(st.settingsOpen && sectionRef.current === "about")) {
          setUpdateDot(true);
        }
      } else {
        updateActionRef.current = "idle";
        setAboutDownloading(false);
        setAboutInstalling(false);
        if (event.stage === "install") setAboutUpdReady(true);
        const message = event.stage === "download"
          ? t("下载失败，请检查网络后重试。")
          : t("安装程序启动失败，请重试。");
        setAboutHint(t("更新出错：{0}", event.message));
        toast(message);
      }
    });
  }, []);

  function doCommit(f: Form): void {
    const cur = getSettings();
    const next: Settings = {
      // 用 cur 打底，保留面板里没有的字段，否则每次保存会被抹掉
      ...cur,
      version: 1,
      font: {
        family: f.family.trim() || DEFAULT_SETTINGS.font.family,
        size: clamp(Number(f.size), 8, 40, cur.font.size),
        lineHeight: clamp(Number(f.line), 1.0, 2.0, cur.font.lineHeight),
      },
      cursor: {
        style: f.cursor || cur.cursor.style,
        blink: f.cursorBlink,
      },
      terminal: {
        scrollback: clamp(
          Number(f.scrollback),
          100,
          100000,
          cur.terminal.scrollback
        ),
        theme: (f.theme as ThemePreset) || cur.terminal.theme,
      },
      appTheme: (f.appTheme as AppTheme) || cur.appTheme,
      tabBarMode: (f.tabBarMode as TabBarMode) || cur.tabBarMode,
      defaults: {
        // cwd 预填靠 lastUsedCwd 自动记忆，面板不提供手动默认路径
        cwd: cur.defaults.cwd,
      },
      dangerousSkipPermissions: f.dangerMode,
      // claudePath / codexPath 由版本管理维护，面板不直接编辑（...cur 已带上）
      disableAutoupdater: f.disableUpd,
      codexDangerousSkipPermissions: f.codexDangerMode,
      codexDisableAutoupdater: f.codexDisableUpd,
      npmRegistry: f.npmReg.trim() || DEFAULT_SETTINGS.npmRegistry,
      statusDowngradeSec: clamp(
        Number(f.downgradeSec),
        0,
        5,
        cur.statusDowngradeSec
      ),
      showFloater: f.showFloater,
      closeBehavior: (f.closeBehavior as CloseBehavior) || cur.closeBehavior,
      language: f.language || cur.language,
    };
    updateSettings(next);
    if (
      lastDisableUpdRef.current !== null &&
      lastDisableUpdRef.current !== next.disableAutoupdater
    ) {
      void syncSystemEnv(next.disableAutoupdater);
    }
    lastDisableUpdRef.current = next.disableAutoupdater;
  }

  function commit(patch: Partial<Form>): void {
    const f = { ...formRef.current, ...patch };
    formRef.current = f;
    setForm(f);
    doCommit(f);
  }

  async function syncSystemEnv(enabled: boolean): Promise<void> {
    try {
      await window.term.applyDisableAutoupdater(enabled);
    } catch {}
  }

  async function ensureUpdConsistency(): Promise<void> {
    try {
      const cur = await window.term.readDisableAutoupdater();
      if (getSettings().disableAutoupdater && cur !== "1") {
        await syncSystemEnv(true);
      }
    } catch {}
  }

  async function refreshAgentAvail(): Promise<void> {
    const [claude, codex] = await Promise.all([
      window.term.agentAvailable("claude"),
      window.term.agentAvailable("codex"),
    ]);
    setAgentAvail({ claude, codex });
  }

  // 打开时：绑定表单 + 回到外观分区（或指定的分区） + 环境变量一致性补写 + 重新检测智能体
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const s = getSettings();
      const f = formFromSettings(s);
      formRef.current = f;
      setForm(f);
      lastDisableUpdRef.current = s.disableAutoupdater;
      activateSection(useOverlays.getState().settingsSection ?? "appearance");
      setAgentTab("claude");
      void ensureUpdConsistency();
      void refreshAgentAvail();
    }
    prevOpenRef.current = open;
  }, [open]);

  // 每次打开清空重测全部镜像时延
  useEffect(() => {
    if (!open) return;
    setNpmLat({});
    const urls = new Set(NPM_MIRRORS.map((m) => m.url));
    const cur = normUrl(getSettings().npmRegistry);
    if (cur) urls.add(cur);
    for (const url of urls) {
      void window.term.npmPing(url).then((ms) => {
        setNpmLat((prev) => ({ ...prev, [url]: ms }));
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeSettings();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function activateSection(name: string): void {
    setSection(name);
    // 打开「关于」就算看过了，收起小红点
    if (name === "about") {
      setUpdateDot(false);
    }
    if (name === "about" && !aboutVerLoadedRef.current) {
      aboutVerLoadedRef.current = true;
      void window.term.appVersion().then((v) => setAboutVer(v));
    }
  }

  // 语言 picker（showCtxMenu 浮层复用）；已展开时再点收起
  // 下拉选项固定用各自语言显示，不随界面语言翻译
  function openLanguagePicker(): void {
    if (langOpen) {
      closeCtxMenu();
      return;
    }
    const cur = formRef.current.language || "zh";
    const setVal = (v: AppLanguage): void => {
      if ((formRef.current.language || "zh") === v) return;
      commit({ language: v });
      promptLanguageRestart();
    };
    const items: CtxItem[] = [
      {
        label: "简体中文",
        icon: cur === "zh" ? "✓" : "",
        act: () => setVal("zh"),
      },
      {
        label: "English",
        icon: cur === "en" ? "✓" : "",
        act: () => setVal("en"),
      },
    ];
    const btn = langBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setLangOpen(true);
    showCtxMenu(items, r.left, r.bottom + 4, () => setLangOpen(false), {
      minWidth: r.width,
    });
  }

  function npmMenuItems(): CtxItem[] {
    const cur = normUrl(formRef.current.npmReg);
    const setVal = (v: string): void => {
      if (normUrl(formRef.current.npmReg) === normUrl(v)) return;
      commit({ npmReg: v });
    };
    const lat = npmLatRef.current;
    const entries: { name: string; url: string }[] = [...NPM_MIRRORS];
    // 老配置的自定义地址不在预置列表 → 追加一项
    if (cur && !NPM_MIRRORS.some((m) => normUrl(m.url) === cur)) {
      entries.push({ name: "自定义", url: cur });
    }
    // 按测速快慢升序：测速中排其后，超时/不通垫底
    const latRank = (ms: number | undefined): number =>
      ms === undefined ? 1_000_000 : ms < 0 ? 2_000_000 : ms;
    entries.sort((a, b) => latRank(lat[a.url]) - latRank(lat[b.url]));
    return entries.map((m) => ({
      label: `${t(m.name)} · ${hostOf(m.url)}`,
      icon: cur === normUrl(m.url) ? "✓" : "",
      metaHtml: latBadge(lat[m.url]),
      act: () => setVal(m.url),
    }));
  }

  function showNpmMenu(): void {
    const btn = npmBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    showCtxMenu(npmMenuItems(), r.left, r.bottom + 4, () => setNpmOpen(false), {
      minWidth: r.width,
    });
  }

  function openNpmPicker(): void {
    if (npmOpen) {
      closeCtxMenu();
      return;
    }
    setNpmOpen(true);
    showNpmMenu();
  }

  // 测速结果陆续返回时原位刷新已打开的下拉
  useEffect(() => {
    if (npmOpen) showNpmMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npmLat]);

  function promptLanguageRestart(): void {
    setLangHintShown(true);
    confirmDialog({
      title: t("切换语言"),
      message: t(
        "语言切换将在重启应用后生效。<br>立即重启？所有终端会话都会被终止。"
      ),
      okLabel: t("立即重启"),
      danger: true,
      onOk: () => window.term.relaunchApp(),
    });
  }

  function onReset(): void {
    confirmDialog({
      title: t("恢复默认"),
      message: t(
        "确定把所有设置恢复到默认？<br>字体 / 光标 / 主题 / 镜像 等都会被重置。<br>此操作不可撤销。"
      ),
      okLabel: t("恢复"),
      danger: true,
      onOk: () => {
        // 语言不跟随「恢复默认」重置
        const f = formFromSettings({
          ...DEFAULT_SETTINGS,
          language: getSettings().language,
        });
        // 先重置 lastDisableUpd 基线再 commit，重置不触发环境变量同步
        lastDisableUpdRef.current = f.disableUpd;
        formRef.current = f;
        setForm(f);
        doCommit(f);
      },
    });
  }

  const seg = (
    id: string,
    ariaLabel: string,
    val: string,
    pick: (v: string) => void,
    options: Array<{ v: string; label: string }>,
    compact = false
  ) => (
    <div
      className={"seg-group" + (compact ? " seg-compact" : "")}
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.v}
          className={"seg-item" + (val === o.v ? " active" : "")}
          data-val={o.v}
          type="button"
          role="radio"
          onClick={() => pick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      id="settingsScrim"
      className="scrim"
      hidden={!open}
      onMouseDown={(e) => {
        scrimDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && scrimDownRef.current)
          closeSettings();
        scrimDownRef.current = false;
      }}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("设置")}
      >
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("设置分区")}>
            <button
              className={
                "set-nav-item" + (section === "appearance" ? " active" : "")
              }
              data-section="appearance"
              type="button"
              onClick={() => activateSection("appearance")}
            >
              <span className="ic">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 3a9 9 0 0 1 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z" />
                </svg>
              </span>
              {t("外观")}
            </button>
            <button
              className={
                "set-nav-item" + (section === "general" ? " active" : "")
              }
              data-section="general"
              type="button"
              onClick={() => activateSection("general")}
            >
              <span className="ic">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
              </span>
              {t("通用")}
            </button>
            <button
              className={
                "set-nav-item" + (section === "terminal" ? " active" : "")
              }
              data-section="terminal"
              type="button"
              onClick={() => activateSection("terminal")}
            >
              <span className="ic">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
                  <polyline points="6.5 9 10 12 6.5 15" />
                  <line x1="12.5" y1="15" x2="17.5" y2="15" />
                </svg>
              </span>
              {t("终端")}
            </button>
            <button
              className={
                "set-nav-item" + (section === "agent" ? " active" : "")
              }
              data-section="agent"
              data-testid="set-nav-agent"
              type="button"
              onClick={() => activateSection("agent")}
            >
              <span
                className="ic"
                dangerouslySetInnerHTML={{ __html: icon("bot", { size: 14 }) }}
              />
              {t("智能体")}
            </button>
            <button
              className={
                "set-nav-item" + (section === "remote" ? " active" : "")
              }
              data-section="remote"
              data-testid="set-nav-remote"
              type="button"
              onClick={() => activateSection("remote")}
            >
              <span
                className="ic"
                data-testid="set-nav-remote-ic"
                dangerouslySetInnerHTML={{ __html: icon("smartphone", { size: 14 }) }}
              />
              {t("远程访问")}
            </button>
            <button
              className={
                "set-nav-item" + (section === "about" ? " active" : "")
              }
              data-section="about"
              type="button"
              onClick={() => activateSection("about")}
            >
              <span className="ic">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </span>
              {t("关于")}
              {updateDot ? <span className="upd-dot" data-testid="set-nav-about-dot" /> : null}
            </button>
            <div className="settings-nav-foot">
              <button
                id="set-reset"
                className="btn btn-secondary"
                type="button"
                onClick={onReset}
              >
                {t("恢复默认")}
              </button>
              <button
                id="set-close"
                className="btn btn-primary"
                type="button"
                onClick={() => closeSettings()}
              >
                {t("完成")}
              </button>
            </div>
          </nav>

          <div className="settings-pane">
            <div
              className="set-section"
              data-section="appearance"
              hidden={section !== "appearance"}
            >
              <div className="set-row">
                <label>{t("标签栏")}</label>
                {seg(
                  "set-tabbar-mode",
                  t("标签栏布局"),
                  form.tabBarMode,
                  (v) => commit({ tabBarMode: v }),
                  [
                    { v: "vertical", label: t("垂直标签栏") },
                    { v: "horizontal", label: t("水平标签栏") },
                  ]
                )}
              </div>
              <div className="set-row">
                <label>{t("终端主题")}</label>
                {seg(
                  "set-theme",
                  t("终端主题"),
                  form.theme,
                  (v) => commit({ theme: v }),
                  [
                    { v: "vscode-dark", label: "VSCode Dark" },
                    { v: "vercel-dark", label: "Vercel Dark" },
                    { v: "one-dark", label: "One Dark" },
                  ]
                )}
              </div>
              <div className="set-row">
                <label>{t("应用主题")}</label>
                {seg(
                  "set-app-theme",
                  t("应用主题"),
                  form.appTheme,
                  (v) => commit({ appTheme: v }),
                  [
                    { v: "light", label: t("浅色") },
                    { v: "dark", label: t("深色") },
                  ]
                )}
              </div>
            </div>

            <div
              className="set-section"
              data-section="general"
              hidden={section !== "general"}
            >
              <div className="set-row">
                <label>{t("语言")}</label>
                <button
                  type="button"
                  className={"picker-select" + (langOpen ? " open" : "")}
                  id="set-language"
                  data-val={form.language}
                  ref={langBtnRef}
                  onClick={(e) => {
                    e.stopPropagation(); // 挡掉 document.click 关 ctx 的兜底
                    openLanguagePicker();
                  }}
                >
                  <span className="picker-label">
                    {form.language === "en" ? "English" : "简体中文"}
                  </span>
                  <span
                    className="picker-chev"
                    dangerouslySetInnerHTML={{
                      __html: icon("chevron-down", { size: 14 }),
                    }}
                  />
                </button>
                <div
                  className="set-row-hint"
                  id="set-language-hint"
                  hidden={!langHintShown}
                >
                  {t("语言切换将在重启应用后生效")}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => window.term.relaunchApp()}
                  >
                    {t("立即重启")}
                  </button>
                </div>
              </div>
              <div className="set-row">
                <label>
                  {t("查看后清除完成标记")}
                  <span
                    className="set-info"
                    role="img"
                    tabIndex={0}
                    aria-label={t("切到已完成的标签页后，过几秒绿点自动消失")}
                    title={t("切到已完成的标签页后，过几秒绿点自动消失")}
                    data-testid="set-downgrade-sec-info"
                    dangerouslySetInnerHTML={{ __html: icon("info", { size: 12 }) }}
                  />
                </label>
                {seg(
                  "set-downgrade-sec",
                  t("查看后清除完成标记"),
                  form.downgradeSec,
                  (v) => commit({ downgradeSec: v }),
                  [
                    { v: "1", label: t("立即") },
                    { v: "3", label: t("3 秒") },
                    { v: "5", label: t("5 秒") },
                    { v: "0", label: t("不自动清除") },
                  ]
                )}
              </div>
              <div className="set-row set-row-toggle">
                <label>{t("开机自动启动")}</label>
                <input
                  id="set-auto-launch"
                  type="checkbox"
                  checked={autoLaunch}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAutoLaunchState(next);
                    void window.term.setAutoLaunch(next).then((r) => {
                      // 开发模式写不了登录项，回滚勾选并提示
                      if (!r.ok) {
                        setAutoLaunchState(!next);
                        toast(t("开发模式下不可用。"));
                      }
                    });
                  }}
                />
              </div>
              <div className="set-row set-row-toggle">
                <label>
                  {t("开启悬浮窗")}
                </label>
                <input
                  id="set-show-floater"
                  type="checkbox"
                  checked={form.showFloater}
                  onChange={(e) => commit({ showFloater: e.target.checked })}
                />
              </div>
              <div className="set-row">
                <label>{t("点击关闭按钮时")}</label>
                {seg(
                  "set-close-behavior",
                  t("点击关闭按钮时"),
                  form.closeBehavior,
                  (v) => commit({ closeBehavior: v }),
                  [
                    { v: "quit", label: t("确认后退出") },
                    { v: "tray", label: t("收进托盘") },
                  ]
                )}
              </div>
            </div>

            <div
              className="set-section"
              data-section="terminal"
              hidden={section !== "terminal"}
            >
              <div className="set-row">
                <label>{t("字体族")}</label>
                <input
                  id="set-font-family"
                  className="mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.family}
                  onChange={(e) => commit({ family: e.target.value })}
                />
              </div>
              <div className="set-row two">
                <div>
                  <label>{t("字号 (px)")}</label>
                  <input
                    id="set-font-size"
                    type="number"
                    min="8"
                    max="40"
                    step="1"
                    value={form.size}
                    onChange={(e) => commit({ size: e.target.value })}
                  />
                </div>
                <div>
                  <label>{t("行高")}</label>
                  <input
                    id="set-line-height"
                    type="number"
                    min="1.0"
                    max="2.0"
                    step="0.05"
                    value={form.line}
                    onChange={(e) => commit({ line: e.target.value })}
                  />
                </div>
              </div>
              <div className="set-row">
                <label>{t("光标样式")}</label>
                <div
                  className="seg-group"
                  id="set-cursor-style"
                  role="radiogroup"
                  aria-label={t("光标样式")}
                >
                  <button
                    className={
                      "seg-item" + (form.cursor === "block" ? " active" : "")
                    }
                    data-val="block"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: "block" })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <rect
                        x="2"
                        y="3"
                        width="6"
                        height="8"
                        fill="currentColor"
                      />
                    </svg>
                    <span>block</span>
                  </button>
                  <button
                    className={
                      "seg-item" +
                      (form.cursor === "underline" ? " active" : "")
                    }
                    data-val="underline"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: "underline" })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <rect
                        x="2"
                        y="10"
                        width="6"
                        height="2"
                        fill="currentColor"
                      />
                    </svg>
                    <span>underline</span>
                  </button>
                  <button
                    className={
                      "seg-item" + (form.cursor === "bar" ? " active" : "")
                    }
                    data-val="bar"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: "bar" })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <rect
                        x="2"
                        y="3"
                        width="2"
                        height="8"
                        fill="currentColor"
                      />
                    </svg>
                    <span>bar</span>
                  </button>
                </div>
              </div>
              <div className="set-row">
                <label>{t("回滚缓冲（行）")}</label>
                <input
                  id="set-scrollback"
                  type="number"
                  min="100"
                  max="100000"
                  step="500"
                  value={form.scrollback}
                  onChange={(e) => commit({ scrollback: e.target.value })}
                />
              </div>
              <div className="set-row set-row-toggle">
                <label>{t("光标闪烁")}</label>
                <input
                  id="set-cursor-blink"
                  type="checkbox"
                  checked={form.cursorBlink}
                  onChange={(e) => commit({ cursorBlink: e.target.checked })}
                />
              </div>
            </div>

            <div
              className="set-section"
              data-section="agent"
              hidden={section !== "agent"}
            >
              <div
                className="seg-group kind-pick agent-tabs"
                role="tablist"
                aria-label={t("智能体")}
              >
                {AGENT_TABS.map((a) => (
                  <button
                    key={a.kind}
                    type="button"
                    role="tab"
                    aria-selected={agentTab === a.kind}
                    className={"seg-item" + (agentTab === a.kind ? " active" : "")}
                    data-testid={`set-agent-tab-${a.kind}`}
                    onClick={() => setAgentTab(a.kind)}
                  >
                    <span
                      dangerouslySetInnerHTML={{
                        __html: icon(a.kind, { size: 14 }),
                      }}
                    />
                    {a.label}
                  </button>
                ))}
              </div>
              {AGENT_TABS.map((a) => (
                <div
                  key={a.kind}
                  role="tabpanel"
                  data-testid={`set-agent-page-${a.kind}`}
                  hidden={agentTab !== a.kind}
                >
                  {agentAvail[a.kind] ? (
                    <>
                      <div className="set-subhead">{t("启动")}</div>
                      <div className="set-row set-row-toggle">
                        <label>{t("默认以危险模式启动")}</label>
                        <input
                          type="checkbox"
                          aria-label={t("默认以危险模式启动")}
                          data-testid={`set-${a.kind}-danger-mode`}
                          checked={a.kind === "codex" ? form.codexDangerMode : form.dangerMode}
                          onChange={(e) =>
                            commit(
                              a.kind === "codex"
                                ? { codexDangerMode: e.target.checked }
                                : { dangerMode: e.target.checked }
                            )
                          }
                        />
                      </div>
                    </>
                  ) : null}
                  <div className="set-subhead">{t("版本")}</div>
                  <AgentVersions
                    agent={a.kind}
                    active={open && section === "agent" && agentTab === a.kind}
                    found={agentAvail[a.kind]}
                    onChanged={() => void refreshAgentAvail()}
                  >
                    <div className="set-row set-row-toggle">
                      <label>{t("禁止自动升级")}</label>
                      <input
                        type="checkbox"
                        aria-label={t("禁止自动升级")}
                        data-testid={`set-${a.kind}-disable-update`}
                        checked={a.kind === "codex" ? form.codexDisableUpd : form.disableUpd}
                        onChange={(e) =>
                          commit(
                            a.kind === "codex"
                              ? { codexDisableUpd: e.target.checked }
                              : { disableUpd: e.target.checked }
                          )
                        }
                      />
                    </div>
                    <div className="set-row">
                      <label>{t("下载源")}</label>
                      <button
                        type="button"
                        className={"picker-select" + (npmOpen ? " open" : "")}
                        aria-label={t("下载源")}
                        data-testid={`set-${a.kind}-npm-registry`}
                        onClick={(e) => {
                          e.stopPropagation(); // 挡掉 document.click 关 ctx 的兜底
                          npmBtnRef.current = e.currentTarget;
                          openNpmPicker();
                        }}
                      >
                        <span className="picker-label">
                          {npmRegLabel(form.npmReg)}
                        </span>
                        <span
                          className="picker-chev"
                          dangerouslySetInnerHTML={{
                            __html: icon("chevron-down", { size: 14 }),
                          }}
                        />
                      </button>
                    </div>
                  </AgentVersions>
                </div>
              ))}
            </div>

            <div
              className="set-section"
              data-section="remote"
              data-testid="set-section-remote"
              hidden={section !== "remote"}
            >
              <RemoteSettings active={open && section === "remote"} />
            </div>

            <div
              className="set-section"
              data-section="about"
              hidden={section !== "about"}
            >
              <div className="about-card">
                <span className="about-icon" aria-hidden="true">
                  <BrandLogo size={40} />
                </span>
                <div className="about-name">CC Terminal</div>
                <div className="about-ver">
                  {t("版本")} <span id="about-version">{aboutVer}</span>
                </div>
                {aboutUpdReady ? (
                  <button
                    id="about-install-update"
                    className="btn btn-primary"
                    type="button"
                    data-testid="about-install-update-button"
                    disabled={aboutInstalling}
                    onClick={() => promptUpdateRestart(aboutUpdateVersion)}
                  >
                    {aboutInstalling ? t("正在启动安装程序…") : t("重启并安装 {0}", `v${aboutUpdateVersion}`)}
                  </button>
                ) : aboutDownloading ? (
                  <div className="about-progress" data-testid="about-update-progress">
                    <progress
                      max={100}
                      value={aboutPercent}
                      aria-label={t("更新下载进度")}
                      data-testid="about-update-progress-bar"
                    />
                    <div className="about-progress-label" data-testid="about-update-progress-label">
                      <span data-testid="about-update-progress-version">{`v${aboutUpdateVersion}`}</span>
                      <span data-testid="about-update-progress-value">{`${Math.floor(aboutPercent)}%`}</span>
                    </div>
                  </div>
                ) : (
                  <button
                    id="about-check-update"
                    className="btn btn-secondary"
                    type="button"
                    data-testid="about-check-update-button"
                    disabled={aboutChecking}
                    onClick={() => void handleCheckUpdate()}
                  >
                    {aboutChecking ? t("检查中…") : t("检查更新")}
                  </button>
                )}
                <div className="about-hint" id="about-hint" data-testid="about-update-status">
                  {aboutHint}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
