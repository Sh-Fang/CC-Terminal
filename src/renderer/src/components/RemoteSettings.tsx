// 设置 → 远程访问：开关、配对二维码与地址、已配对设备、端口
import { useEffect, useState } from 'react'
import type { RemoteInfo } from '../../../shared/remote'
import { REMOTE_DEFAULT_PORT } from '../../../shared/remote'
import { confirmDialog } from '../state/overlays'
import { escapeHtml, formatTs } from '../lib/format'
import { icon } from '../svg-icons'
import { t } from '../i18n'

// 二维码多久刷新一次（配对码 5 分钟过期，提前换）
const QR_REFRESH_MS = 60 * 1000

export function RemoteSettings(props: { active: boolean }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  // 二维码用哪个地址
  const [base, setBase] = useState<string | undefined>(undefined)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = async (b = base): Promise<void> => {
    const next = await window.term.remoteInfo(b)
    setInfo(next)
    setPort(String(next.port))
  }

  // 分区可见时拉取；设备上下线、开关变化时刷新；二维码定期换新
  useEffect(() => {
    if (!props.active) {
      return
    }
    void reload()
    const off = window.term.onRemoteBrief(() => void reload())
    const timer = window.setInterval(() => void reload(), QR_REFRESH_MS)
    return () => {
      off()
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, base])

  const toggle = async (on: boolean): Promise<void> => {
    setBusy(true)
    await window.term.remoteSetEnabled(on)
    setBusy(false)
    await reload()
  }

  const commitPort = async (): Promise<void> => {
    const n = Number(port)
    if (!info || n === info.port) {
      return
    }
    await window.term.remoteSetPort(Number.isInteger(n) ? n : REMOTE_DEFAULT_PORT)
    setBase(undefined)
    await reload(undefined)
  }

  const regen = async (): Promise<void> => {
    await window.term.remoteRegen()
    await reload()
  }

  const revoke = (id: string, name: string): void => {
    confirmDialog({
      title: t('吊销设备'),
      message: t('吊销后 <b>{0}</b> 立即断开，需重新扫码配对才能再连。', escapeHtml(name || t('未知设备'))),
      okLabel: t('吊销'),
      danger: true,
      testIdPrefix: 'remote-revoke',
      onOk: () => {
        void window.term.remoteRevoke(id).then(() => reload())
      }
    })
  }

  const enabled = info?.enabled ?? false

  return (
    <>
      <div className="set-row set-row-toggle" data-testid="remote-enable-row">
        <label>{t('远程访问')}</label>
        <input
          id="set-remote-enabled"
          data-testid="remote-enabled"
          type="checkbox"
          aria-label={t('远程访问')}
          checked={enabled}
          disabled={busy || !info}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </div>

      {enabled && info && (
        <>
          {info.error && (
            <div className="remote-error" role="alert" data-testid="remote-error">
              {info.error === 'EADDRINUSE' ? t('端口 {0} 已被占用，请换一个端口', String(info.port)) : info.error}
            </div>
          )}

          {info.listening && (
            <div className="remote-pair" data-testid="remote-pair">
              <div
                className="remote-qr"
                role="img"
                aria-label={t('配对二维码')}
                data-testid="remote-qr"
                dangerouslySetInnerHTML={{ __html: info.pairSvg ?? '' }}
              />
              <div className="remote-addrs" role="radiogroup" aria-label={t('地址')} data-testid="remote-addrs">
                {info.addresses.map((a, i) => {
                  const on = info.pairUrl?.startsWith(`${a.url}/`) ?? false
                  return (
                    <button
                      key={a.url}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={'remote-addr' + (on ? ' active' : '')}
                      data-testid={`remote-addr-${i}`}
                      onClick={() => setBase(a.url)}
                    >
                      <span className="remote-addr-kind" data-testid={`remote-addr-${i}-kind`}>
                        {a.kind === 'lan' ? t('局域网') : 'Tailscale'}
                      </span>
                      <span className="remote-addr-url" data-testid={`remote-addr-${i}-url`}>{a.url}</span>
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="btn btn-secondary remote-regen"
                  data-testid="remote-regen"
                  title={t('换一个新的配对码，旧二维码作废')}
                  onClick={() => void regen()}
                >
                  <span
                    className="ic"
                    data-testid="remote-regen-ic"
                    dangerouslySetInnerHTML={{ __html: icon('rotate-cw', { size: 13 }) }}
                  />
                  {t('重新生成')}
                </button>
              </div>
            </div>
          )}

          <div className="set-subhead" data-testid="remote-devices-head">{t('已配对设备')}</div>
          <div className="remote-devices" data-testid="remote-devices">
            {info.devices.length === 0 && (
              <div className="remote-empty" data-testid="remote-devices-empty">—</div>
            )}
            {info.devices.map((d, i) => (
              <div className="remote-device" key={d.id} data-testid={`remote-device-${i}`}>
                <span className={'remote-dot' + (d.online ? ' on' : '')} data-testid={`remote-device-${i}-dot`} />
                <span className="remote-device-name" data-testid={`remote-device-${i}-name`}>
                  {d.name || t('未知设备')}
                </span>
                <span className="remote-device-seen" data-testid={`remote-device-${i}-seen`}>
                  {d.online ? t('在线') : formatTs(d.lastSeenAt)}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary remote-revoke"
                  data-testid={`remote-device-${i}-revoke`}
                  onClick={() => revoke(d.id, d.name)}
                >
                  {t('吊销')}
                </button>
              </div>
            ))}
          </div>

          <div className="set-row remote-port-row" data-testid="remote-port-row">
            <label>{t('端口')}</label>
            <input
              id="set-remote-port"
              data-testid="remote-port"
              type="number"
              min="1024"
              max="65535"
              step="1"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={() => void commitPort()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void commitPort()
                }
              }}
            />
          </div>
        </>
      )}
    </>
  )
}
