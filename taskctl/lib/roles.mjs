/**
 * 角色定义：谁干什么、走哪条传输、拿到什么提示词。
 *
 * 提示词是**固定模板 + 上下文注入**，不是让模型自由编排。
 * 每个角色的输入都自包含（执行者之间不共享上下文）。
 */

/** 默认角色配置。transport 可按角色切换，便于逐角色降级排障。 */
export const ROLES = {
  plan: {
    agentId: "claude",
    // agent-cli：claude 走 claude-cli 后端（复用本机 Claude Code 登录），已实测可用。
    // 不走 ACP —— ACP 经 openclaw agent 根本到不了（见 transport.mjs 顶部说明）。
    transport: "agent-cli",
    title: "规划",
    build: ({ rawText, repo }) =>
      [
        "你是这个任务的规划者。只做规划，不要写代码。",
        "",
        "## 原始请求",
        rawText,
        repo ? `\n## 代码位置\n${repo}` : "",
        "",
        "## 输出要求",
        "1. 把任务拆成可独立执行的步骤",
        "2. 每步写明：改哪个文件、验收标准是什么",
        "3. 指出风险与不确定处",
        "4. 简洁，不要复述我的问题，不要客套",
      ]
        .filter(Boolean)
        .join("\n"),
  },

  code: {
    agentId: "dsh",
    // acp-poll：DSH 不是可注册的 harness，只能经 ACP 到达。
    // spawn 是异步的，所以由 taskctl 轮询会话库取结果（不经 LLM 转述）。
    transport: "acp-poll",
    title: "编码",
    build: ({ rawText, repo, workdir, planText, reviewText }) =>
      [
        "你是这个任务的实现者。",
        "",
        "## 原始请求",
        rawText,
        repo ? `\n## 代码位置\n${repo}` : "",
        workdir ? `\n## 工作目录（**这是权威值，不要另行推断**）\n${workdir}\n所有文件操作都在此目录内进行。` : "",
        planText ? `\n## 规划（供参考）\n${planText}` : "",
        reviewText
          ? `\n## 上一轮审查提出的问题（本次必须逐条处理）\n${reviewText}`
          : "",
        "",
        "## 输出要求",
        "1. 实际修改文件，不要只给建议",
        "2. 列出你改动的文件路径",
        "3. 说明你如何验证的（跑了什么命令、结果如何）",
        "4. 不要客套，不要复述我的问题",
      ]
        .filter(Boolean)
        .join("\n"),
  },

  review: {
    agentId: "codex",
    // agent-cli：codex 配了模型级 agentRuntime.id="codex"，走原生 Codex app-server harness。
    transport: "agent-cli",
    title: "审查",
    build: ({ rawText, repo, workdir, codeText }) =>
      [
        "你是这个任务的审查者。只审查，不要改代码。",
        "",
        "## 原始请求",
        rawText,
        repo ? `\n## 代码位置\n${repo}` : "",
        workdir ? `\n## 待审代码所在目录（**权威值，不要另行推断**）\n${workdir}` : "",
        codeText ? `\n## 实现者自述\n${codeText}` : "",
        "",
        "## 输出要求",
        "先写自然语言的审查意见（区分「严重」与「建议」），",
        "**最后必须输出一个围栏 JSON 块**，格式严格如下：",
        "",
        "```json",
        '{"passed": true, "severe": [], "suggestions": []}',
        "```",
        "",
        "- `passed`：无「严重」问题为 true，否则 false",
        "- `severe`：严重问题数组，每条一句话",
        "- `suggestions`：非阻塞建议数组",
        "",
        "这个 JSON 块会被程序解析，格式必须精确。不要输出多个 JSON 块。",
      ]
        .filter(Boolean)
        .join("\n"),
  },
};

/** 从审查输出里解析围栏 JSON。解析不出来就是不确定 —— 绝不猜。 */
export function parseReviewVerdict(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return { parsed: false, reason: "未找到 ```json 围栏块" };
  const raw = blocks[blocks.length - 1][1].trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { parsed: false, reason: `JSON 解析失败: ${e.message}` };
  }
  if (typeof obj.passed !== "boolean") {
    return { parsed: false, reason: "缺少布尔字段 passed" };
  }
  return {
    parsed: true,
    passed: obj.passed,
    severe: Array.isArray(obj.severe) ? obj.severe : [],
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
  };
}
