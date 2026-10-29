// 前台程序图标：显示标签页此刻实际在跑的程序，颜色沿用状态点规则（st-* 类）
import type { TabStatus, TerminalTab } from '../terminal-tab'
import type { ForegroundProgram } from '../../../shared/foreground'
import { foregroundOf } from '../controller'
import { icon } from '../svg-icons'

const ICON_OF: Record<ForegroundProgram, Parameters<typeof icon>[0]> = {
  claude: 'claude',
  pwsh: 'square-terminal',
  cmd: 'terminal',
  sh: 'square-terminal'
}

export function FgIcon(props: { tab: TerminalTab; status: TabStatus; title: string; testId: string }) {
  const { program } = foregroundOf(props.tab)
  return (
    <span
      className={`fg-ic st-${props.status}`}
      title={props.title}
      data-fg={program}
      data-testid={props.testId}
      dangerouslySetInnerHTML={{ __html: icon(ICON_OF[program], { size: 14 }) }}
    />
  )
}
