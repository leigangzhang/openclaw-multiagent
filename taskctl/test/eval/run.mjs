#!/usr/bin/env node
/**
 * eval —— 编排逻辑的确定性回归。
 *
 * 为什么 eval 的是编排而不是模型质量：
 *   模型质量无法在此离线断言（且会花钱、不确定）。但**编排逻辑**必须确定 ——
 *   "审查说 pass 就该收工"、"连续 N 轮修不好就该停"、"审查结论解析不出来时不许瞎循环"
 *   这些是代码级契约，可以用桩传输精确验证，跑一遍不到一秒。
 *
 * 注入方式：engine 的 `opts.__dispatch` 替换真实传输。桩按脚本吐预设输出。
 *
 * 用法：node test/eval/run.mjs
 * 退出码：0 全过 / 1 有失败
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// 必须在 import store 之前设状态根
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "taskctl-eval-"));
process.env.MA_STATE_ROOT = TMP;

const store = await import("../../lib/store.mjs");
const { runPipeline } = await import("../../lib/engine.mjs");

const REVIEW_PASS = '看起来没问题。\n```json\n{"passed": true, "severe": [], "suggestions": []}\n```';
const reviewFail = (n) =>
  `发现 ${n} 个严重问题。\n\`\`\`json\n{"passed": false, "severe": ["问题${n}"], "suggestions": []}\n\`\`\``;
const REVIEW_GARBAGE = "我觉得还行吧，没什么大问题。";

/** 桩传输：按队列依次返回预设输出。 */
function stubTransport(outputs) {
  // 每个步骤各自计数 —— 共用一个计数器会让后调用的步骤提前取到数组尾部
  const seq = new Map();
  return async (_transport, { stepName }) => {
    const scripted = outputs[stepName] ?? outputs._default;
    const n = seq.get(stepName) ?? 0;
    seq.set(stepName, n + 1);
    const out = Array.isArray(scripted) ? scripted[Math.min(n, scripted.length - 1)] : scripted;
    return {
      transport: "stub",
      exitCode: 0,
      timedOut: false,
      output: out ?? `(stub) ${stepName}`,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      durationMs: 1,
      sessionKey: `stub/${stepName}`,
    };
  };
}

/** 桩门控：固定退出码。 */
function stubGate(exitCode) {
  return async () => ({ gate: { passed: exitCode === 0, skipped: false, exitCode }, evidence: [{ kind: "stub", exitCode }] });
}

const cases = [];
function scenario(name, fn) {
  cases.push({ name, fn });
}

// ── 场景 ────────────────────────────────────────────────────
scenario("审查通过 → done", async () => {
  const { taskId } = store.createTask({ rawText: "写个函数" });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "计划", code: "代码", review: REVIEW_PASS }),
    __gate: stubGate(0),
    skipPlan: false,
  });
  assert.equal(r.phase, "done");
  assert.equal(store.readStatus(taskId).attempts.fix, 0, "不该进入修复");
});

scenario("审查不通过且修复轮用尽 → failed（不无限循环）", async () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxFixRounds: 2 } });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "计划", code: "代码", review: reviewFail(1) }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /仍有严重问题|仍未通过/);
  // 修复轮次必须被运行时计数并停在 2
  assert.equal(store.readStatus(taskId).attempts.fix, 2);
});

scenario("审查先拒后过 → done，且 fix 计数为 1", async () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxFixRounds: 3 } });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({
      plan: "计划",
      code: ["第一版代码", "修好的代码"],
      review: [reviewFail(1), REVIEW_PASS],
    }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "done");
  assert.equal(store.readStatus(taskId).attempts.fix, 1);
});

scenario("审查结论无法解析 → fail-safe 停下，不进入循环", async () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxFixRounds: 5 } });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "计划", code: "代码", review: REVIEW_GARBAGE }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /无法解析/);
  assert.equal(store.readStatus(taskId).attempts.fix, 0, "解析不出来就不该进修复循环");
});

scenario("步数上限在运行时熔断 → failed", async () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxSteps: 1 } });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "计划", code: "代码", review: reviewFail(1) }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /步数超限/);
});

scenario("token 上限熔断 → failed", async () => {
  const { taskId } = store.createTask({ rawText: "x", limits: { maxTokens: 5 } });
  const r = await runPipeline(taskId, {
    __dispatch: async (_t, { stepName }) => ({
      transport: "stub",
      exitCode: 0,
      output: stepName === "review" ? REVIEW_PASS : "ok",
      usage: { inputTokens: 1000, outputTokens: 1000 },
      durationMs: 1,
    }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /token 超限/);
});

scenario("编码步骤非零退出 → 立即失败，不继续审查", async () => {
  const { taskId } = store.createTask({ rawText: "x" });
  const r = await runPipeline(taskId, {
    __dispatch: async (_t, { stepName }) => ({
      transport: "stub",
      exitCode: stepName === "code" ? 1 : 0,
      output: "boom",
      usage: null,
      durationMs: 1,
    }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /编码步骤失败/);
});

scenario("已完成步骤在重放时被跳过（幂等）", async () => {
  const { taskId } = store.createTask({ rawText: "x" });
  const seen = [];
  const spy = async (_t, { stepName }) => {
    seen.push(stepName);
    return {
      transport: "stub",
      exitCode: 0,
      output: stepName === "review" ? REVIEW_PASS : "ok",
      usage: null,
      durationMs: 1,
    };
  };
  await runPipeline(taskId, { __dispatch: spy, __gate: stubGate(0) });
  const firstRunSteps = seen.length;
  seen.length = 0;
  // 终态任务再跑应当立即返回，不重复执行任何步骤
  const r2 = await runPipeline(taskId, { __dispatch: spy, __gate: stubGate(0) });
  assert.equal(r2.phase, "done");
  assert.equal(seen.length, 0, `终态任务不该再执行步骤，实际执行了 ${seen.join(",")}`);
  assert.ok(firstRunSteps > 0);
});

scenario("中断后 resume：不重跑已完成步骤，且能接着跑完", async () => {
  const { taskId } = store.createTask({ rawText: "x" });
  const ran = [];

  // 第一次：在 code 步骤"崩溃"（抛异常），模拟 runner 被 kill
  const crashing = async (_t, { stepName }) => {
    ran.push(stepName);
    if (stepName === "code") throw new Error("模拟中断：runner 被杀");
    return {
      transport: "stub", exitCode: 0,
      output: stepName === "review" ? REVIEW_PASS : "ok",
      usage: null, durationMs: 1,
    };
  };
  let threw = false;
  try {
    await runPipeline(taskId, { __dispatch: crashing, __gate: stubGate(0) });
  } catch (e) {
    threw = true;
    assert.match(String(e.message), /模拟中断/);
  }
  assert.ok(threw, "中断应当向上抛出，而不是被吞掉");
  assert.deepEqual(ran, ["plan", "code"], "第一次应已跑完 plan，并停在 code");

  const stMid = store.readStatus(taskId);
  assert.ok(!["done", "failed", "cancelled"].includes(stMid.phase), `中断后不应是终态，实际 ${stMid.phase}`);
  const planMetaBefore = fs.statSync(
    path.join(store.taskDir(taskId), "steps", "plan", "meta.json")
  ).mtimeMs;

  // 第二次：正常恢复
  ran.length = 0;
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "计划", code: "代码", review: REVIEW_PASS }),
    __gate: stubGate(0),
  });
  assert.equal(r.phase, "done");
  assert.ok(!ran.includes("plan"), `resume 不该重跑 plan，实际跑了 ${ran.join(",")}`);

  const planMetaAfter = fs.statSync(
    path.join(store.taskDir(taskId), "steps", "plan", "meta.json")
  ).mtimeMs;
  assert.equal(planMetaAfter, planMetaBefore, "已完成步骤的 meta.json 不该被重写（S2 的硬证据）");
});

scenario("mergeMode=none（默认）→ 直接 done，不合并", async () => {
  const { taskId } = store.createTask({ rawText: "x" });
  let mergeCalled = false;
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "p", code: "c", review: REVIEW_PASS }),
    __gate: stubGate(0),
    mergeMode: "none",
    __merge: async () => { mergeCalled = true; return { ok: true, exitCode: 0 }; },
  });
  assert.equal(r.phase, "done");
  assert.equal(mergeCalled, false, "默认不该触发合并");
  assert.equal(store.readStatus(taskId).mergedAt, undefined);
});

scenario("mergeMode=ai → 经过 merging 阶段且记录 mergedAt", async () => {
  const { taskId } = store.createTask({ rawText: "x", repo: "/tmp/fake-repo" });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "p", code: "c", review: REVIEW_PASS }),
    __gate: stubGate(0),
    __provision: async () => ({ ok: true, worktree: "/tmp/fake-wt", exitCode: 0, raw: "" }),
    mergeMode: "ai",
    __merge: async () => ({ ok: true, exitCode: 0 }),
  });
  assert.equal(r.phase, "done");
  assert.ok(store.readStatus(taskId).mergedAt, "mergedAt 应被写入（合并确实发生的证据）");
});

scenario("mergeMode=ai 但合并失败 → failed 且带退出码语义", async () => {
  const { taskId } = store.createTask({ rawText: "x", repo: "/tmp/fake-repo" });
  const r = await runPipeline(taskId, {
    __dispatch: stubTransport({ plan: "p", code: "c", review: REVIEW_PASS }),
    __gate: stubGate(0),
    __provision: async () => ({ ok: true, worktree: "/tmp/fake-wt", exitCode: 0, raw: "" }),
    mergeMode: "ai",
    __merge: async () => ({ ok: false, exitCode: 4, reason: "门控未过", raw: "gate stale" }),
  });
  assert.equal(r.phase, "failed");
  assert.match(String(r.error), /合并失败.*门控未过/);
});

// ── 执行 ────────────────────────────────────────────────────
let pass = 0;
const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    process.stdout.write(`  ✅ ${c.name}\n`);
  } catch (e) {
    failures.push({ name: c.name, error: String(e?.message ?? e) });
    process.stdout.write(`  ❌ ${c.name}\n     ${String(e?.message ?? e).slice(0, 200)}\n`);
  }
}
process.stdout.write(`\n编排 eval：${pass}/${cases.length} 通过\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
