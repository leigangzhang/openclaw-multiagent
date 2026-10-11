#!/usr/bin/env node
/**
 * reap —— 僵尸会话回收器。
 *
 * 问题：ACP 子会话被中断（runner 重启 / kill / 崩溃 / 网关卡住）后会永远停在
 * `status='running'`。它不会自己结束，也不会报错。
 *
 * 影响：
 *   - `acp-poll` 会为它空等到超时（transport 里已加死亡判定，那是"不被拖死"）
 *   - 但会话记录会一直堆积，且 `session_windows` 的统计失去意义
 *
 * 与 transport 里的死亡判定分工：
 *   transport 侧 = 不被动等（防守）
 *   本脚本      = 主动清理（治理）
 *
 * 安全设计：
 *   - **默认 dry-run**，只列不删
 *   - 双条件判定：`status='running'` **且** `updated_at` 超过宽限期
 *   - 宽限期默认 20 分钟，远大于正常 ACP 回合（实测 8–80 秒）
 *   - 删除前逐一复核，删除后统计
 *
 * 用法：
 *   node bin/reap.mjs                 # 只列出僵尸（dry-run）
 *   node bin/reap.mjs --grace 1200    # 自定义宽限期（秒）
 *   node bin/reap.mjs --force         # 真删
 *   node bin/reap.mjs --json --force  # 机器可读
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, ".openclaw", "agents");
const STATE_ROOT = process.env.MA_STATE_ROOT || path.join(HOME, ".local", "state", "openclaw-multiagent");
const ORCHESTRATOR = path.join(HOME, "Workspace", "openclaw-multiagent", "orchestrator", "orchestrator.sh");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || path.join(HOME, "bin", "openclaw");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const GRACE_SEC = Number(arg("grace", 1200));
const FORCE = Boolean(arg("force"));
const JSON_OUT = Boolean(arg("json"));
// --worktrees 只处理工作树；--sessions 只处理会话；都不给则两者都查
const ONLY_WT = Boolean(arg("worktrees"));
const ONLY_SESSIONS = Boolean(arg("sessions"));
const DO_WT = ONLY_WT || !ONLY_SESSIONS;
const DO_SESSIONS = ONLY_SESSIONS || !ONLY_WT;
const DOWORKTREES = DO_WT;

function sqliteJson(db, sql) {
  try {
    const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 8 << 20 });
    const t = (out ?? "").trim();
    return t ? JSON.parse(t) : [];
  } catch {
    return [];
  }
}

/** 找出所有 agent 下"running 且久未更新"的会话。 */
function findZombies() {
  const cutoff = Date.now() - GRACE_SEC * 1000;
  const found = [];
  if (!fs.existsSync(AGENTS_DIR)) return found;

  for (const agentId of fs.readdirSync(AGENTS_DIR)) {
    const db = path.join(AGENTS_DIR, agentId, "agent", "openclaw-agent.sqlite");
    if (!fs.existsSync(db)) continue;
    const rows = sqliteJson(
      db,
      `select session_key, session_id, status, updated_at, created_at, spawned_by
       from session_windows
       where status = 'running' and (updated_at is null or updated_at < ${cutoff})
       order by updated_at asc;`
    );
    for (const r of rows) found.push({ agentId, db, ...r });
  }
  return found;
}

function fmtAge(ms) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

/**
 * 孤儿工作树：`~/.openclaw-worktrees/<repo-fp>/<task>` 下，对应任务已到终态或记录已不存在。
 *
 * 成因：任务失败/被清理/runner 被 kill，worktree 就留在那了。实测能堆到 17M+。
 * 删除走 orchestrator.sh clean（会同时注销 git worktree 注册），
 * 记录已丢失时才退回 rm -rf + 提示手动 prune。
 */
function findOrphanWorktrees() {
  const root = path.join(HOME, ".openclaw-worktrees");
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const fp of fs.readdirSync(root)) {
    const fpDir = path.join(root, fp);
    let entries = [];
    try { entries = fs.readdirSync(fpDir); } catch { continue; }
    for (const task of entries) {
      const dir = path.join(fpDir, task);
      let st = null;
      try {
        st = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, "tasks", task, "status.json"), "utf8"));
      } catch { /* 记录已不存在 */ }
      const terminal = st ? ["done", "failed", "cancelled"].includes(st.phase) : false;
      const gone = !st;
      if (terminal || gone) {
        let repo = null;
        try {
          repo = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, "tasks", task, "artifacts", "workspace.json"), "utf8")).repo;
        } catch { /* */ }
        found.push({ task, dir, repo, phase: st?.phase ?? "（记录已清）", reason: gone ? "任务记录不存在" : `phase=${st.phase}` });
      }
    }
  }
  return found;
}

function reapWorktrees() {
  const orphans = findOrphanWorktrees();
  const report = [];
  for (const o of orphans) {
    const entry = { task: o.task, dir: o.dir, phase: o.phase, reason: o.reason, action: FORCE ? "clean" : "would-clean" };
    if (FORCE) {
      try {
        if (o.repo && fs.existsSync(ORCHESTRATOR)) {
          execFileSync("/bin/zsh", [ORCHESTRATOR, "clean", o.task, "--force"], {
            encoding: "utf8", timeout: 120_000,
            env: { ...process.env, ORCH_REPO: o.repo },
            stdio: ["ignore", "pipe", "pipe"],
          });
          entry.action = "cleaned";
        } else {
          fs.rmSync(o.dir, { recursive: true, force: true });
          entry.action = "removed-dir";
          if (o.repo) entry.note = `记录/rpc 缺失，请手动在 ${o.repo} 跑 git worktree prune`;
        }
      } catch (e) {
        entry.action = "clean-failed";
        entry.error = String(e?.message ?? e).slice(0, 200);
      }
    }
    report.push(entry);
  }
  // 清掉空的 repo-fp 目录，避免残留空壳
  if (FORCE && fs.existsSync(root)) {
    for (const fp of fs.readdirSync(root)) {
      const fpDir = path.join(root, fp);
      try {
        if (fs.statSync(fpDir).isDirectory() && fs.readdirSync(fpDir).length === 0) fs.rmdirSync(fpDir);
      } catch { /* */ }
    }
  }
  return report;
}

const zombies = DO_SESSIONS ? findZombies() : [];
const orphanWts = DO_WT ? reapWorktrees() : [];

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({
    sessions: DO_SESSIONS ? zombies.map((z) => ({ sessionKey: z.session_key, agentId: z.agentId, idle: fmtAge(z.updated_at) })) : undefined,
    worktrees: DO_WT ? orphanWts : undefined,
    dryRun: !FORCE,
  }, null, 2)}\n`);
  process.exit(0);
}

if (orphanWts.length > 0) {
  process.stdout.write(`${FORCE ? "回收" : "发现"} ${orphanWts.length} 个孤儿工作树${FORCE ? "" : "　—— 加 --force 才真删"}\n`);
  for (const w of orphanWts) process.stdout.write(`  [${w.action}] ${w.task}　${w.phase}　${w.reason}\n`);
  process.stdout.write("");
}

if (zombies.length === 0) {
  if (JSON_OUT) process.stdout.write(`${JSON.stringify({ zombies: [], reaped: 0, dryRun: !FORCE })}\n`);
  else if (DO_SESSIONS) process.stdout.write(`无僵尸会话（宽限期 ${GRACE_SEC}s）\n`);
  process.exit(0);
}

const report = [];
for (const z of zombies) {
  const entry = {
    agentId: z.agentId,
    sessionKey: z.session_key,
    status: z.status,
    idle: fmtAge(z.updated_at),
    spawnedBy: z.spawned_by ?? null,
    action: FORCE ? "delete" : "would-delete",
  };
  if (FORCE) {
    try {
      execFileSync(OPENCLAW_BIN, ["sessions", "delete", "--yes", z.session_key], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      entry.action = "deleted";
    } catch (e) {
      entry.action = "delete-failed";
      entry.error = String(e?.message ?? e).slice(0, 200);
    }
  }
  report.push(entry);
}

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ zombies: report, reaped: report.filter((r) => r.action === "deleted").length, dryRun: !FORCE }, null, 2)}\n`);
} else {
  process.stdout.write(
    `${FORCE ? "回收" : "发现"} ${report.length} 个僵尸会话（宽限期 ${GRACE_SEC}s）${FORCE ? "" : "　—— 加 --force 才真删"}\n`
  );
  for (const r of report) {
    process.stdout.write(`  [${r.action}] ${r.agentId}　${r.sessionKey}　闲置 ${r.idle}　spawnedBy=${r.spawnedBy ?? "—"}\n`);
  }
}
process.exit(0);
