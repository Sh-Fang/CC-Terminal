// 智能体版本管理：当前版本卡片 + 版本列表（安装 / 启用 / 卸载），Claude 与 Codex 各一份
import { useEffect, useRef, useState, type ReactNode } from "react";
import { confirmDialog } from "../state/overlays";
import { t } from "../i18n";
import { getSettings, updateSettings } from "../controller";
import type { AgentKind } from "../../../shared/store-types";

// 与 preload 的 InstalledAgentVersion 同构；跨 tsconfig import 会报 TS6307，手抄一份
interface InstalledAgentVersion {
  version: string;
  path: string;
  installedAt: number;
  active: boolean;
}

const PAGE_SIZE = 10;

// 简易 semver 比较：与主进程 cc-versions.ts 保持一致；pre-release 视为更小
function cmpSemver(a: string, b: string): number {
  const [ah, ap = ""] = a.split("-", 2);
  const [bh, bp = ""] = b.split("-", 2);
  const pa = ah.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = bh.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  if (ap === bp) return 0;
  if (!ap) return 1;
  if (!bp) return -1;
  // pre-release 按点分段比较，纯数字段按数值比（alpha.12 > alpha.3）
  const sa = ap.split(".");
  const sb = bp.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    if (sa[i] === sb[i]) continue;
    const na = /^\d+$/.test(sa[i]) ? Number(sa[i]) : NaN;
    const nb = /^\d+$/.test(sb[i]) ? Number(sb[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return sa[i] < sb[i] ? -1 : 1;
  }
  return 0;
}

function pathOf(agent: AgentKind): string {
  const s = getSettings();
  return (agent === "codex" ? s.codexPath : s.claudePath)?.trim() || "";
}

// 版本管理内部状态：塞进 ref 对象手动 rerender，避免异步流程踩 React state 闭包陈旧坑
interface VerState {
  installedSet: Set<string>;
  installedMap: Map<string, { path: string; active: boolean }>;
  remote: string[];
  activeVersion: string; // 托管路径命中的版本
  detectedVersion: string; // 从设置里的路径反查到的版本（含自定义路径场景）
  installingVer: string;
  loaded: boolean;
  infoLoaded: boolean; // applyInstalled 至少跑过一次
  page: number;
  installStartTs: number;
  installPhase: string;
  hintText: string;
  hintKind: "" | "ok" | "err";
  refreshing: boolean;
  search: string;
  onlyInstalled: boolean;
}

interface Props {
  agent: AgentKind;
  // 面板打开且这一页可见
  active: boolean;
  // 设置里选定的可执行文件存在，或 PATH 上有
  found: boolean;
  // 当前使用的版本变了（安装后自动启用 / 手动启用）
  onChanged: () => void;
  // 夹在当前版本卡片与版本列表之间的设置项
  children?: ReactNode;
}

export function AgentVersions({ agent, active, found, onChanged, children }: Props) {
  const v = useRef<VerState>({
    installedSet: new Set(),
    installedMap: new Map(),
    remote: [],
    activeVersion: "",
    detectedVersion: "",
    installingVer: "",
    loaded: false,
    infoLoaded: false,
    page: 1,
    installStartTs: 0,
    installPhase: "",
    hintText: "",
    hintKind: "",
    refreshing: false,
    search: "",
    onlyInstalled: false,
  }).current;
  const [, setTick] = useState(0);
  const rerender = (): void => setTick((n) => n + 1);
  const tickerRef = useRef<number | null>(null);

  useEffect(
    () =>
      window.term.onVerInstallPhase((p) => {
        if (p.agent === agent && p.version === v.installingVer) {
          v.installPhase = p.phase;
          rerender();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // 卸载兜底清理（组件常驻，仅热更/整树卸载时触发）
  useEffect(
    () => () => {
      if (tickerRef.current !== null) clearInterval(tickerRef.current);
    },
    []
  );

  // 每次切到这一页：回到第一页；首次必拉远端，之后只刷新已安装，远端靠「刷新」按钮重拉
  useEffect(() => {
    if (!active) return;
    v.page = 1;
    void refresh(!v.loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function setHint(text: string, kind: "" | "ok" | "err"): void {
    v.hintText = text;
    v.hintKind = kind;
  }

  function applyInstalled(list: InstalledAgentVersion[], curVer: string | null): void {
    v.installedSet = new Set(list.map((x) => x.version));
    v.installedMap = new Map(list.map((x) => [x.version, { path: x.path, active: x.active }]));
    v.activeVersion = list.find((x) => x.active)?.version ?? "";
    v.detectedVersion = curVer ?? "";
    v.infoLoaded = true;
  }

  async function refresh(fetchRemote: boolean): Promise<void> {
    if (fetchRemote) {
      v.refreshing = true;
      rerender();
      try {
        const [installed, remoteRes, curVer] = await Promise.all([
          window.term.verListInstalled(agent),
          window.term.verListRemote(agent),
          window.term.verCurrent(agent),
        ]);
        applyInstalled(installed, curVer);
        if (remoteRes.ok) {
          v.remote = remoteRes.versions;
          v.loaded = true;
          setHint("", "");
        } else {
          setHint(t("远端版本拉取失败：{0}", t(remoteRes.error ?? "未知")), "err");
        }
      } finally {
        v.refreshing = false;
      }
    } else {
      const [installed, curVer] = await Promise.all([
        window.term.verListInstalled(agent),
        window.term.verCurrent(agent),
      ]);
      applyInstalled(installed, curVer);
    }
    rerender();
  }

  function computeFiltered(): string[] {
    const q = v.search.trim().toLowerCase();
    const all = new Set<string>(v.remote);
    for (const x of v.installedSet) all.add(x);
    if (v.detectedVersion) all.add(v.detectedVersion);
    const versions = Array.from(all).sort(cmpSemver).reverse();
    // 「已安装」= 托管的 ∪ 反查到的
    const isInstalledForFilter = (x: string): boolean =>
      v.installedSet.has(x) || (!!v.detectedVersion && x === v.detectedVersion);
    return versions.filter((x) => {
      if (v.onlyInstalled && !isInstalledForFilter(x)) return false;
      if (q && !x.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function pageOfCurrent(): number {
    const target = v.activeVersion || v.detectedVersion;
    if (!target) return 0;
    const idx = computeFiltered().indexOf(target);
    if (idx < 0) return 0;
    return Math.floor(idx / PAGE_SIZE) + 1;
  }

  async function activateVersion(path: string): Promise<void> {
    const cur = getSettings();
    if (pathOf(agent) === path) return;
    const next = agent === "codex" ? { ...cur, codexPath: path } : { ...cur, claudePath: path };
    updateSettings(next);
    // updateSettings 是 300ms 去抖落盘，refresh 会立即读磁盘；显式 await 一次落盘防抢跑读旧值
    await window.term.saveSettings(next);
    await refresh(false);
    onChanged();
  }

  function deleteVersion(version: string): void {
    confirmDialog({
      title: t("卸载版本"),
      message: t("确定卸载 <b>v{0}</b>？此操作不可恢复。", version),
      okLabel: t("卸载"),
      danger: true,
      onOk: async () => {
        const res = await window.term.verUninstall(agent, version);
        if (!res.ok) {
          setHint(t("卸载失败：{0}", t(res.error ?? "未知")), "err");
          rerender();
          return;
        }
        void refresh(false);
      },
    });
  }

  function confirmInstall(version: string): void {
    if (v.installingVer) return;
    // 使用中·自定义路径的版本安装 → 语义是"备份到托管"
    const isBackup =
      !!v.detectedVersion && version === v.detectedVersion && !v.installedSet.has(version);
    confirmDialog({
      title: isBackup ? t("备份到托管") : t("安装版本"),
      message: isBackup
        ? t("你现在正用着 <b>v{0}</b>（自定义路径），把它安装到托管一份作为备份？", version)
        : t("即将从 <b>npm 镜像</b> 安装 <b>v{0}</b>。", version),
      okLabel: isBackup ? t("备份") : t("安装"),
      danger: false,
      onOk: () => void installVersion(version),
    });
  }

  async function installVersion(version: string): Promise<void> {
    if (v.installingVer) return;
    v.installingVer = version;
    v.installStartTs = Date.now();
    v.installPhase = "";
    setHint("", "");
    rerender();
    tickerRef.current = window.setInterval(() => rerender(), 700);
    let installedPath = "";
    try {
      const res = await window.term.verInstall(agent, version);
      // '已取消' 是主进程回传的协议串，保持中文比对
      if (res.ok) {
        installedPath = res.path ?? "";
      } else if (res.error !== "已取消") {
        setHint(t("安装失败：{0}", t(res.error ?? "未知")), "err");
      } else {
      }
    } finally {
      if (tickerRef.current !== null) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      v.installingVer = "";
      v.installPhase = "";
      await refresh(false);
    }
    // 还没有可用的版本时，装好的这一版直接启用
    const cur = pathOf(agent);
    if (installedPath && (!cur || !(await window.term.pathExists(cur)))) {
      await activateVersion(installedPath);
    }
  }

  async function cancelInstall(version: string): Promise<void> {
    const res = await window.term.verInstallCancel(agent, version);
    if (!res.ok) {
      setHint(t("取消失败：{0}", t(res.error ?? "未知")), "err");
      rerender();
    }
    // 成功后 install() 走 error='已取消' 分支 resolve，由 installVersion 的 finally 收尾
  }

  function formatInstallingMeta(): string {
    const secs = Math.max(0, Math.floor((Date.now() - v.installStartTs) / 1000));
    const short =
      v.installPhase && v.installPhase.length > 60
        ? v.installPhase.slice(0, 60) + "…"
        : v.installPhase;
    return t("安装中 · {0}s", secs) + (short ? " · " + short : "");
  }

  function row(version: string, idx: number) {
    const installedInfo = v.installedMap.get(version);
    const isManagedActive = version === v.activeVersion;
    // detected 且非 managed active 即 external active；托管里的同版本副本作为备份
    const isExternalActive =
      !isManagedActive && !!v.detectedVersion && version === v.detectedVersion;
    const isActive = isManagedActive || isExternalActive;
    const isInstalled = !!installedInfo;
    const isInstalling = version === v.installingVer;

    let cls = "cvrow";
    if (isActive) cls += " active";
    else if (isInstalled) cls += " installed";
    if (isInstalling) cls += " installing";

    let metaText = "";
    let metaTitle: string | undefined;
    if (isInstalling) {
      metaText = formatInstallingMeta();
    } else if (isManagedActive) {
      metaText = t("使用中");
    } else if (isExternalActive) {
      metaText = isInstalled ? t("使用中 · 自定义路径 · 已备份到托管") : t("使用中 · 自定义路径");
    } else if (isInstalled) {
      metaText = t("已安装");
      metaTitle = installedInfo!.path;
    } else {
    }

    const btn = (
      kind: "primary" | "danger",
      id: string,
      label: string,
      onClick: () => void,
      title?: string,
      disabled?: boolean
    ) => (
      <button
        type="button"
        className={"cvrow-btn " + kind}
        title={title}
        disabled={disabled}
        data-testid={`${agent}-ver-${id}-${idx}`}
        onClick={onClick}
      >
        {label}
      </button>
    );

    let actions: ReactNode = null;
    if (isInstalling) {
      actions = btn("danger", "cancel", t("取消"), () => void cancelInstall(version));
    } else if (isManagedActive) {
      // 托管使用中：禁止自删自切，无按钮
    } else if (isExternalActive && !isInstalled) {
      // 使用中但没在托管：给「安装」备份到托管
      actions = btn("primary", "install", t("安装"), () => confirmInstall(version), t("把当前版本装到托管目录一份，方便以后随时切回"), !!v.installingVer);
    } else if (isInstalled) {
      // 外部使用中时：启用 = 路径切到托管副本；卸载 = 只删托管副本
      actions = (
        <>
          {btn("primary", "use", t("启用"), () => void activateVersion(installedInfo!.path))}
          {btn(
            "danger",
            "uninstall",
            t("卸载"),
            () => deleteVersion(version),
            isExternalActive ? t("仅删除托管副本，不影响当前正在使用的自定义路径") : undefined
          )}
        </>
      );
    } else {
      actions = btn("primary", "install", t("安装"), () => confirmInstall(version), undefined, !!v.installingVer);
    }

    return (
      <div className={cls} data-ver={version} data-testid={`${agent}-ver-row-${idx}`} key={version}>
        <span className="cvrow-rail" />
        <span className="cvrow-main">
          <span className="cvrow-num">{version}</span>
          {metaText ? (
            <span className="cvrow-meta" title={metaTitle}>
              {metaText}
            </span>
          ) : null}
        </span>
        <span className="cvrow-act">{actions}</span>
      </div>
    );
  }

  const filtered = computeFiltered();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (v.page > totalPages) v.page = totalPages;
  if (v.page < 1) v.page = 1;
  const slice = filtered.slice((v.page - 1) * PAGE_SIZE, v.page * PAGE_SIZE);
  const curPage = pageOfCurrent();

  const pathCur = pathOf(agent);
  const curLabel = !v.infoLoaded ? (
    <>—</>
  ) : v.activeVersion ? (
    <>
      <span className="v">v{v.activeVersion}</span>
      <span className="src">{t("托管路径")}</span>
    </>
  ) : pathCur ? (
    v.detectedVersion ? (
      <>
        <span className="v">v{v.detectedVersion}</span>
        <span className="src">{t("自定义路径")}</span>
      </>
    ) : (
      <>
        <span className="v">{pathCur}</span>
        <span className="src">{t("未识别版本")}</span>
      </>
    )
  ) : found ? (
    <>
      <span className="v">{agent}</span>
      <span className="src">{t("走系统 PATH")}</span>
    </>
  ) : (
    <span className="src">{t("未安装")}</span>
  );

  return (
    <>
      <div className="cvcard" data-testid={`${agent}-ver-current`}>
        <div className="cvcard-l">
          <span className="cvcard-body">{curLabel}</span>
        </div>
      </div>

      {children}

      <div className="cvtool">
        <div className="cvtool-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("搜索版本号")}
            aria-label={t("搜索版本号")}
            data-testid={`${agent}-ver-search`}
            value={v.search}
            onChange={(e) => {
              v.search = e.target.value;
              v.page = 1;
              rerender();
            }}
          />
        </div>
        <label className="cvtool-filter">
          <input
            type="checkbox"
            data-testid={`${agent}-ver-only-installed`}
            checked={v.onlyInstalled}
            onChange={(e) => {
              v.onlyInstalled = e.target.checked;
              v.page = 1;
              rerender();
            }}
          />
          <span>{t("仅已安装")}</span>
        </label>
        <button
          className={"cvtool-icon" + (v.refreshing ? " spinning" : "")}
          type="button"
          title={t("重新拉取版本列表")}
          aria-label={t("刷新")}
          data-testid={`${agent}-ver-refresh`}
          disabled={v.refreshing}
          onClick={() => void refresh(true)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
            <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
          </svg>
        </button>
      </div>

      <div className="cvlist" role="listbox" data-testid={`${agent}-ver-list`}>
        {total === 0 ? (
          <div className="cvempty">{v.loaded ? t("没有匹配的版本") : null}</div>
        ) : (
          slice.map((x, i) => row(x, i))
        )}
      </div>
      <div className="cvpager" hidden={total === 0}>
        {total > 0 ? (
          <>
            <button
              type="button"
              className="cvpager-arrow"
              title={t("上一页")}
              data-testid={`${agent}-ver-prev`}
              disabled={v.page <= 1}
              onClick={() => {
                v.page--;
                rerender();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 6-6 6 6 6" />
              </svg>
            </button>
            <span
              className="cvpager-status"
              dangerouslySetInnerHTML={{
                __html: t('第 <span class="cur">{0}</span> / {1} 页', v.page, totalPages),
              }}
            />
            <span className="cvpager-spacer" />
            {/* 使用中版本不在本页时展示跳转 chip */}
            {curPage > 0 && curPage !== v.page ? (
              <button
                type="button"
                className="cvpager-jump"
                title={t("跳到第 {0} 页", curPage)}
                data-testid={`${agent}-ver-jump`}
                onClick={() => {
                  v.page = curPage;
                  rerender();
                }}
              >
                {t("当前使用版本")}
              </button>
            ) : null}
            <button
              type="button"
              className="cvpager-arrow"
              title={t("下一页")}
              data-testid={`${agent}-ver-next`}
              disabled={v.page >= totalPages}
              onClick={() => {
                v.page++;
                rerender();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </>
        ) : null}
      </div>
      <div className={"cc-ver-hint" + (v.hintKind ? " " + v.hintKind : "")} data-testid={`${agent}-ver-hint`}>
        {v.hintText}
      </div>
    </>
  );
}
