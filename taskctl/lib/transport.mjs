/**
 * 可插拔传输层。
 *
 * 为什么需要两条传输 —— 这是实测得出的硬约束，不是设计偏好：
 *
 *   `openclaw agent --agent <id>` **永远不走 ACP**。agentRuntime.id 的合法取值只有
 *   "openclaw" / "auto" / 已注册插件 harness id（如 codex）/ CLI 后端别名（如 claude-cli），
 *   没有 ACP 选项。ACP 会话只能由以下三种方式产生：
 *     1. 某个 agent 调 sessions_spawn({ runtime: "acp" })
 *     2. bindings[].type = "acp"
 *     3. /acp spawn 命令
 *
 *   因此：
 *     - "agent-cli"  → 直接 openclaw agent，跑 embedded 模型或 CLI 后端。可靠、快、少一跳。
 *     - "acp-relay"  → 先叫起 dispatcher（它有 sessions_spawn），由它 spawn 目标 ACP harness。
 *                      多一跳、多一个失败点，但能用上 DSH / Codex / Claude Code 的原生能力。
 *
 *   按角色选传输，是让"可靠"与"能用真 harness"共存的办法；出问题时可以逐个角色降级。
 *
 * 两条传输都用 --session-key 做会话隔离 —— 这一点已实测确认（probe-a / probe-b 各自独立，
 * 且不再与飞书群会话抢占）。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** openclaw 启动器的解析顺序：显式覆盖 → ~/bin（固定 node 26 的 shim）→ PATH。 */
export function resolveOpenclawBin() {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  const shim = path.join(os.homedir(), "bin", "openclaw");
  if (fs.existsSync(shim)) return shim;
  return "openclaw";
}

function runCli(args, { cwd, timeoutSec, env }) {
  const bin = resolveOpenclawBin();
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          // 保证子进程能找到 openclaw shim 依赖的 node 26
          PATH: `${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
          ...(env ?? {}),
        },
      },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          timedOut: Boolean(err && err.killed),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs: Date.now() - started,
        });
      }
    );
  });
}

/**
 * 从 `openclaw agent --json` 的信封里取出正文与用量。
 *
 * 实测信封形态（2026-10-10）：
 *   { status, summary, result: { payloads: [{ text }], meta: { agentMeta: { ... } } } }
 * 正文在 result.payloads[].text，用量在 result.meta.agentMeta.usage。
 * 解析失败时退回原始 stdout —— 宁可给出难读的原文，也不能吞掉输出。
 */
function extractText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", usage: null };
  try {
    const j = JSON.parse(trimmed);

    // 正文：优先 payloads[].text，其次若干兼容字段
    const payloads = j?.result?.payloads;
    if (Array.isArray(payloads) && payloads.length > 0) {
      const text = payloads
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) return { text, usage: extractUsage(j) };
    }
    for (const key of ["text", "reply", "message", "output"]) {
      const v = j?.[key];
      if (typeof v === "string" && v.trim()) return { text: v, usage: extractUsage(j) };
    }
    if (payloads && payloads.length === 0) {
      return { text: "", usage: extractUsage(j) };
    }
    return { text: trimmed, usage: extractUsage(j) };
  } catch {
    return { text: trimmed, usage: null };
  }
}

/** 从信封里抽取 token 与成本；取不到就返回 null，不编造。 */
function extractUsage(envelope) {
  const meta = envelope?.result?.meta?.agentMeta ?? envelope?.result?.meta ?? {};
  const usage =
    meta.usage ?? meta.lastCallUsage ?? meta.tokenUsage ?? null;
  if (!usage || typeof usage !== "object") return null;
  const pick = (...keys) => {
    for (const k of keys) if (typeof usage[k] === "number") return usage[k];
    return null;
  };
  const cost =
    typeof usage.cost === "number"
      ? usage.cost
      : typeof usage.cost?.total === "number"
        ? usage.cost.total
        : null;
  return {
    inputTokens: pick("input", "inputTokens", "promptTokens"),
    outputTokens: pick("output", "outputTokens", "completionTokens"),
    costUsd: cost,
    raw: usage,
  };
}

/** 把 prompt 落到临时文件，避免命令行长度限制与转义问题。 */
function writePromptFile(taskId, stepName, prompt) {
  const dir = path.join(os.tmpdir(), "taskctl-prompts", taskId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stepName}.md`);
  fs.writeFileSync(file, prompt);
  return file;
}

/**
 * 传输 1：直接调用 agent。跑 embedded 模型或 CLI 后端。
 */
export async function runAgentCli({ agentId, sessionKey, prompt, taskId, stepName, cwd, timeoutSec = 600 }) {
  const promptFile = writePromptFile(taskId, stepName, prompt);
  const r = await runCli(
    ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", promptFile, "--json"],
    { cwd, timeoutSec }
  );
  const ex = extractText(r.stdout);
  return {
    transport: "agent-cli",
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    output: ex.text || r.stderr.trim(),
    usage: ex.usage,
    raw: { stdoutBytes: r.stdout.length, stderr: r.stderr.slice(0, 4000) },
    durationMs: r.durationMs,
    sessionKey,
  };
}

/**
 * 传输 2：经 dispatcher 中继到 ACP harness。
 *
 * dispatcher 的提示词是**固定模板**，不是自由编排 —— 控制流在 taskctl 里，
 * 这里只借用它手里的 sessions_spawn 工具。它必须原样回传子会话的产出。
 */
export async function runAcpRelay({
  agentId,
  dispatcherAgent = DEFAULT_ACP_SPAWNER,
  sessionKey,
  prompt,
  taskId,
  stepName,
  cwd,
  timeoutSec = 900,
}) {
  const instruction = [
    "你是一个机械的中继器，不要做任何编排、总结或改写。",
    "",
    `请调用 sessions_spawn 工具，参数如下：`,
    `- runtime: "acp"`,
    `- agentId: "${agentId}"`,
    `- task: 下面 <<<TASK>>> 与 <<<END>>> 之间的完整内容`,
    "",
    "等到子会话返回后，**只输出它的原始文本**，不要加前言、不要加总结、不要加代码块标记。",
    "如果 spawn 失败，只输出一行：SPAWN_FAILED: <错误原文>",
    "",
    "<<<TASK>>>",
    prompt,
    "<<<END>>>",
  ].join("\n");

  const promptFile = writePromptFile(taskId, `${stepName}.relay`, instruction);
  const r = await runCli(
    [
      "agent",
      "--agent",
      dispatcherAgent,
      "--session-key",
      sessionKey,
      "--message-file",
      promptFile,
      "--json",
    ],
    { cwd, timeoutSec }
  );

  const ex = extractText(r.stdout);
  let output = ex.text || r.stderr.trim();
  let spawnFailed = false;
  if (/^SPAWN_FAILED:/m.test(output)) spawnFailed = true;

  return {
    transport: "acp-relay",
    exitCode: spawnFailed ? 1 : r.exitCode,
    timedOut: r.timedOut,
    output,
    usage: ex.usage,
    raw: { stdoutBytes: r.stdout.length, stderr: r.stderr.slice(0, 4000) },
    durationMs: r.durationMs,
    sessionKey,
  };
}

/**
 * 传输 3：acp-poll —— 起 ACP，然后**轮询会话库**取结果。
 *
 * 为什么不能像 runAcpRelay 那样同步等：
 *   sessions_spawn 本质是异步的（expectsCompletionMessage: true）。它立即返回
 *   { status:"accepted", childSessionKey:… }，子会话的产出要等完成后由 announce 送回。
 *   一次性 CLI 调用等不到那个后继回合 —— 实测 output 为空。
 *
 * 但结果**不需要**经 LLM 转述。会话库里有确定性的事实：
 *   session_windows.spawned_by = 发起会话的精确 session_key   ← 据此精确定位子会话
 *   session_windows.status     = done | failed | killed        ← 终态判定
 *   session_transcript_fts     = 逐条转录（role=assistant 的最后一条即产出）
 *
 * 所以流程是：唯一 key 发起 spawn → 按 spawned_by 定位子会话 → 轮询状态 → 读转录。
 * 全程不解析 LLM 的自由文本，也不依赖时间戳猜。
 */

import { execFileSync } from "node:child_process";

const TERMINAL_STATUS = new Set(["done", "failed", "killed"]);

function agentDbPath(agentId) {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  const t = (out ?? "").trim();
  return t ? JSON.parse(t) : [];
}

/** 单引号转义，防止 SQL 注入（session key 来自我们自己的模板，但仍按不可信处理）。 */
function q(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}

function findChildSession(agentId, spawnerKey) {
  const db = agentDbPath(agentId);
  if (!fs.existsSync(db)) return null;
  const rows = sqliteJson(
    db,
    `select session_id, session_key, status, created_at, updated_at, ended_at
     from session_windows where lower(spawned_by) = lower(${q(spawnerKey)})
     order by created_at desc limit 1;`
  );
  return rows[0] ?? null;
}

/** 僵尸判定参数：子会话迟迟不出现、或 status=running 却长时间无推进。 */
const CHILD_WAIT_SEC = Number(process.env.MA_CHILD_WAIT_SEC ?? 45);
const STALE_SEC = Number(process.env.MA_ZOMBIE_STALE_SEC ?? 150);

function readLastAssistantText(agentId, sessionId) {
  const db = agentDbPath(agentId);
  const rows = sqliteJson(
    db,
    `select text from session_transcript_fts
     where session_id = ${q(sessionId)} and role = 'assistant'
     order by timestamp desc limit 1;`
  );
  return rows[0]?.text ?? "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAcpPoll({
  agentId,
  dispatcherAgent = DEFAULT_ACP_SPAWNER,
  sessionKey,
  prompt,
  taskId,
  stepName,
  cwd,
  timeoutSec = 900,
  pollIntervalMs = 3000,
}) {
  // OpenClaw 会把 session key 规范化为小写；这里先转，避免大小写不一致导致定位失败
  const spawnerKey = `${sessionKey}-spawn`.toLowerCase();
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;

  // 1) 发起 spawn。这里不解析它的输出 —— 输出为空是正常的（子会话还没跑完）。
  const spawnResult = await runAcpRelay({
    agentId,
    dispatcherAgent,
    sessionKey: spawnerKey,
    prompt,
    taskId,
    stepName: `${stepName}.spawn`,
    cwd,
    timeoutSec: Math.min(300, timeoutSec),
  });

  // dispatcher 明说 spawn 失败时不再空等
  if (/^SPAWN_FAILED:/m.test(spawnResult.output)) {
    return {
      transport: "acp-poll",
      exitCode: 1,
      timedOut: false,
      output: spawnResult.output,
      usage: spawnResult.usage,
      durationMs: Date.now() - started,
      sessionKey: spawnerKey,
      raw: { spawn: spawnResult.raw, phase: "spawn-failed" },
    };
  }

  // 2) 轮询子会话。三重退出条件，避免在僵尸会话上无限等：
  //    (a) 进入终态
  //    (b) 子会话根本没出现，超过 CHILD_WAIT_SEC
  //    (c) status=running 但 updated_at 超过 STALE_SEC 没推进 —— 判定为僵尸
  // 中断（kill/重启/崩溃）会留下永远 running 的 ACP 会话；没有 (c) 的话
  // 后续每个任务都会被它们拖到 timeout。
  const spawnerSessionKey = `agent:${dispatcherAgent}:${spawnerKey}`.toLowerCase();
  let child = null;
  let lastStatus = null;
  let lastUpdatedAt = null;
  let lastProgressAt = Date.now();
  let zombieReason = null;

  while (Date.now() < deadline) {
    const found = findChildSession(agentId, spawnerSessionKey);
    if (found) {
      child = found;
      lastStatus = found.status;
      if (TERMINAL_STATUS.has(String(found.status))) break;
      if (found.updated_at !== lastUpdatedAt) {
        lastUpdatedAt = found.updated_at;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > STALE_SEC * 1000) {
        zombieReason = `子会话 ${found.session_key} 处于 running 但 ${STALE_SEC}s 无推进，判定为僵尸`;
        break;
      }
    } else if (Date.now() - started > CHILD_WAIT_SEC * 1000) {
      zombieReason = `等待 ${CHILD_WAIT_SEC}s 仍未见子会话派生 —— spawn 可能未真正发生`;
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (zombieReason) {
    return {
      transport: "acp-poll",
      exitCode: 124,
      timedOut: true,
      output: zombieReason,
      usage: spawnResult.usage,
      durationMs: Date.now() - started,
      sessionKey: spawnerKey,
      raw: { child, phase: "zombie", spawn: spawnResult.raw },
    };
  }

  if (!child) {
    return {
      transport: "acp-poll",
      exitCode: 1,
      timedOut: Date.now() >= deadline,
      output: `未找到由 ${spawnerSessionKey} 派生的子会话 —— spawn 可能未真正发生`,
      usage: spawnResult.usage,
      durationMs: Date.now() - started,
      sessionKey: spawnerKey,
      raw: { spawn: spawnResult.raw, phase: "no-child" },
    };
  }

  if (!TERMINAL_STATUS.has(String(lastStatus))) {
    return {
      transport: "acp-poll",
      exitCode: 124,
      timedOut: true,
      output: `子会话 ${child.session_key} 在 ${timeoutSec}s 内未结束（status=${lastStatus}）`,
      usage: spawnResult.usage,
      durationMs: Date.now() - started,
      sessionKey: spawnerKey,
      raw: { child, phase: "timeout" },
    };
  }

  // 3) 读产出
  const text = readLastAssistantText(agentId, child.session_id);
  const ok = String(lastStatus) === "done";

  return {
    transport: "acp-poll",
    exitCode: ok ? 0 : 1,
    timedOut: false,
    output: text || `（子会话 ${String(lastStatus)}，但转录中没有 assistant 文本）`,
    usage: spawnResult.usage,
    durationMs: Date.now() - started,
    sessionKey: spawnerKey,
    raw: {
      child: { sessionKey: child.session_key, sessionId: child.session_id, status: child.status },
      phase: "done",
    },
  };
}

/**
 * ACP spawner 必须**不是**正在被阻塞的那个 agent。
 *
 * 踩过的死锁：dispatcher 的飞书回合 exec `taskctl run`，占住了它自己的运行槽；
 * 而 code 步骤又要回调 dispatcher 去 sessions_spawn —— 同一个 agent 的槽已被占，
 * 于是排队等死（表现为任务永远停在 coding，且没有任何子会话）。
 *
 * 用 main 作为独立 spawner 即可解耦。main 的 spawn 能力已实测验证过。
 */
const DEFAULT_ACP_SPAWNER = "main";

export const TRANSPORTS = {
  "agent-cli": runAgentCli,
  "acp-relay": runAcpRelay,
  "acp-poll": runAcpPoll,
};

export async function dispatch(transport, params) {
  const fn = TRANSPORTS[transport];
  if (!fn) throw new Error(`未知传输: ${transport}（可用: ${Object.keys(TRANSPORTS).join(", ")}）`);
  return fn(params);
}
