// 前台程序：标签页 shell 底下此刻在跑的程序；没有子程序时就是 shell 本身
// sh = 类 Unix 的 shell（zsh/bash 等）
export type ForegroundProgram = 'claude' | 'codex' | 'pwsh' | 'cmd' | 'sh'

export interface ForegroundInfo {
  program: ForegroundProgram
  // shell 停在提示符、底下没有任何子程序
  atPrompt: boolean
}
