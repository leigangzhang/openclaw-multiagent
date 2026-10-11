/**
 * 汇总生成：把任务状态渲染成给人看的一段话。
 *
 * 原则：结论必须能追溯到硬证据。没有证据就明说"未经测试验证"，
 * 绝不把 LLM 的自述包装成已完成的结论。
 */

import { readStatus, readStepMeta, readStepOutput, readVerdict } from "./store.mjs";

const PHASE_LABEL = {
  created: "已创建",
  provisioning: "准备工作区",
  planning: "规划中",
  coding: "编码中",
  testing: "测试门控",
  reviewing: "审查中",
  fixing: "修复中",
  gating: "定稿",
  done: "已完成",
  failed: "失败",
  needs_approval: "待批准",
  cancelled: "已取消",
};

function fmtCost(usd) {
  return usd > 0 ? `$${usd.toFixed(4)}` : "—";
}

export function buildReport(taskId) {
  const st = readStatus(taskId);
  const verdict = readVerdict(taskId) ?? {};
  const lines = [];

  const icon = st.phase === "done" ? "✅" : st.phase === "failed" ? "❌" : "⏳";
  lines.push(`${icon} 任务 ${taskId}`);
  lines.push(`状态：${PHASE_LABEL[st.phase] ?? st.phase}　步数：${st.stepIndex}　成本：${fmtCost(st.costUsd)}`);

  if (st.phase === "failed" && st.error) {
    lines.push(`原因：${st.error}`);
  }

  if (st.workdir) lines.push(`工作目录：${st.workdir}`);

  // 硬证据
  const g = verdict.gate;
  if (g) {
    if (g.skipped) {
      lines.push("测试门控：**未执行**（未提供测试命令）—— 本任务结果未经测试验证");
    } else {
      lines.push(`测试门控：${g.passed ? "通过" : "未通过"}（exitCode=${g.exitCode}，${g.durationMs}ms）`);
    }
  }

  // 审查结论
  const rv = verdict.review;
  if (rv?.parsed) {
    const n = rv.severe?.length ?? 0;
    lines.push(`审查结论：${rv.passed ? "无严重问题" : `有 ${n} 项严重问题`}`);
    for (const s of (rv.severe ?? []).slice(0, 5)) lines.push(`  ⚠️ ${s}`);
  } else if (rv && rv.parsed === false) {
    lines.push(`审查结论：**无法解析**（${rv.reason}）`);
  }

  // 各步耗时
  const steps = [];
  for (const role of ["plan", "code", "review"]) {
    const m = readStepMeta(taskId, role);
    if (!m) continue;
    const sec = Math.round((m.durationMs ?? 0) / 1000);
    steps.push(`${role}(${m.agentId}/${m.transport}, ${sec}s)`);
  }
  if (steps.length) lines.push(`步骤：${steps.join(" → ")}`);

  // 最终产出（编码步骤的原文，截断）
  const code = readStepOutput(taskId, "code").trim();
  if (code) {
    lines.push("");
    lines.push("—— 实现者回报 ——");
    lines.push(code.length > 1200 ? `${code.slice(0, 1200)}\n…（已截断）` : code);
  }

  return lines.join("\n");
}

/** 机器可读视图，供 OpenClaw 侧与测试断言使用。 */
export function buildStatusJson(taskId) {
  const st = readStatus(taskId);
  const verdict = readVerdict(taskId) ?? {};
  return {
    taskId,
    phase: st.phase,
    stepIndex: st.stepIndex,
    attempts: st.attempts,
    limits: st.limits,
    costUsd: st.costUsd,
    startedAt: st.startedAt,
    endedAt: st.endedAt,
    error: st.error,
    verdict,
  };
}
