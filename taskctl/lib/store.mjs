/**
 * 任务库：唯一事实源。
 *
 * 设计原则（对应计划里的成功标准）：
 *   S1 每次 submit 都新建任务，绝不合并同请求 —— 杜绝"凭记忆判断做过"
 *   S2 状态全部落盘，resume 跳过已完成步骤
 *   S4 目录结构即运维视图，taskctl status 可还原全过程
 *
 * 状态根默认在 XDG 位置，位于产品仓库之外 —— 运行时数据不污染代码库。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const STATE_ROOT =
  process.env.MA_STATE_ROOT ||
  path.join(os.homedir(), ".local", "state", "openclaw-multiagent");

export const TASKS_DIR = path.join(STATE_ROOT, "tasks");

/** 状态机。终态不可再迁移。 */
export const PHASES = [
  "created",
  "provisioning",
  "planning",
  "coding",
  "testing",
  "reviewing",
  "fixing",
  "gating",
  "merging",
  "done",
];
export const TERMINAL = ["done", "failed", "needs_approval", "cancelled"];

/**
 * 熔断上限。
 *
 * 为什么用 token 而不是美元：DeepSeek 的 usage 里 `cost.total` 返回 0，
 * 按价格自算又要求"价格必须来自官方文档、不能凭记忆写"。而 token 是每次调用
 * 都真实返回的，供应商无关、无需维护价格表。
 * USD 上限保留为可选：只有配了 pricing.json 才会真正生效。
 */
export const DEFAULT_LIMITS = {
  maxSteps: 12,
  maxWallClockSec: 1800,
  maxTokens: 2_000_000,
  maxCostUsd: 5,
  maxFixRounds: 2,
};

/**
 * 分层超时链 —— 必须严格单调递减，否则外层会先杀掉内层。
 *
 * 之前的问题：单步 900、门控 1800 都是硬编码，而任务总墙钟也是 1800 ——
 * 门控可能跑过任务自身的墙钟，而 checkLimits 只在阶段之间检查，中途拦不住。
 *
 * 现在全部从 maxWallClockSec 推导：
 *   task   = maxWallClockSec
 *   gate   = 0.80 × task
 *   step   = 0.50 × task（上限 900，避免大墙钟下单个 agent 调用过久无反馈）
 *   spawn  = min(300, step)
 *   探测阈值（childWait / zombieStale）固定在 spawn 之内
 */
export function deriveTimeouts(limits) {
  const wall = Number(limits?.maxWallClockSec ?? DEFAULT_LIMITS.maxWallClockSec);
  const gate = Math.max(30, Math.floor(wall * 0.8));
  const step = Math.min(900, Math.max(30, Math.floor(wall * 0.5)));
  // 必须**严格**小于 step（边界：step=300 时 min(300,300)=300 不满足单调）
  const spawn = Math.max(10, Math.min(300, Math.floor(step * 0.8)));
  const childWait = Math.min(45, Math.floor(spawn / 4));
  const zombieStale = Math.min(150, Math.floor(spawn / 2));
  return { wall, gate, step, spawn, childWait, zombieStale };
}

/** 校验单调性；返回违规说明数组（空数组 = 合规）。 */
export function validateTimeoutChain(limits) {
  const t = deriveTimeouts(limits);
  const problems = [];
  const ok = (name, inner, outer) => {
    if (!(inner < outer)) problems.push(`${name}: ${inner} 不小于外层 ${outer}`);
  };
  ok("gate", t.gate, t.wall);
  ok("step", t.step, t.wall);
  ok("spawn", t.spawn, t.step);
  ok("childWait", t.childWait, t.spawn);
  ok("zombieStale", t.zombieStale, t.spawn);
  return problems;
}

/** 可选价格表：${STATE_ROOT}/pricing.json，形如 {"deepseek-v4-pro":{"in":0.28,"out":1.10}}（每百万 token，USD） */
export function loadPricing() {
  const f = path.join(STATE_ROOT, "pricing.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** 无价格表时返回 null —— 不编造金额。 */
export function computeCostUsd(model, tokensIn, tokensOut) {
  const table = loadPricing();
  if (!table) return null;
  const key = Object.keys(table).find((k) => model && String(model).includes(k));
  if (!key) return null;
  const p = table[key];
  const inRate = Number(p.in ?? p.input ?? 0);
  const outRate = Number(p.out ?? p.output ?? 0);
  if (!inRate && !outRate) return null;
  return ((tokensIn ?? 0) / 1e6) * inRate + ((tokensOut ?? 0) / 1e6) * outRate;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file); // 原子替换，避免半写状态
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function taskDir(taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`非法 task id: ${taskId}`);
  }
  return path.join(TASKS_DIR, taskId);
}

export function statusPath(taskId) {
  return path.join(taskDir(taskId), "status.json");
}

/**
 * 生成可排序、可读、无冲突的 task id。
 *
 * **全小写**是刻意的：下游有两处会做小写规范化 ——
 *   OpenClaw 的 session key、orchestrator.sh 的 task_id 校验（只允许 [a-z0-9-]）。
 * 之前带大写 T/Z 的 id 在两处都踩过坑，统一小写从根上消除这一类问题。
 */
export function newTaskId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "z");
  return `${ts}-${randomUUID().slice(0, 8)}`.toLowerCase();
}

/**
 * 追加一条结构化日志。日志是 append-only 的，永不重写，
 * 这样 kill -9 也不会破坏已有记录。
 */
export function log(taskId, event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  // 日志写入必须容错：任务目录可能被外部清理（我们就这样把 runner 进程打挂过一次）。
  // 记日志失败绝不能杀死调用方 —— 它是可观测性手段，不是关键路径。
  try {
    fs.appendFileSync(path.join(taskDir(taskId), "log.jsonl"), `${line}\n`);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      process.stderr.write(`[store] 写日志失败 ${taskId} ${event}: ${e?.message}\n`);
    }
  }
}

export function readStatus(taskId) {
  const st = readJson(statusPath(taskId));
  if (!st) throw new Error(`任务不存在: ${taskId}`);
  return st;
}

export function saveStatus(taskId, status) {
  status.updatedAt = new Date().toISOString();
  writeJson(statusPath(taskId), status);
}

/** 创建任务。每次调用都产生新任务 —— 这是 S1 的机制保证。 */
export function createTask({ rawText, requester, channel, peerId, repo, limits = {}, runOptions = {} }) {
  if (!rawText || !rawText.trim()) throw new Error("rawText 不能为空");
  const taskId = newTaskId();
  const dir = taskDir(taskId);
  ensureDir(path.join(dir, "steps"));
  ensureDir(path.join(dir, "artifacts"));

  const now = new Date().toISOString();
  writeJson(path.join(dir, "request.json"), {
    taskId,
    rawText,
    requester: requester ?? null,
    channel: channel ?? null,
    peerId: peerId ?? null,
    repo: repo ?? null,
    createdAt: now,
    // 运行参数持久化在这里 —— runner 不需要命令行标志，读任务即可
    runOptions: {
      gateCmd: runOptions.gateCmd ?? null,
      workdir: runOptions.workdir ?? null,
      skipPlan: Boolean(runOptions.skipPlan),
      requireEvidence: Boolean(runOptions.requireEvidence),
      mergeMode: runOptions.mergeMode ?? "none",
      mergePush: Boolean(runOptions.mergePush),
      keepWorktree: Boolean(runOptions.keepWorktree),
    },
  });

  const status = {
    taskId,
    phase: "created",
    stepIndex: 0,
    attempts: { review: 0, fix: 0 },
    limits: { ...DEFAULT_LIMITS, ...limits },
    startedAt: now,
    endedAt: null,
    resumeToken: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    error: null,
  };
  saveStatus(taskId, status);
  log(taskId, "task.created", { requester, channel, peerId, repo });
  return { taskId, dir, status };
}

export function readRequest(taskId) {
  const req = readJson(path.join(taskDir(taskId), "request.json"));
  if (!req) throw new Error(`任务缺少 request.json: ${taskId}`);
  return req;
}

/** runner 读取的"怎么跑这个任务"。 */
export function readRunOptions(taskId) {
  const req = readRequest(taskId);
  return (
    req.runOptions ?? { gateCmd: null, workdir: null, skipPlan: false, requireEvidence: false }
  );
}

export function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((n) => fs.existsSync(path.join(TASKS_DIR, n, "status.json")))
    .map((n) => readJson(path.join(TASKS_DIR, n, "status.json")))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function isTerminal(status) {
  return TERMINAL.includes(status.phase);
}

/** 熔断：步数 / 墙钟 / 成本，任一超限即终止（S5）。 */
export function checkLimits(status) {
  if (isTerminal(status)) return null;
  const { limits } = status;
  if (status.stepIndex >= limits.maxSteps) {
    return `步数超限（${status.stepIndex} >= ${limits.maxSteps}）`;
  }
  const wall = (Date.now() - Date.parse(status.startedAt)) / 1000;
  if (wall > limits.maxWallClockSec) {
    return `墙钟超限（${Math.round(wall)}s > ${limits.maxWallClockSec}s）`;
  }
  const totalTokens = (status.tokensIn ?? 0) + (status.tokensOut ?? 0);
  if (limits.maxTokens && totalTokens > limits.maxTokens) {
    return `token 超限（${totalTokens} > ${limits.maxTokens}）`;
  }
  // USD 熔断只在有价格表时才有意义（否则 costUsd 恒为 0）
  if (status.costUsd > limits.maxCostUsd && loadPricing()) {
    return `成本超限（$${status.costUsd.toFixed(4)} > $${limits.maxCostUsd}）`;
  }
  return null;
}

/**
 * 步骤幂等：已完成且非 --force 时跳过。
 * 这是 S2（断点恢复不重跑）的实现点。
 */
export function stepCompleted(taskId, name) {
  const meta = readJson(path.join(taskDir(taskId), "steps", name, "meta.json"));
  return Boolean(meta && meta.exitCode === 0 && !meta.invalidated);
}

export function stepDir(taskId, name) {
  const d = path.join(taskDir(taskId), "steps", name);
  ensureDir(d);
  return d;
}

export function recordStep(taskId, name, { prompt, output, meta }) {
  const dir = stepDir(taskId, name);
  fs.writeFileSync(path.join(dir, "prompt.md"), prompt ?? "");
  fs.writeFileSync(path.join(dir, "output.md"), output ?? "");
  writeJson(path.join(dir, "meta.json"), meta);
  status_accumulateUsage(taskId, meta);
  log(taskId, "step.recorded", {
    name,
    agentId: meta?.agentId,
    exitCode: meta?.exitCode,
    durationMs: meta?.durationMs,
  });
}

/** 累加 token 用量；有价格表时一并算成本。 */
function status_accumulateUsage(taskId, meta) {
  const u = meta?.usage ?? {};
  const tin = Number(u.inputTokens ?? 0);
  const tout = Number(u.outputTokens ?? 0);
  const cost = Number(meta?.costUsd ?? 0);
  if (!tin && !tout && !cost) return;
  const st = readStatus(taskId);
  st.tokensIn = (st.tokensIn ?? 0) + tin;
  st.tokensOut = (st.tokensOut ?? 0) + tout;
  if (cost) st.costUsd = Number((st.costUsd + cost).toFixed(6));
  saveStatus(taskId, st);
}

export function readStepMeta(taskId, name) {
  return readJson(path.join(taskDir(taskId), "steps", name, "meta.json"));
}

export function readStepOutput(taskId, name) {
  try {
    return fs.readFileSync(path.join(taskDir(taskId), "steps", name, "output.md"), "utf8");
  } catch {
    return "";
  }
}

export function writeVerdict(taskId, verdict) {
  writeJson(path.join(taskDir(taskId), "verdict.json"), verdict);
  log(taskId, "verdict.written", { passed: verdict?.gate?.passed ?? null });
}

export function readVerdict(taskId) {
  return readJson(path.join(taskDir(taskId), "verdict.json"));
}

export function transition(taskId, phase, extra = {}) {
  const st = readStatus(taskId);
  st.phase = phase;
  Object.assign(st, extra);
  if (TERMINAL.includes(phase)) st.endedAt = new Date().toISOString();
  saveStatus(taskId, st);
  log(taskId, "phase", { phase });
  return st;
}
