// 应用标志：与 resources/icon.png 同款（左上橙、右下黑对角切分 + 「>」与星号）
import { useId } from 'react'

export function BrandLogo(props: { size: number }) {
  const cid = useId()
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id={cid}>
          <rect x="1" y="1" width="22" height="22" rx="6.5" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${cid})`}>
        <rect x="1" y="1" width="22" height="22" fill="#000" />
        <polygon points="1 1 23 1 1 23" fill="#D26743" />
      </g>
      <polyline
        points="5 5 10.2 7.6 5 10.2"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
        <line x1="16.6" y1="13.6" x2="16.6" y2="19.6" />
        <line x1="14" y1="15.1" x2="19.2" y2="18.1" />
        <line x1="14" y1="18.1" x2="19.2" y2="15.1" />
      </g>
    </svg>
  )
}
