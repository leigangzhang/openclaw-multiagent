#!/usr/bin/env node
/**
 * audit —— 一次性核对整条链路的配置。
 *
 * 为什么需要它：之前是"改一处、测一次、暴露下一个问题"，飞书链路试了 5 轮，
 * 其中 4 轮卡在我自己引入的配置错误上。这个脚本把"一条完整路径需要哪些能力"
 * 列清并一次性核对，避免继续单点试错。
 *
 * 检查三层：
 *   A. OpenClaw 侧：dispatcher 能否收消息、跑命令、回消息
 *   B. taskctl 侧：任务库与传输是否就绪
 *   C. runner 侧：服务是否在跑、能否投递
 *
 * 退出码：0 全过 / 1 有 FAIL
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STATE_ROOT, TASKS_DIR } from "../lib/store.mjs";

const HOME = os.homedir();
const CONFIG = path.join(HOME, ".openclaw", "openclaw.json");
const sqlite = path.join(HOME, ".openclaw", "state", "openclaw.sqlite");
const results = [];

function check(area, name, ok, detail = "") {
  results.push({ area, name, ok, detail });
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

function sh(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 << 20 }) };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? "") + String(e?.stderr ?? e?.message ?? "") };
  }
}

// ── A. OpenClaw 侧 ─────────────────────────────────────────
function auditOpenClaw() {
  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    check("A", "读取 openclaw.json", false, String(e.message));
    return;
  }
  check("A", "读取 openclaw.json", true);

  const disp = cfg.agents?.entries?.dispatcher ?? {};
  const also = disp.tools?.alsoAllow ?? [];
  check("A", "dispatcher 有 exec 工具", also.includes("exec"), `alsoAllow=${JSON.stringify(also)}`);
  check(
    "A",
    "dispatcher 不含 process（防工具死循环）",
    !also.includes("process"),
    also.includes("process") ? "process 会导致轮询死循环" : ""
  );
  check("A", "dispatcher 有模型", Boolean(disp.model), `model=${disp.model ?? "未设"}`);

  const globalAlso = cfg.tools?.alsoAllow ?? [];
  check(
    "A",
    "全局 alsoAllow 不含 exec（保护 codex harness）",
    !globalAlso.includes("exec"),
    `global=${JSON.stringify(globalAlso)}`
  );

  const exec = cfg.tools?.exec ?? {};
  check("A", "exec 超时已放宽", Number(exec.timeoutSeconds) >= 300, `timeoutSeconds=${exec.timeoutSeconds}`);
  check(
    "A",
    "exec 后台化阈值足够高（任务提交不被转后台）",
    Number(exec.backgroundMs) >= 60000,
    `backgroundMs=${exec.backgroundMs}`
  );

  const b = cfg.bindings ?? [];
  check(
    "A",
    "飞书路由指向 dispatcher",
    b.some((x) => x.agentId === "dispatcher"),
    JSON.stringify(b.map((x) => x.agentId))
  );
  check("A", "通讯端为飞书", Boolean(cfg.channels?.feishu?.appId), `appId=${cfg.channels?.feishu?.appId ? "已配置" : "缺失"}`);

  // 白名单：软链与真实目标都要在
  const r = sh("sqlite3", ["-json", sqlite, "select raw_json from exec_approvals_config;"]);
  let allow = [];
  try {
    // sqlite -json 对单列查询返回数组：[{ raw_json: "..." }]
    const rows = JSON.parse(r.out.trim() || "[]");
    const d = JSON.parse(Array.isArray(rows) ? rows[0].raw_json : rows.raw_json);
    allow = (d.agents?.dispatcher?.allowlist ?? []).map((x) => x.pattern);
  } catch (e) {
    allow = [`解析失败: ${e.message}`];
  }
  const runnerTarget = path.join(HOME, "Workspace/openclaw-multiagent/taskctl/index.mjs");
  check("A", "白名单含 taskctl 真实目标", allow.includes(runnerTarget), `allow=${JSON.stringify(allow)}`);
  check("A", "白名单含 node", allow.some((p) => p.includes("node")), "");
}

// ── B. taskctl 侧 ──────────────────────────────────────────
function auditTaskctl() {
  check("B", "状态根可写", (() => {
    try {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      return true;
    } catch {
      return false;
    }
  })(), STATE_ROOT);

  const cli = path.join(HOME, "bin", "taskctl");
  check("B", "taskctl shim 存在", fs.existsSync(cli), cli);
  if (fs.existsSync(cli)) {
    const r = sh(cli, ["list"]);
    check("B", "taskctl 可执行", r.ok, r.ok ? "" : r.out.slice(0, 160));
  }

  // 传输各自的 agent 是否就绪
  const cfg = readConfig();
  for (const [role, agentId] of [["plan", "claude"], ["code", "dsh"], ["review", "codex"]]) {
    check("B", `角色 ${role} 的 agent「${agentId}」存在`, Boolean(cfg.agents?.entries?.[agentId]), "");
  }
  const acpAgents = cfg.plugins?.entries?.acpx?.config?.agents ?? {};
  check("B", "acpx 注册了 dsh（acp-poll 依赖）", Boolean(acpAgents.dsh), JSON.stringify(Object.keys(acpAgents)));

  // 会话库（acp-poll 靠它取结果）
  const dshDb = path.join(HOME, ".openclaw", "agents", "dsh", "agent", "openclaw-agent.sqlite");
  check("B", "dsh 会话库存在（acp-poll 取结果用）", fs.existsSync(dshDb), dshDb);
  if (fs.existsSync(dshDb)) {
    const r = sh("sqlite3", [dshDb, "select count(*) from session_windows;"]);
    check("B", "会话库可查", r.ok, r.out.trim());
  }

  // spawner 不能是 dispatcher（会死锁）
  const t = fs.readFileSync(new URL("../lib/transport.mjs", import.meta.url), "utf8");
  const spawner = /DEFAULT_ACP_SPAWNER\s*=\s*"([^"]+)"/.exec(t)?.[1];
  check(
    "B",
    "ACP spawner 不是 dispatcher（防死锁）",
    Boolean(spawner) && spawner !== "dispatcher",
    `spawner=${spawner}`
  );
}

// ── C. runner 侧 ───────────────────────────────────────────
function auditRunner() {
  const r = sh("launchctl", ["list"]);
  const line = r.out.split("\n").find((l) => l.includes("ai.openclaw.multiagent-runner"));
  check("C", "runner 服务已加载", Boolean(line), line ?? "未加载");
  if (line) {
    const pid = line.trim().split(/\s+/)[0];
    check("C", "runner 进程存活", pid !== "-" && Number(pid) > 0, `pid=${pid}`);
  }

  const logFile = path.join(HOME, "Library", "Logs", "openclaw", "multiagent-runner.log");
  check("C", "runner 日志存在", fs.existsSync(logFile), logFile);
  if (fs.existsSync(logFile)) {
    const tail = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-5).join("\n");
    check("C", "runner 无致命错误", !/致命错误/.test(tail), tail.slice(0, 200));
  }

  // 投递通道
  const openclaw = path.join(HOME, "bin", "openclaw");
  const d = sh(openclaw, ["message", "send", "--help"]);
  check("C", "message send 可用（投递用，不花 LLM）", d.ok, "");

  // 锁目录
  check("C", "锁目录可建", (() => {
    try {
      fs.mkdirSync(path.join(STATE_ROOT, "locks"), { recursive: true });
      return true;
    } catch {
      return false;
    }
  })(), "");
}

auditOpenClaw();
auditTaskctl();
auditRunner();

// ── 输出 ───────────────────────────────────────────────────
let fails = 0;
let area = null;
for (const r of results) {
  if (r.area !== area) {
    area = r.area;
    const title = { A: "A. OpenClaw 侧", B: "B. taskctl 侧", C: "C. runner 侧" }[area];
    process.stdout.write(`\n${title}\n`);
  }
  const mark = r.ok ? "✅" : "❌";
  if (!r.ok) fails += 1;
  process.stdout.write(`  ${mark} ${r.name}${r.detail ? `　— ${r.detail}` : ""}\n`);
}
process.stdout.write(`\n通过 ${results.length - fails}/${results.length}${fails ? `　失败 ${fails}` : ""}\n`);
process.exit(fails ? 1 : 0);
