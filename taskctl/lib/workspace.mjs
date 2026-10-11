/**
 * 工作区供应：把任务放进独立的 git worktree。
 *
 * 为什么必须做：在接入它之前，所有任务都在 `~/.openclaw/workspace-coder` 这一个目录里跑，
 * 于是——多个任务互相踩、review 会把上一个任务的残留当成这次的产出、
 * 而且 gate 是空的（`gate: skipped`），"完成"实际上没有经过任何测试验证。
 *
 * 复用既有的 orchestrator.sh，不重写它。接口（已核实，非推测）：
 *   orchestrator.sh new <task> [--repo R] [--base REF] [--layout managed|inrepo] [--agent NAME]
 *                    → **最后一行 stdout 即 worktree 绝对路径**
 *   orchestrator.sh test <task>   → 测试门控，0 通过 / 4 未过 / 3 前置缺失
 *   orchestrator.sh clean <task> [--force]
 *
 * 退出码分层（orchestrator.sh 定义）：0 OK / 2 用法 / 3 前置 / 4 门控未过 / 5 git 冲突 / 6 锁超时
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { log, taskDir } from "./store.mjs";

export const ORCHESTRATOR =
  process.env.MA_ORCHESTRATOR ||
  path.join(
    os.homedir(),
    "Workspace",
    "openclaw-multiagent",
    "orchestrator",
    "orchestrator.sh"
  );

function run(args, { cwd, timeoutSec = 600, repo = null } = {}) {
  return new Promise((resolve) => {
    execFile(
      "/bin/zsh",
      [ORCHESTRATOR, ...args],
      {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: 16 * 1024 * 1024,
        // orchestrator.sh 在解析命令**之前**就有顶层前置检查：
        //   REPO="${ORCH_REPO:-$(git rev-parse --show-toplevel)}"
        //   [[ -n "$REPO" ]] || die ...
        // 所以 --repo 参数来不及生效，必须走 ORCH_REPO 环境变量。
        env: repo ? { ...process.env, ORCH_REPO: repo } : process.env,
      },
      (err, stdout, stderr) =>
        resolve({
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        })
    );
  });
}

/** taskctl 的 id → orchestrator 的 id（后者只接受 [a-z0-9-]）。 */
export function orchId(taskId) {
  return String(taskId).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

export function orchestratorAvailable() {
  return fs.existsSync(ORCHESTRATOR);
}

/**
 * 为任务分配工作树。
 * 返回 { ok, worktree, exitCode, raw }；失败时 worktree 为 null。
 */
export async function provisionWorkspace(taskId, repo, { base = null, agent = null } = {}) {
  if (!orchestratorAvailable()) {
    return { ok: false, worktree: null, exitCode: 3, raw: `orchestrator.sh 不存在: ${ORCHESTRATOR}` };
  }
  // orchestrator 只接受 [a-z0-9-]，这里再做一层防御
  const orchTaskId = String(taskId).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  const args = ["new", orchTaskId, "--repo", repo];
  if (base) args.push("--base", base);
  if (agent) args.push("--agent", agent);

  const r = await run(args, { repo });
  // 约定：最后一行非空 stdout 是 worktree 路径
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const worktree = lines.length ? lines[lines.length - 1] : null;

  const ok = r.exitCode === 0 && Boolean(worktree) && fs.existsSync(worktree);
  if (ok) {
    // 落盘，便于事后追溯与 clean（orchestrator 侧的 id 与 taskctl 的 id 可能不同大小写）
    fs.writeFileSync(
      path.join(taskDir(taskId), "artifacts", "workspace.json"),
      `${JSON.stringify({ worktree, repo, base, agent, orchTaskId, at: new Date().toISOString() }, null, 2)}\n`
    );
    // 紧接着初始化隔离环境 —— 门控依赖它（见 initWorkspaceEnv 注释）。
    // 需要**多轮**：worktree-setup.sh 有 110s 软件截止，重活写进
    // .openclaw/env-setup.pending 就 exit 0；orchestrator 的 env 才会补跑延后项。
    // 所以循环到"环境标记出现且 pending 清空"为止。
    let env = null;
    for (let round = 1; round <= 4; round += 1) {
      env = await initWorkspaceEnv(taskId, { cwd: worktree, repo, timeoutSec: 900 });
      const marker = fs.existsSync(path.join(worktree, ".venv", "bin", "python"));
      const pending = fs.existsSync(path.join(worktree, ".openclaw", "env-setup.pending"));
      log(taskId, "workspace.envRound", { round, exitCode: env.exitCode, marker, pending });
      if (env.ok && marker && !pending) break;
      if (!env.ok) break;
    }
    if (!env.ok) {
      log(taskId, "workspace.envFailed", { exitCode: env.exitCode });
      return {
        ok: false,
        worktree,
        exitCode: env.exitCode,
        raw: `工作树已建好但环境初始化失败：\n${env.raw}`,
      };
    }
  }
  log(taskId, "workspace.provision", { ok, worktree, exitCode: r.exitCode, repo });
  return {
    ok,
    worktree: ok ? worktree : null,
    exitCode: r.exitCode,
    raw: `${r.stdout}\n${r.stderr}`.slice(-2000),
  };
}

/**
 * 在 worktree 里初始化隔离环境（Python venv / pnpm store / Maven 本地库等）。
 *
 * **这一步不能省。** 缺了它有两个后果：
 *   1. `detect_test_cmd` 认不出测试套件 —— 它要求存在 `$wt/.venv/bin/python`
 *      （或 pom.xml / package.json / Cargo.toml / go.mod），否则门控直接 exit 3。
 *   2. 依赖不隔离，多个任务会共用全局环境、互相污染。
 *
 * orchestrator 的 `env` 走 `.openclaw/worktree-setup.sh`：该钩子有 120s 硬超时，
 * 重活会写进 `.openclaw/env-setup.pending` 延后执行并 **exit 0**，所以这里放宽到 15 分钟。
 */
export async function initWorkspaceEnv(taskId, { cwd = null, repo = null, timeoutSec = 900 } = {}) {
  const r = await run(["env", orchId(taskId)], { cwd, timeoutSec, repo });
  log(taskId, "workspace.initEnv", { exitCode: r.exitCode });
  return {
    ok: r.exitCode === 0,
    exitCode: r.exitCode,
    raw: `${r.stdout}\n${r.stderr}`.slice(-3000),
  };
}

/** 测试门控。返回退出码，由引擎据 orchestrator 的分层退出码判定。 */
export async function runTestGate(taskId, { cwd, timeoutSec = 1800, repo = null } = {}) {
  const r = await run(["test", orchId(taskId)], { cwd, timeoutSec, repo });
  log(taskId, "workspace.testGate", { exitCode: r.exitCode });
  return { exitCode: r.exitCode, raw: `${r.stdout}\n${r.stderr}`.slice(-4000) };
}

/** 清理工作树。默认保留，仅在显式要求时调用。 */
export async function cleanupWorkspace(taskId, { force = false, repo = null } = {}) {
  const args = ["clean", orchId(taskId)];
  if (force) args.push("--force");
  const r = await run(args, { repo });
  return { exitCode: r.exitCode, raw: `${r.stdout}\n${r.stderr}`.slice(-2000) };
}

export function readWorkspace(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir(taskId), "artifacts", "workspace.json"), "utf8"));
  } catch {
    return null;
  }
}
