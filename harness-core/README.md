# harness-core：对 DeepSeek Harness 本体的改动存证

本目录固化我在 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，开源 Agent 运行时）本地 checkout 中做过的一处核心功能 commit。原仓库 origin 指向上游官方、改动未推送，因此以 `git format-patch` 导出的补丁作为可长期保存、可独立复现的证据。

## Commit 元数据

| 项 | 值 |
|---|---|
| commit | `f8a671df3575a6e3a464442e3c57c6d440b91588` |
| Author | 李鸿钦 <13626820+lihongqin@user.noreply.gitee.com> |
| AuthorDate | 2026-08-30 13:01:00 +0800 |
| parent（上游基线） | `cd5ef8148158c3a752a658978873241fdf8e2bbc`（Merge PR #3248, dsh-0.1.2-alpha.1 线） |
| 改动规模 | 9 文件，+47 / −15 |
| 涉及包 | `packages/api/session-controller`、`packages/client/connection`、`packages/client/ui-chat` |

## Commit message（原文）

```
feat(chat): task rewind — unlock historical turn branching, edit-and-resend fork with composer prefill

- fork command gains exclusive anchor (cut BEFORE the anchoring turn) for edit-and-resend
- TurnTailNodeView: allow branching from any completed turn, not just the latest
- UserMessageNodeView: branch button = exclusive fork + composer draft prefill
- task-timeline sidebar plugin mounted separately via profile
```

## 改动解读（三件事）

1. **fork 命令新增 exclusive 锚定模式**：在 `commands.ts` 中用 `findLast(turn/end && seq < atSeq)` 找到锚定回合之前的位置，cut BEFORE the anchoring turn，实现「编辑重发」式分叉——保留锚定回合之前的对话，丢弃其后内容；
2. **放开历史回合分叉**：`TurnTailNodeView` 允许从任意已完成回合分叉，不再限于最新回合；
3. **分叉后输入回填**：`UserMessageNodeView` 的分叉按钮 = exclusive fork + composer 草稿预填，分叉后原输入已回填在输入框，改两个词即可重发。

客户端契约（`sessions.ts`、`service.ts`、`fixture.ts`）随实现同步更新。

## 补丁文件

- [`patches/0001-feat-chat-task-rewind-unlock-historical-turn-branchi.patch`](patches/0001-feat-chat-task-rewind-unlock-historical-turn-branchi.patch) —— `git format-patch -1 f8a671df35` 原样导出。
- 复现方法（在上游 checkout 中）：`git am patches/0001-*.patch`。
- [待补 commit 链接]：该 commit 目前只存在于本机 `~/deepseek-harness`（未推送个人 fork）；若日后推送到本人 fork，此处替换为 GitHub commit URL。

## 归属说明（诚实边界）

- commit 作者邮箱为 `13626820+lihongqin@user.noreply.gitee.com`（Gitee noreply）。GitHub 不会把该邮箱的 commit 归属到 XiaoLiZi-lhq 账号（无头像、无贡献图）。修复方式二选一：把该邮箱加入 GitHub 账号邮箱列表（零改动），或后续重写作者信息。
- 「构建通过」为 2026-08 当时口径；本轮整理仓库时未重跑上游构建验证。
- 本目录只收录可在本机取证复核的改动（补丁 + git 元数据）；旧笔记中无法取证的条目一律不进入。
- 补丁内容是对上游开源仓库的增量 diff，随本仓库 MIT 许可发布；如上游许可证条款有更严格要求，以退化为仅保留元数据为准。
