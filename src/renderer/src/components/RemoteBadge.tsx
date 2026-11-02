// 状态栏：远程访问开着时显示手机图标和在线设备数，点击跳到设置里的远程访问分区
import { useEffect, useState } from 'react'
import type { RemoteBrief } from '../../../shared/remote'
import { openSettings } from '../state/overlays'
import { icon } from '../svg-icons'
import { t } from '../i18n'

export function RemoteBadge() {
  const [brief, setBrief] = useState<RemoteBrief>({ enabled: false, online: 0 })

  useEffect(() => {
    void window.term.remoteBrief().then(setBrief)
    return window.term.onRemoteBrief(setBrief)
  }, [])

  if (!brief.enabled) {
    return null
  }
  const label = t('远程访问：{0} 台设备在线', String(brief.online))
  return (
    <button
      type="button"
      className={'remote-badge' + (brief.online > 0 ? ' on' : '')}
      aria-label={label}
      title={label}
      data-testid="remote-badge"
      onClick={() => openSettings('remote')}
    >
      <span
        className="res-ic"
        data-testid="remote-badge-ic"
        dangerouslySetInnerHTML={{ __html: icon('smartphone', { size: 12 }) }}
      />
      <span data-testid="remote-badge-count">{brief.online}</span>
    </button>
  )
}
