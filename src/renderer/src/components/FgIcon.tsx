// 前台程序图标：显示标签页此刻实际在跑的程序，颜色沿用状态点规则（st-* 类）
import type { TabStatus, TerminalTab } from '../terminal-tab'
import type { ForegroundProgram } from '../../../shared/foreground'
import { foregroundOf, suspendedAgentOf } from '../controller'
import { icon } from '../svg-icons'

const ICON_OF: Record<ForegroundProgram, Parameters<typeof icon>[0]> = {
  claude: 'claude',
  codex: 'codex',
  pwsh: 'square-terminal',
  cmd: 'terminal',
  sh: 'square-terminal'
}

export function FgIcon(props: { tab: TerminalTab; status: TabStatus; title: string; testId: string }) {
  // 挂起的标签页显示要恢复的智能体，淡化，不带状态色
  const suspended = suspendedAgentOf(props.tab)
  const program = suspended ?? foregroundOf(props.tab).program
  return (
    <span
      className={suspended ? 'fg-ic fg-suspended' : `fg-ic st-${props.status}`}
      title={props.title}
      data-fg={program}
      data-testid={props.testId}
      dangerouslySetInnerHTML={{ __html: icon(ICON_OF[program], { size: 14 }) }}
    />
  )
}
