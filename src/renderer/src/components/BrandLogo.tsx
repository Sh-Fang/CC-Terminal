// 应用标志：与 resources/icon.png 同款（橙→黑渐变底 + 「>」与星号）
import { useId } from 'react'

export function BrandLogo(props: { size: number }) {
  const gid = useId()
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.15" stopColor="#D06842" />
          <stop offset="0.85" stopColor="#1A1A1A" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill={`url(#${gid})`} />
      <polyline
        points="7.5 7.5 12 11.75 7.5 16"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
        <line x1="15.75" y1="13.3" x2="15.75" y2="17.2" />
        <line x1="14.06" y1="14.28" x2="17.44" y2="16.22" />
        <line x1="14.06" y1="16.22" x2="17.44" y2="14.28" />
      </g>
    </svg>
  )
}
