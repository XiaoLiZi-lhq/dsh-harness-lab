# dsh-harness-lab

个人对开源 Agent 运行时 **DeepSeek Harness（DSH）** 的定制实验仓：一个可运行的插件 + 一组对 harness 本体的核心改动补丁。目的不是 fork 上游，而是把「在运行时层做定制」这件事的证据（代码、commit、验证口径）固化到一处。

```
├── plugin/dsh-task-timeline/   # 会话任务时间线插件 v0.1.1（完整源码，活体运行中）
└── harness-core/               # 对 deepseek-harness 本体的 commit 存证（format-patch 补丁 + 元数据）
```

## 1. 解决什么问题

DSH 把每个会话完整落盘为 zstd 压缩的 JSONL 日志（`~/.dsh/sessions/*/<sessionId>/session.jsonl.zstd`），但**只落盘、不可视、更不可回退**：

- 想知道「这个跑了很久的会话，任务清单在第 3 轮是什么状态」，只能手动解压日志逐行翻；
- 想回到某个历史回合换个思路重试，只能整段对话重来。

**dsh-task-timeline** 插件把日志里的每次 `todo_write` 快照重放成侧边栏时间线：当前任务 + 按回合排列的历史快照，每个快照可一键分叉出新会话（task-level rewind——对话回退，磁盘文件不回滚）。

## 2. 插件-宿主架构

DSH 插件分**两半**，本插件各占一半：

**宿主半体** [`plugin/dsh-task-timeline/lib/index.js`](plugin/dsh-task-timeline/lib/index.js)（Node 侧，208 行）

- 通过 cordis 的 `ctx.webServer.register({ kind: 'prefix', path: '/task-timeline/api' })` 注册宿主 HTTP 路由；
- `POST /task-timeline/api/history {sessionId}`：`spawn` zstdcat **流式**解压 `session.jsonl.zstd`，逐行喂给解析器——不做全文缓冲、不做二次解析；20 秒超时；**截断/损坏的日志一律 5xx 拒绝（`replay-failed`），绝不把半截数据当成完整结果返回**；
- 重放 `turn/start`、`user/message`、`tool/call(todo_write)` 三类事件，产出 `[{seq, time, turn, prompt, todos}]` 快照序列；当前任务清单 = 日志中最后一次 `todo_write`（该工具每次整表替换，无需实时投影通道）；
- 同源围栏（DNS-rebinding 防护）：`Origin == Host` 且 origin hostname 必须是回环字面量（localhost / 127.0.0.1 / ::1），否则 403。

**客户端半体** [`plugin/dsh-task-timeline/lib/client.js`](plugin/dsh-task-timeline/lib/client.js)（浏览器侧，184 行）

- 以 DSH web shell 的专有模块格式 `window.__ModuleLoader__.load({...})` 注入；
- 在 `dsh-better-sidebar` 服务上注册「任务时间线」标签页（`inject: [betterSidebar, sessions]`）；
- 快照卡片一键 `sessions.fork({ sessionId, atSeq })` 回退分叉；所有数据带 sessionId 标签，过期轮询结果/会话切换不会把别的会话数据画到当前会话下。

**挂载方式**：web profile（`~/.dsh/profiles/web/package.json`）以 `"dsh-task-timeline": "link:<本插件目录>"` 依赖挂载（见第 4 节验证）。

## 3. harness 核心改动点

时间线插件的「回退」能力依赖 fork 语义，为此改了 harness 本体一处（2026-08-30，详见 [`harness-core/README.md`](harness-core/README.md)）：

| 改动 | 位置 | 效果 |
|---|---|---|
| fork 命令新增 **exclusive 锚定模式** | `packages/api/session-controller/src/commands.ts` | cut BEFORE the anchoring turn（`findLast(turn/end && seq < atSeq)`），实现「编辑重发」式分叉 |
| **放开历史回合分叉** | `packages/client/ui-chat/.../TurnTailNodeView.tsx` | 任意已完成回合可分叉，不再限最新回合 |
| **分叉后输入回填** | `packages/client/ui-chat/.../UserMessageNodeView.tsx` | 分叉按钮 = exclusive fork + composer 草稿预填 |

- commit：`f8a671df3575a6e3a464442e3c57c6d440b91588`（9 文件，+47/−15）
- 补丁存证：[`harness-core/patches/0001-feat-chat-task-rewind-unlock-historical-turn-branchi.patch`](harness-core/patches/0001-feat-chat-task-rewind-unlock-historical-turn-branchi.patch)
- [待补 commit 链接]：原 commit 在本地 `~/deepseek-harness`（基线上游 `cd5ef81481`），未推送个人 fork；推送后替换为 GitHub URL

## 4. 怎么验证的（按取证口径，不外推）

- **活体运行**：插件当前正以 `link:` 依赖挂载在 DSH web profile 上（`~/.dsh/profiles/web/package.json`），标签页在 web shell 可用；`~/.dsh/sessions/` 下有多个真实 `session.jsonl.zstd` 数据源，重放路径有真实数据可走；
- **代码证据**：补丁由 `git format-patch` 从本地完整 checkout 原样导出，`git show --stat` 可复核（9 文件 +47/−15，与上表一致）；
- **边界（如实声明）**：「构建通过」为 2026-08 当时口径，本轮整理未重跑上游构建；本仓库只收录能在本机取证复核的改动与验证结论，旧笔记中未能取证的条目一律不进入。

## 5. 与 LangChain 类框架的差异（200 字内）

LangChain/LlamaIndex 是**编排库**：把工具、记忆、检索组装进应用，运行时由你的代码驱动。这里的定制在**运行时层**：DSH 本身就是进程——插件经 cordis 注入宿主（HTTP 路由、标签页），核心改动直接改会话 fork 语义后随官方 shell 编译分发。前者改「应用如何编排模型」，后者改「工具进程自身的行为与工作流」。

## 插件版本口径（诚实边界）

本仓库以 **v0.1.1 快照**形式收录插件源码。源目录未初始化 git，`v0.1.0 → v0.1.1` 的早期演进历史未保留（文件 mtime 侧证 2026-08-30 当日有两轮迭代），不做虚构的版本故事；本仓库的 git 历史自收录之日起算。

## 上手

```bash
# 插件以 link 方式挂到 DSH web profile（本机路径示例）
cd ~/.dsh/profiles/web
# package.json: "dependencies": { "dsh-task-timeline": "link:/path/to/dsh-harness-lab/plugin/dsh-task-timeline" }
pnpm install && pnpm run dev:web   # 打开 web shell → 侧边栏「任务时间线」

# 核心改动补丁（在上游 deepseek-harness checkout 中）
git am harness-core/patches/0001-*.patch
```

## License

MIT（见 [LICENSE](LICENSE)）。补丁是对上游开源仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的增量 diff。
