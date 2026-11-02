// 资源占用：CPU 为占整机的百分比（0~100），内存为字节数
export interface Usage {
  cpu: number
  mem: number
}

export interface UsageSample {
  // 应用自身：应用的全部进程，不含各标签页 shell 及其下的程序
  app: Usage
  // 按 PTY id：shell 连同下面整棵进程树
  ptys: Record<number, Usage>
}
