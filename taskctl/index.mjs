#!/usr/bin/env node
/**
 * taskctl —— OpenClaw 多 Agent 协作的任务编排器。
 *
 * 稳定接口（计划 §5.2）：
 *   submit   建任务（每次新建，不合并同请求）
 *   step     执行单个角色步骤（幂等，已完成即跳过）
 *   gate     跑硬门控，退出码即证据
 *   run      跑完整管线（确定性控制流）
 *   status   当前状态（--json 供程序消费）
 *   list     任务列表
 *   report   生成给人看的汇总
 *   resume   从断点继续
 *   cancel   取消
 *
 * 退出码：0 成功 / 1 失败 / 2 用法错误 / 3 任务处于终态（不可继续）
 */

import fs from "node:fs";
import process from "node:process";
import {
  STATE_ROOT,
  createTask,
  listTasks,
  readStatus,
  transition,
  log,
  isTerminal,
} from "./lib/store.mjs";
import { runPipeline, runStep, runGate } from "./lib/engine.mjs";
import { buildReport, buildStatusJson } from "./lib/report.mjs";

const USAGE = `taskctl —— 多 Agent 协作任务编排器

用法：
  taskctl submit --message <文本> [--repo <路径>] [--requester <名>] [--peer <id>]
                 [--channel <渠道>] [--gate-cmd <命令>] [--workdir <路径>]
                 [--skip-plan] [--require-evidence]
                 [--merge-mode none|ai|human] [--merge-push] [--keep-worktree]
                 [--max-steps N] [--max-wall-clock S] [--max-cost USD] [--max-fix N]
  taskctl run    <taskId> [--gate-cmd <命令>] [--workdir <路径>] [--skip-plan]
                          [--require-evidence]
  taskctl step   <taskId> <plan|code|review> [--workdir <路径>] [--force]
  taskctl gate   <taskId> [--gate-cmd <命令>] [--workdir <路径>]
  taskctl status <taskId> [--json]
  taskctl report <taskId>
  taskctl list   [--json] [--active]
  taskctl resume <taskId> [--gate-cmd <命令>] [--workdir <路径>]
  taskctl cancel <taskId> [--reason <文本>]

状态根：${STATE_ROOT}
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function requireTask(args, positional) {
  const id = positional[0];
  if (!id) die("缺少 taskId");
  try {
    return readStatus(id);
  } catch {
    die(`任务不存在: ${id}`, 3);
  }
  return null;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift();

  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (cmd) {
    case "submit": {
      let rawText = flags.message;
      if (flags["message-file"]) {
        rawText = fs.readFileSync(flags["message-file"], "utf8");
      }
      if (!rawText) die("submit 需要 --message 或 --message-file");
      const limits = {};
      if (flags["max-steps"]) limits.maxSteps = Number(flags["max-steps"]);
      if (flags["max-wall-clock"]) limits.maxWallClockSec = Number(flags["max-wall-clock"]);
      if (flags["max-cost"]) limits.maxCostUsd = Number(flags["max-cost"]);
      if (flags["max-fix"]) limits.maxFixRounds = Number(flags["max-fix"]);

      const { taskId } = createTask({
        rawText,
        requester: flags.requester ?? null,
        channel: flags.channel ?? null,
        peerId: flags.peer ?? null,
        repo: flags.repo ?? null,
        limits,
        runOptions: {
          gateCmd: flags["gate-cmd"] ?? null,
          // 工作目录必须有确定值 —— 之前留空导致 plan 角色自己猜成了 workspace-reviewer，
          // 进而让 review 报出"文件不在目标位置"的伪严重问题。默认落到 MA_DEFAULT_WORKDIR
          // 或 coders 的工作区（DSH 实际就在那里执行）。
          // 有 --repo 时不预设 workdir：由 provisioning 分配 worktree 后填入，
          // 避免 submit 的默认值把 worktree 盖掉（踩过一次）。
          workdir:
            flags.workdir ??
            (flags.repo
              ? null
              : process.env.MA_DEFAULT_WORKDIR ??
                `${process.env.HOME}/.openclaw/workspace-coder`),
          skipPlan: Boolean(flags["skip-plan"]),
          requireEvidence: Boolean(flags["require-evidence"]),
          mergeMode: flags["merge-mode"] ?? "none",
          mergePush: Boolean(flags["merge-push"]),
          keepWorktree: Boolean(flags["keep-worktree"]),
        },
      });
      if (flags.json) process.stdout.write(`${JSON.stringify({ taskId })}\n`);
      else process.stdout.write(`${taskId}\n`);
      return 0;
    }

    case "run":
    case "resume": {
      const st = requireTask(cmd, positional);
      if (isTerminal(st)) {
        process.stderr.write(`任务已处于终态 ${st.phase}，不继续\n`);
        return 3;
      }
      const r = await runPipeline(st.taskId, {
        gateCmd: flags["gate-cmd"] ?? null,
        workdir: flags["workdir"] ?? null,
        skipPlan: Boolean(flags["skip-plan"]),
        requireEvidence: Boolean(flags["require-evidence"]),
      });
      process.stdout.write(`${buildReport(st.taskId)}\n`);
      return r.phase === "done" ? 0 : 1;
    }

    case "step": {
      const st = requireTask(cmd, positional);
      const role = positional[1];
      if (!role) die("step 需要角色名：plan | code | review");
      const r = await runStep(st.taskId, role, {
        workdir: flags.workdir ?? null,
        force: Boolean(flags.force),
      });
      process.stdout.write(`${r.output ?? ""}\n`);
      return r.exitCode === 0 ? 0 : 1;
    }

    case "gate": {
      const st = requireTask(cmd, positional);
      const v = await runGate(st.taskId, {
        gateCmd: flags["gate-cmd"] ?? null,
        cwd: flags.workdir ?? null,
      });
      process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
      return v.gate.skipped ? 3 : v.gate.passed ? 0 : 1;
    }

    case "status": {
      const st = requireTask(cmd, positional);
      if (flags.json) process.stdout.write(`${JSON.stringify(buildStatusJson(st.taskId), null, 2)}\n`);
      else process.stdout.write(`${buildReport(st.taskId)}\n`);
      return 0;
    }

    case "report": {
      const st = requireTask(cmd, positional);
      process.stdout.write(`${buildReport(st.taskId)}\n`);
      return 0;
    }

    case "list": {
      let all = listTasks();
      if (flags.active) all = all.filter((s) => !isTerminal(s));
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
      } else if (all.length === 0) {
        process.stdout.write("（无任务）\n");
      } else {
        for (const s of all) {
          process.stdout.write(
            `${s.taskId}  ${String(s.phase).padEnd(9)} steps=${String(s.stepIndex).padEnd(3)} $${s.costUsd.toFixed(4)}\n`
          );
        }
      }
      return 0;
    }

    case "cancel": {
      const st = requireTask(cmd, positional);
      log(st.taskId, "task.cancelled", { reason: flags.reason ?? null });
      transition(st.taskId, "cancelled", { error: flags.reason ?? "用户取消" });
      process.stdout.write(`已取消 ${st.taskId}\n`);
      return 0;
    }

    default:
      die(`未知命令: ${cmd}\n\n${USAGE}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`taskctl 异常: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
);
