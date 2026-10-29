import { useAppStore } from '../state/store'
import { toast } from '../state/overlays'
import { getSessionInfoCtx } from '../controller'
import { t } from '../i18n'

export function SessionInfoBar() {
  const rev = useAppStore((s) => s.rev)
  void rev

  // 底部路径：跟随当前激活分组的 cwd（rev 驱动）
  const cwd = getSessionInfoCtx()?.cwd ?? ''

  return (
    <div className="statusbar" data-testid="statusbar">
      {/* 双击底部路径用资源管理器打开该目录 */}
      <span
        id="sbCwd"
        data-testid="statusbar-cwd"
        title={cwd ? `${cwd}\n${t('双击用资源管理器打开')}` : ''}
        onDoubleClick={() => {
          const p = cwd.trim()
          if (!p) {
            return
          }
          void window.term.openPath(p).then((r) => {
            if (!r.ok) {
              toast(t('打开失败：{0}', r.error ?? t('未知错误')))
            }
          })
        }}
      >
        {cwd}
      </span>
    </div>
  )
}
