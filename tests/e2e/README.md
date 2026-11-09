用 Playwright 的 `_electron` 启动 `out/` 下的构建产物，按 DOM 和文件状态断言。只在本机跑，不接 CI。

# 运行

```bash
npm run test:e2e                         # 先 electron-vite build，再跑全部用例
npx playwright test suspend-resume       # 已经 build 过时，只跑某个文件
npx playwright test -g "Ctrl+P"          # 按用例名筛选
CC_E2E_DEBUG_PROCS=1 npx playwright test # 退出时打印记录到的子进程
```

一整套大约 3～4 分钟。失败用例的截图上下文在 `test-results/e2e/`，它的 userData 保留在 run 目录下。

# 前提

- 本机已装 `claude` 并已登录。智能体用例会起真 claude：每轮用 `claude -p --model haiku` 造 2 个一句话的会话，其余只恢复会话、不发消息。
- Windows。路径用例只按 Windows 写，其他平台跳过。

# 隔离

- 每轮在 `D:/temp/cc-terminal-e2e/run-<时间>/` 下建目录（`CC_E2E_ROOT` 可改根目录），每次启动应用都用其中一个全新的 `ud-*` 作 userData，经 `TERMINAL_ISOLATE_DIR` 传入。窗口透明，不抢焦点，单实例锁随 userData 隔离，不影响正在用的 CC Terminal。
- 智能体工作目录是本轮的 `work-<随机>`。新目录第一次起 claude 会问是否信任该目录，`waitClaudeReady` 用按键选「信任」。所以 claude 会在 `~/.claude.json` 里记下这个目录，`~/.claude/projects/` 下也会留下这几个会话的对话记录。
- 继承来的 `CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_EFFORT`、`CLAUDE_CODE_*` 环境变量会被去掉。
- 退出走「关闭确认框点了关闭」之后的同一条路径。运行期间持续记录应用派生的进程，退出后 8 秒还在的按 PID 结束，记在用例的 `orphan` 注解和 `orphans.txt` 里。不会按进程名结束任何进程。
- 本轮结束后删掉工作目录；没有失败用例时整个 run 目录一起删。

# 新功能怎么加用例

1. 选个已有的 `*.spec.ts` 加 `test(...)`，或者新建一个文件。从 `./helpers/app` 引入 `test` / `expect`，用 `launch` fixture 启动；用例结束时 fixture 负责退出、清理，并检查 console error 和 pageerror。
2. 测试数据在启动前用 `buildStore`（`helpers/store-fixture.ts`）预置：分组、标签页（`kind: 'claude'` 是智能体标签页）、会话栈、已关闭标签页（`closedAt`）。设置用 `launch({ settings })`，状态文件用 `stateFiles` 或 `writeStateFile`。
3. 选择器和常用操作集中在 `helpers/ui.ts`（标签页行、图标、右键菜单、确认框、终端屏幕文字）。界面结构变了只改这里。
4. 等待一律用 `expect(...)` 或 `expect.poll(...)`。只有「过一会儿仍然不变」这类否定断言才用短暂的 `waitForTimeout`。
5. 需要真会话时用 `realSessions(n)`（`helpers/claude.ts`），等 claude 就绪用 `waitClaudeReady`。不要让 claude 跑回合；要验证能输入，只往输入框敲字、不回车。
6. 路径写进 JS 字符串时注意反斜杠：用 `path.resolve` / `path.join` 拼，或者写成 `'D:\\temp'`。`'D:\temp'` 里的 `\t` 是制表符。
