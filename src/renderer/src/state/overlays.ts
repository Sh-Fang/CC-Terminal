// 浮层状态 store：ctx 菜单 / modal / confirm / pickTabs / toast / 会话选择浮层及各面板开关。
// 对外是命令式 API（openModal/confirmDialog/toast/…），内部只写 zustand 状态，
// 由 <OverlayHost/> 声明式渲染，调用方无需感知 React。
import { create } from 'zustand'

export interface CtxItem {
  label?: string
  icon?: string
  danger?: boolean
  sep?: boolean
  eyebrow?: string // 分组小标题，不可点击
  act?: () => void
  metaHtml?: string // 行尾右对齐的附加信息（HTML，如时延徽标）
}

export type ModalKind = 'new-group' | 'new-tab' | 'rename'
export interface ModalInput {
  kind: ModalKind
  title: string
  sub: string
  name: string
  cwd?: string
  showCC?: boolean
  ccChecked?: boolean
  showTabName?: boolean
  tabName?: string
  okLabel?: string
  onPickCwd?: (currentValue: string) => Promise<string | null>
  onOk: (v: { name: string; cwd?: string; autoLaunchCC?: boolean; tabName?: string }) => void
  // true 时 name 跟随 cwd 自动取路径最后一段；用户动过 name 后停止跟随
  autoNameFromCwd?: boolean
}
export type ModalOpts = ModalInput

export interface ConfirmOpts {
  title: string
  message: string // HTML 字符串（含 <b> 等），渲染侧用 dangerouslySetInnerHTML
  okLabel?: string
  cancelLabel?: string
  testIdPrefix?: string
  danger?: boolean
  onOk: () => void
  onCancel?: () => void
}

export interface UpdateProgressState {
  version: string
  percent: number
}

// 标签备注编辑弹窗：无标题无按钮的圆角便签，点外部/Esc 关闭时把最终文本交回 onSave
export interface MemoEditorOpts {
  x: number
  y: number
  text: string
  onSave: (text: string) => void
}

// 备注 hover 气泡（纯展示，不可交互）
export interface MemoTipState {
  text: string
  x: number
  y: number
}

interface CtxState {
  items: CtxItem[]
  x: number
  y: number
  onClose: (() => void) | null
  // 下拉式用法（语言/模型 picker）可指定最小宽度对齐触发按钮
  minWidth: number | null
  // 候选会随「学到」的模型无限增长的菜单可固定高度，超出内部滚动
  maxHeight: number | null
}

interface OverlaysState {
  // seq 每次 open 自增 → OverlayHost 借 key 重置内部输入态
  modal: ModalOpts | null
  modalSeq: number
  confirm: ConfirmOpts | null
  updateProgress: UpdateProgressState | null
  ctx: CtxState | null
  // toast 隐藏时保留 msg，淡出过程中文字不消失
  toastMsg: string
  toastShow: boolean
  memoEdit: MemoEditorOpts | null
  memoEditSeq: number
  memoTip: MemoTipState | null
  settingsOpen: boolean
  historyOpen: boolean
  searchOpen: boolean
}

export const useOverlays = create<OverlaysState>(() => ({
  modal: null,
  modalSeq: 0,
  confirm: null,
  updateProgress: null,
  ctx: null,
  toastMsg: '',
  toastShow: false,
  memoEdit: null,
  memoEditSeq: 0,
  memoTip: null,
  settingsOpen: false,
  historyOpen: false,
  searchOpen: false
}))

export function showCtxMenu(
  items: CtxItem[],
  x: number,
  y: number,
  onClose?: () => void,
  opts?: { minWidth?: number; maxHeight?: number }
): void {
  // 覆盖式打开：已开着时直接换内容/位置，旧 onClose 不触发
  useOverlays.setState({
    ctx: {
      items,
      x,
      y,
      onClose: onClose ?? null,
      minWidth: opts?.minWidth ?? null,
      maxHeight: opts?.maxHeight ?? null
    }
  })
}
export function closeCtxMenu(): void {
  const cur = useOverlays.getState().ctx
  if (!cur) return // 未打开不触发 onClose
  useOverlays.setState({ ctx: null })
  cur.onClose?.()
}

let toastTimer: number | null = null
export function toast(msg: string): void {
  useOverlays.setState({ toastMsg: msg, toastShow: true })
  // 连点：文字就地替换 + 计时重置
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    useOverlays.setState({ toastShow: false })
    toastTimer = null
  }, 2600)
}

export function confirmDialog(opts: ConfirmOpts): void {
  useOverlays.setState({ confirm: opts })
}
export function isConfirmOpen(): boolean {
  return useOverlays.getState().confirm !== null
}
// 先隐藏再回调：回调里可再弹下一个弹窗
export function resolveConfirm(ok: boolean): void {
  const cur = useOverlays.getState().confirm
  if (!cur) return
  useOverlays.setState({ confirm: null })
  if (ok) cur.onOk()
  else cur.onCancel?.()
}

export function showUpdateProgress(version: string): void {
  useOverlays.setState({ updateProgress: { version, percent: 0 } })
}
export function setUpdateProgress(percent: number): void {
  const next = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  useOverlays.setState((state) => state.updateProgress
    ? { updateProgress: { ...state.updateProgress, percent: next } }
    : {}
  )
}
export function closeUpdateProgress(): void {
  useOverlays.setState({ updateProgress: null })
}

export function openModal(cfg: ModalOpts): void {
  useOverlays.setState((s) => ({ modal: cfg, modalSeq: s.modalSeq + 1 }))
}
// 取消/Esc/点外部：只隐藏，不回调
export function closeModal(): void {
  useOverlays.setState({ modal: null })
}

export function openMemoEditor(opts: MemoEditorOpts): void {
  // 覆盖式打开：编辑器组件卸载时会先把旧文本交回旧 onSave，不丢输入
  useOverlays.setState((s) => ({ memoEdit: opts, memoEditSeq: s.memoEditSeq + 1, memoTip: null }))
}
export function closeMemoEditor(): void {
  useOverlays.setState({ memoEdit: null })
}

export function showMemoTip(text: string, x: number, y: number): void {
  // 编辑弹窗开着时不弹预览，避免气泡叠在编辑器上
  if (useOverlays.getState().memoEdit) return
  useOverlays.setState({ memoTip: { text, x, y } })
}
export function hideMemoTip(): void {
  useOverlays.setState({ memoTip: null })
}

export function openSettings(): void {
  useOverlays.setState({ settingsOpen: true })
}
export function closeSettings(): void {
  useOverlays.setState({ settingsOpen: false })
}

export function openHistory(): void {
  useOverlays.setState({ historyOpen: true })
}
export function closeHistory(): void {
  useOverlays.setState({ historyOpen: false })
}

export function openSearchOverlay(): void {
  useOverlays.setState({ searchOpen: true })
}
export function closeSearchOverlay(): void {
  useOverlays.setState({ searchOpen: false })
}
// 开着才关，返回是否真的关了：供 Esc 判断「这次按键已被搜索浮层消费」
export function closeSearchOverlayIfOpen(): boolean {
  if (!useOverlays.getState().searchOpen) return false
  useOverlays.setState({ searchOpen: false })
  return true
}
