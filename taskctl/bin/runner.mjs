#!/usr/bin/env node
/**
 * runner —— 异步任务执行器。
 *
 * 为什么必须独立于 OpenClaw 的 exec 运行（实测结论，不是设计偏好）：
 *
 *   把 `taskctl run` 放进 agent 的 exec 里跑，会同时踩三个坑：
 *     1. exec 子进程内嵌套调用 `openclaw agent` 不通 —— 不产出会话、不产出子进程，静默卡死
 *     2. 飞书渠道有 per-chat 300s 上限，长管线必然被驱逐
 *     3. spawner 会回调正在阻塞的那个 agent，形成死锁
 *
 *   所以职责拆开：
 *     dispatcher（在 OpenClaw 里）只负责 submit，秒级返回
 *     runner（普通进程，不在任何 exec 里）负责 run + 投递
 *
 * 用法：
 *   runner.mjs                 # 常驻循环
 *   runner.mjs --once          # 跑一轮就退出（测试/一次性）
 *   runner.mjs --interval 5    # 轮询间隔秒数
 *   runner.mjs --dry-run       # 不真投递，只打印
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  STATE_ROOT,
  TASKS_DIR,
  listTasks,
  readRunOptions,
  readStatus,
  isTerminal,
  log,
} from "../lib/store.mjs";
import { runPipeline } from "../lib/engine.mjs";
import { buildReport } from "../lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || path.join(process.env.HOME, "bin", "openclaw");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const ONCE = Boolean(arg("once"));
const DRY_RUN = Boolean(arg("dry-run"));
const INTERVAL_SEC = Number(arg("interval", 5));
const LOCK_DIR = path.join(STATE_ROOT, "locks");

/** 每个任务一把锁，防止两个 runner 重复跑同一个任务。 */
function acquireLock(taskId) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, `${taskId}.lock`);
  try {
    const fd = fs.openSync(file, "wx"); // 已存在即失败
    fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 已被清理 */
      }
    };
  } catch {
    // 陈旧锁回收：持有者进程已不在，或锁文件形如 "<pid> <startedAtMs>" 且过旧
    try {
      const parts = fs.readFileSync(file, "utf8").trim().split(/\s+/);
      const pid = Number(parts[0]);
      const ageMs = Date.now() - (Number(parts[1]) || 0);
      const holderGone = !pid || !isAlive(pid);
      // 兜底：即便 pid 被复用导致 isAlive 为真，超过 maxWallClock+10min 的锁也视为陈旧
      const tooOld = ageMs > 3600_000;
      if (holderGone || tooOld) {
        log(taskId, "runner.staleLock", { pid, ageMs, holderGone, tooOld });
        fs.unlinkSync(file);
        return acquireLock(taskId);
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 把汇总投递到任务来源渠道。用 message send 直投，不额外花一次 LLM 调用。 */
function deliver(taskId, text) {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, taskId, "request.json"), "utf8"));
  } catch {
    return { ok: false, reason: "读不到 request.json" };
  }
  const { channel, peerId } = req;
  if (!channel || !peerId) return { ok: false, reason: "请求里没有 channel/peerId，跳过投递" };
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] 本应投递到 ${channel}:${peerId}\n${text}\n`);
    return { ok: true, dryRun: true };
  }
  return new Promise((resolve) => {
    execFile(
      OPENCLAW_BIN,
      ["message", "send", "--channel", channel, "--target", peerId, "--message", text, "--json"],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ok = !err;
        log(taskId, "delivery", { ok, target: `${channel}:${peerId}`, err: err?.message ?? null });
        resolve({ ok, reason: ok ? null : `${err?.message ?? ""}${stderr ?? ""}`.slice(0, 400) });
      }
    );
  });
}

/** 待办：非终态任务，按创建时间升序（先到先跑）。 */
function pendingTasks() {
  return listTasks()
    .filter((s) => !isTerminal(s))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

async function runOne(status) {
  const { taskId } = status;
  const release = acquireLock(taskId);
  if (!release) return { taskId, skipped: "已被其他 runner 持有" };

  try {
    log(taskId, "runner.claimed", { pid: process.pid });
    const opts = readRunOptions(taskId);
    const r = await runPipeline(taskId, opts);
    const report = buildReport(taskId);
    const d = await deliver(taskId, report);
    return { taskId, phase: r.phase, delivered: d.ok, deliveryReason: d.reason };
  } catch (e) {
    log(taskId, "runner.error", { message: String(e?.message ?? e) });
    return { taskId, phase: "error", error: String(e?.message ?? e) };
  } finally {
    release();
  }
}

async function pass() {
  const pending = pendingTasks();
  if (pending.length === 0) return 0;
  let n = 0;
  for (const st of pending) {
    // 顺序执行：编排本来就是串行接力，并发只会引入竞态。
    // 单个任务的任何异常都必须被吞在这里 —— 进程挂了会让所有后续任务停摆。
    let r;
    try {
      r = await runOne(st);
    } catch (e) {
      r = { taskId: st.taskId, phase: "error", error: String(e?.message ?? e) };
    }
    process.stdout.write(`${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`);
    n += 1;
  }
  return n;
}

async function main() {
  process.stdout.write(
    `runner 启动 pid=${process.pid} state=${STATE_ROOT} interval=${INTERVAL_SEC}s once=${ONCE} dryRun=${DRY_RUN}\n`
  );
  if (ONCE) {
    await pass();
    return 0;
  }
  let stopping = false;
  const stop = () => {
    stopping = true;
    process.stdout.write("runner 收到停止信号，当前轮结束后退出\n");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    try {
      await pass();
    } catch (e) {
      process.stderr.write(`runner 轮次异常: ${e?.stack ?? e}\n`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write(`runner 致命错误: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
);
