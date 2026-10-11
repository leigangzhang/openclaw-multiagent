# 待办

记录时间：2026-10-11

## 1. 审批门未自研

**现状**：破坏性操作（推送、合并、发布）目前只靠 `dispatcher` 的 `AGENTS.md` 约束
（"先向用户确认"），是**提示词级别的约定，不是机制**。

**为什么不直接用 Lobster**：`@openclaw/lobster` 要求 plugin API ≥2026.10.1，
当前 OpenClaw runtime 是 2026.9.9，装不上。

```
$ openclaw plugins install @openclaw/lobster
Plugin "@openclaw/lobster" requires plugin API >=2026.10.1,
but this OpenClaw runtime exposes 2026.9.9.
```

**方向**：`taskctl` 的状态机里已留 `needs_approval` 状态与 `resume` 能力，
自研一个审批门即可复用。形态建议：

- `engine` 在破坏性步骤前转到 `needs_approval`，写 `verdict.pendingApproval`
- runner 检测到该状态后，用 `openclaw message send` 把审批请求发到来源渠道
- 用户回复批准 → `taskctl resume <id> --approve` 继续；超时未批则 `failed`

**触发点**：`orchestrator.sh merge --push`、任何 `git push`、发布类操作。

**优先级**：中。当前用途（本机、单用户）风险可控，但一旦接入自动合并就必须补。

---

## 2. Subagent terminal signal owner changed 偶发

**现象**：

```
[sessions/state-events] failed to record session state event:
  Error: Subagent terminal signal owner changed before commit
```

**根因**（读 `dist/package-update-activation-recovery.mjs` 得到）：
这是一段 CAS 守卫 —— 子会话终态落库时发现已被更新的一代接管，写入被拒，
紧接着该 run 被 `retireSupersededSession()` 当作 superseded 退休。

```js
await recordSubagentTerminalState(signal, () => {
  if (!isCurrentSessionEffectsOwner() || !hasCurrentTerminalOutcome())
    throw new Error("Subagent terminal signal owner changed before commit");
});
```

**性质**：上游内部竞态（settle-wake 后继回合与子会话收尾相撞）。我们**无法修上游**。

**已做的缓解**：
- `agents.defaults.subagents.maxConcurrent` 8 → 2
- 每步用独立 `--session-key`，不共享会话
- 不在 agent 的 exec 里嵌套调用 `openclaw agent`（改为独立 runner）

**未做**：需要时应向上游报告，附 `retireSupersededSession` 的触发路径与复现条件。

**优先级**：低。当前只造成状态记录缺失，未见功能受损。

---

## 3. polyglot 仓库只跑一套测试（P3 实测发现）

**现象**：`orchestrator.sh` 的 `detect_test_cmd` 按
Java → Node → Python → Rust → Go 的顺序**返回第一条命中**，
所以 polyglot 仓库（同时有 `package.json` 与 `pyproject.toml`）里，
门控只跑 `pnpm test`，**Python 测试永远不会被执行**。

实测（`~/Workspace/openclaw-multiagent-demo/_scenarios/polyglot`）：
```
门控命令: pnpm test          ← Node 胜
worktree 含 .venv            ← 环境两套都装了，但只有一套进闸门
```

**风险**：改动 `pylib.py` 导致 Python 测试失败时，门控仍会放行。

**方向**：`detect_test_cmd` 改为返回**命令数组**，门控全部执行、
任一失败即拒。`orchestrator.sh` 的 gate 文件结构需相应扩展。

---

## 4. 其他小项

- `deepseek-flash` 的图像理解能力已按官方文档声明（`input: ["text","image"]`），但**未实测**
- 僵尸会话回收（`make reap`）未接入定时任务，需人工 `--force`
- `orchestrator.sh merge` 的双模式合并未接入飞书（`/merge` 群命令未做）
