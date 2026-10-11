/**
 * 编排引擎：确定性控制流。
 *
 * 这是整个产品与"demo 版"的分界线 ——
 *   demo：控制流住在 LLM 的提示词与会话历史里（不确定、不可恢复、不可验证）
 *   这里：控制流是代码。LLM 只出现在边界清晰的单步里。
 *
 * 关键不变式：
 *   1. fix 轮次由 status.attempts.fix 计数，不由 LLM 自律
 *   2. 每步幂等，已完成即跳过（断点恢复的基础）
 *   3. 上限检查在每一步之前，超限即终止
 *   4. 审查结论解析不出来时**不进入修复循环**（fail-safe，不猜）
 *   5. "完成"必须有硬证据；LLM 自述不算证据
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import {
  checkLimits,
  isTerminal,
  log,
  readRequest,
  readStatus,
  readStepOutput,
  recordStep,
  computeCostUsd,
  saveStatus,
  stepCompleted,
  transition,
  writeVerdict,
  readVerdict,
} from "./store.mjs";
import { ROLES, parseReviewVerdict, pricingKeyFor } from "./roles.mjs";
import { provisionWorkspace, runTestGate, orchestratorAvailable } from "./workspace.mjs";
import { dispatch } from "./transport.mjs";

function fail(taskId, reason, extra = {}) {
  log(taskId, "task.failed", { reason, ...extra });
  transition(taskId, "failed", { error: reason });
  return { taskId, phase: "failed", error: reason };
}

/** 执行单个角色步骤。幂等：已完成且 exitCode=0 则直接复用。 */
export async function runStep(taskId, roleName, opts = {}) {
  const role = ROLES[roleName];
  if (!role) throw new Error(`未知角色: ${roleName}（可用: ${Object.keys(ROLES).join(", ")}）`);

  if (!opts.force && stepCompleted(taskId, roleName)) {
    const out = readStepOutput(taskId, roleName);
    log(taskId, "step.skipped", { name: roleName, reason: "已完成" });
    // skipped 是成功态：必须带 exitCode=0，否则调用方会误判为失败
    return { skipped: true, exitCode: 0, output: out };
  }

  const st = readStatus(taskId);
  const req = readRequest(taskId);

  // 工作目录优先级（顺序很关键，写反过一次）：
  //   1. 已供应的 worktree —— 它是为本任务专门分配的，必须最优先
  //   2. 调用方显式传入
  //   3. submit 时的默认值
  //   4. 仓库本身
  // 之前把 opts.workdir 放在最前，导致 submit 的默认值压过 worktree，
  // DSH 于是在**原仓库**里改文件，而测试门控在 worktree 里跑 —— 两边不是同一个地方。
  const effectiveWorkdir =
    st.workdir ?? opts.workdir ?? req.runOptions?.workdir ?? req.repo ?? null;

  const prompt = role.build({
    rawText: req.rawText,
    repo: req.repo,
    workdir: effectiveWorkdir,
    planText: opts.planText ?? readStepOutput(taskId, "plan"),
    codeText: opts.codeText ?? readStepOutput(taskId, "code"),
    reviewText: opts.reviewText ?? readStepOutput(taskId, "review"),
  });

  const sessionKey = `task/${taskId}/${roleName}`;
  log(taskId, "step.start", { name: roleName, agentId: role.agentId, transport: role.transport, sessionKey });

  // opts.__dispatch 是测试注入点：eval 用它替换真实传输，
  // 从而在不花 LLM 成本的前提下验证编排逻辑本身（而不是模型质量）。
  const send = opts.__dispatch ?? dispatch;
  const result = await send(role.transport, {
    agentId: role.agentId,
    sessionKey,
    prompt,
    taskId,
    stepName: roleName,
    cwd: effectiveWorkdir ?? undefined,
    timeoutSec: opts.timeoutSec ?? 900,
  });

  recordStep(taskId, roleName, {
    prompt,
    output: result.output,
    meta: {
      agentId: role.agentId,
      sessionKey,
      transport: result.transport,
      exitCode: result.timedOut ? 124 : result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      usage: result.usage ?? null,
      // 用角色的计费键查价格表 —— 不是 agentId（那个永远匹配不上模型名）
      costUsd:
        result.usage?.costUsd ||
        computeCostUsd(pricingKeyFor(roleName), result.usage?.inputTokens, result.usage?.outputTokens) ||
        0,
      pricingKey: pricingKeyFor(roleName),
      raw: result.raw,
    },
  });

  // 步数计数放在这里：无论成功失败都算一步，防止失败重试无限循环
  const after = readStatus(taskId);
  after.stepIndex += 1;
  saveStatus(taskId, after);

  return {
    skipped: false,
    exitCode: result.timedOut ? 124 : result.exitCode,
    output: result.output,
    transport: result.transport,
  };
}

/**
 * 硬门控：跑一条外部命令，退出码就是证据。
 * 不猜测 orchestrator.sh 的接口 —— 命令由调用方给出（P2 再接入真实命令）。
 */
export async function runGate(taskId, { gateCmd, cwd, timeoutSec = 900, repo } = {}) {
  // 没给 gateCmd 但有仓库 → 用 orchestrator.sh 的测试门控。
  // 这比"跳过门控"重要得多：跳过意味着结论没有经过任何验证。
  if (!gateCmd && repo && orchestratorAvailable()) {
    const g = await runTestGate(taskId, { cwd, timeoutSec: 1800, repo });
    const verdict = {
      gate: {
        passed: g.exitCode === 0,
        skipped: false,
        kind: "orchestrator.test",
        exitCode: g.exitCode,
        tail: g.raw,
      },
      evidence: [{ kind: "orchestrator.test", exitCode: g.exitCode }],
      at: new Date().toISOString(),
    };
    writeVerdict(taskId, verdict);
    return verdict;
  }
  if (!gateCmd) {
    const verdict = {
      gate: { passed: null, skipped: true, reason: "未提供 gateCmd" },
      evidence: [],
      at: new Date().toISOString(),
    };
    writeVerdict(taskId, verdict);
    return verdict;
  }
  const started = Date.now();
  const r = await new Promise((resolve) => {
    exec(gateCmd, { cwd, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        out: `${stdout ?? ""}${stderr ?? ""}`.slice(-8000),
      })
    );
  });
  const verdict = {
    gate: {
      passed: r.exitCode === 0,
      skipped: false,
      cmd: gateCmd,
      exitCode: r.exitCode,
      durationMs: Date.now() - started,
      tail: r.out,
    },
    evidence: [{ kind: "command", cmd: gateCmd, exitCode: r.exitCode }],
    at: new Date().toISOString(),
  };
  writeVerdict(taskId, verdict);
  return verdict;
}

/**
 * 主管线：规划 → 编码 → 门控 → 审查 →（必要时）修复 → 门控 → 完成。
 *
 * 返回 {phase, ...}。所有终止都经由 checkLimits 或明确的分支，
 * 不存在"让模型自己决定还要不要继续"的路径。
 */
export async function runPipeline(taskId, opts = {}) {
  const maxFix = readStatus(taskId).limits.maxFixRounds;

  for (;;) {
    const st = readStatus(taskId);
    if (isTerminal(st)) return { taskId, phase: st.phase, error: st.error ?? null };

    const breach = checkLimits(st);
    if (breach) return fail(taskId, breach, { phase: st.phase });

    switch (st.phase) {
      case "created": {
        const req = readRequest(taskId);
        // 有仓库才需要工作树；没有仓库的任务（纯对话类）直接进入规划
        if (req.repo) {
          transition(taskId, "provisioning");
        } else {
          transition(taskId, "planning");
        }
        break;
      }

      case "provisioning": {
        const req = readRequest(taskId);
        const prov = await provisionWorkspace(taskId, req.repo, {
          base: opts.base ?? null,
          agent: req.runOptions?.agent ?? null,
        });
        if (!prov.ok) {
          return fail(taskId, `工作树供应失败（exitCode=${prov.exitCode}）：${prov.raw.slice(-300)}`, {
            step: "provision",
          });
        }
        const st2 = readStatus(taskId);
        st2.workdir = prov.worktree;
        saveStatus(taskId, st2);
        log(taskId, "workspace.ready", { workdir: prov.worktree });
        transition(taskId, "planning");
        break;
      }

      case "planning": {
        if (opts.skipPlan) {
          transition(taskId, "coding");
          break;
        }
        const r = await runStep(taskId, "plan", opts);
        if (r.exitCode !== 0) {
          log(taskId, "step.nonzero", { name: "plan", exitCode: r.exitCode });
          // 规划失败不致命：继续编码，但记录在案
        }
        transition(taskId, "coding");
        break;
      }

      case "coding": {
        // 修复轮必须重跑 —— 幂等跳过只适用于"重放同一个任务"，
        // 不适用于"按审查意见改一版"。这是实测踩到的坑：
        // attempts.fix>0 时若跳过，引擎会因 exitCode=undefined 误判失败。
        const isFixRound = st.attempts.fix > 0;
        const r = await runStep(taskId, "code", {
          ...opts,
          force: isFixRound,
          reviewText: isFixRound ? readStepOutput(taskId, "review") : "",
        });
        if (r.exitCode !== 0) {
          return fail(taskId, `编码步骤失败（exitCode=${r.exitCode}）`, { step: "code" });
        }
        transition(taskId, "testing");
        break;
      }

      case "testing": {
        // opts.__gate 同为测试注入点（见 eval）
        const gateFn = opts.__gate ?? runGate;
        const verdict = await gateFn(taskId, { ...opts, repo: readRequest(taskId).repo });
        if (verdict.gate.skipped) {
          log(taskId, "gate.skipped", { reason: verdict.gate.reason });
          transition(taskId, "reviewing", { lastGatePassed: null });
          break;
        }
        if (!verdict.gate.passed) {
          if (st.attempts.fix >= maxFix) {
            return fail(taskId, `测试门控连续 ${maxFix} 轮未通过`, { step: "gate" });
          }
          transition(taskId, "fixing", {
            attempts: { ...st.attempts, fix: st.attempts.fix + 1 },
          });
          break;
        }
        transition(taskId, "reviewing", { lastGatePassed: true });
        break;
      }

      case "fixing":
        transition(taskId, "coding");
        break;

      case "reviewing": {
        const s0 = readStatus(taskId);
        // review 也必须逐轮重跑：幂等跳过只适用于"重放同一任务"。
        // 若跳过，第 2 轮起读到的仍是上一轮的**失败**结论 —— 会陷入
        // "修 → 跳过审查 → 又判失败" 的死循环，直到 maxFix 耗尽（eval 抓到）。
        const r = await runStep(taskId, "review", { ...opts, force: s0.attempts.review > 0 });
        const s2 = readStatus(taskId);
        s2.attempts.review += 1;
        saveStatus(taskId, s2);

        if (r.exitCode !== 0) {
          log(taskId, "step.nonzero", { name: "review", exitCode: r.exitCode });
          return fail(taskId, `审查步骤失败（exitCode=${r.exitCode}）`, { step: "review" });
        }

        const verdict = parseReviewVerdict(r.output);
        writeVerdict(taskId, {
          ...(readVerdict(taskId) ?? {}),
          review: verdict,
          at: new Date().toISOString(),
        });

        if (!verdict.parsed) {
          // fail-safe：解析不出来就不进修复循环，避免用垃圾意见反复折腾
          log(taskId, "review.unparsed", { reason: verdict.reason });
          return fail(taskId, `审查结论无法解析，停止以避免无效循环：${verdict.reason}`, {
            step: "review",
          });
        }

        if (verdict.passed) {
          transition(taskId, "gating");
          break;
        }
        if (s2.attempts.fix >= maxFix) {
          return fail(taskId, `修复 ${maxFix} 轮后仍有严重问题`, {
            step: "review",
            severe: verdict.severe,
          });
        }
        transition(taskId, "fixing", {
          attempts: { ...s2.attempts, fix: s2.attempts.fix + 1 },
        });
        break;
      }

      case "gating": {
        const st3 = readStatus(taskId);
        const v = readVerdict(taskId) ?? {};
        const mustHaveEvidence = Boolean(opts.requireEvidence);
        const hasEvidence = Array.isArray(v.evidence) && v.evidence.length > 0;
        if (mustHaveEvidence && !hasEvidence) {
          return fail(taskId, "缺少硬证据（要求提供 gateCmd 或测试命令）", { step: "gating" });
        }
        transition(taskId, "done");
        break;
      }

      default:
        return fail(taskId, `未知状态: ${st.phase}`);
    }
  }
}
