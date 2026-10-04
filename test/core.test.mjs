import { assignProfile, buildPromptSection, normalizeConfig, normalizeSelectionState, staleProfileIds } from "../lib/core.js";

// 与用户环境一致的模拟数据
const allowed = normalizeSelectionState({
  enabled: true,
  allowedModels: [
    { provider: "ai395", model: "Qwen3.8-27B" },
    { provider: "ai395", model: "Qwen3.8-Flash-Next" },
    { provider: "ai4090", model: "GLM-5.3-Flash" },
  ],
});

const config = normalizeConfig({
  enabled: true,
  guidanceMode: "compact",
  requireTagMatch: false,
  profiles: [
    { id: "p-fast", displayName: "极速调研员", provider: "ai395", model: "Qwen3.8-Flash-Next", reasoningEffort: "low", intelligence: "low", speed: "high", tags: ["调研", "事实核查"] },
    { id: "p-code", displayName: "代码审查员", provider: "ai395", model: "Qwen3.8-27B", reasoningEffort: "xhigh", intelligence: "high", speed: "medium", tags: ["代码审查", "代码分析"] },
    { id: "p-writer", displayName: "写作专家", provider: "ai4090", model: "GLM-5.3-Flash", reasoningEffort: "max", intelligence: "high", speed: "low", tags: ["写作"] },
    { id: "p-planner", displayName: "首席规划师", provider: "ai4090", model: "GLM-5.3-Flash", reasoningEffort: "max", intelligence: "high", speed: "low", tags: ["计划", "设计"] },
    // 故意放一个不在允许列表里的档案
    { id: "p-ghost", displayName: "幽灵模型", provider: "ai999", model: "Ghost-Model", intelligence: "high", speed: "high", tags: ["调研"] },
  ],
  rules: [{ id: "r-sec", keywords: ["安全审计", "漏洞"], profileId: "p-code", priority: 200, enabled: true }],
});

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("场景 1：硬核事实核查（低智能+高速度）");
{
  const r = assignProfile({ config, allowed, taskText: "检索并核实 vLLM 0.9 的 tensor parallel 支持情况，大量网页阅读", intelligence: "low", speed: "high" });
  check("分派成功", r.ok);
  check("选中极速调研员（低智能高速度胜出）", r.profileId === "p-fast", `实际 ${r.profileId}`);
  check("理由包含智能匹配", r.reasons.some(x => x.includes("智能")));
}

console.log("场景 2：代码审查（高智能+中速度）");
{
  const r = assignProfile({ config, allowed, taskText: "审查 PR #42 的错误处理与边界条件，推断潜在竞态", intelligence: "high", speed: "medium" });
  check("选中代码审查员", r.profileId === "p-code", `实际 ${r.profileId}`);
}

console.log("场景 3：计划设计（最高智能）");
{
  const r = assignProfile({ config, allowed, taskText: "设计多租户插件沙箱架构，结合已核查事实做创造性方案", intelligence: "high", speed: "low" });
  check("选中首席规划师", r.profileId === "p-planner", `实际 ${r.profileId}`);
}

console.log("场景 4：标签匹配 —— 写作任务");
{
  const r = assignProfile({ config, allowed, taskText: "把这份 API 文档润色成面向开发者的教程", tags: ["写作"], intelligence: "medium", speed: "medium" });
  check("选中写作专家（标签命中）", r.profileId === "p-writer", `实际 ${r.profileId}`);
  check("理由包含标签命中", r.reasons.some(x => x.includes("标签命中")));
}

console.log("场景 5：多模型同 tag → 复杂度择优");
{
  // 两个档案都带“调研”标签：p-fast（低智能）与 p-ghost（高智能，但路由不合法应被排除）
  const cfg2 = normalizeConfig({
    profiles: [
      { id: "a", displayName: "A", provider: "ai395", model: "Qwen3.8-Flash-Next", intelligence: "low", speed: "high", tags: ["调研"] },
      { id: "b", displayName: "B", provider: "ai395", model: "Qwen3.8-27B", intelligence: "high", speed: "low", tags: ["调研"] },
    ],
  });
  const r = assignProfile({ config: cfg2, allowed, taskText: "深入调研并推理架构风险", tags: ["调研"], intelligence: "high", speed: "low" });
  check("同标签时按复杂度选中 B（高智能）", r.profileId === "b", `实际 ${r.profileId}`);
  const r2 = assignProfile({ config: cfg2, allowed, taskText: "快速核查版本号", tags: ["调研"], intelligence: "low", speed: "high" });
  check("同标签低复杂度选中 A", r2.profileId === "a", `实际 ${r2.profileId}`);
}

console.log("场景 6：规则关键词强加权");
{
  const r = assignProfile({ config, allowed, taskText: "对 auth 模块做安全审计，找漏洞", intelligence: "medium", speed: "high" });
  check("安全审计命中规则 → 代码审查员", r.profileId === "p-code", `实际 ${r.profileId}`);
  check("理由包含规则命中", r.reasons.some(x => x.includes("规则命中")));
}

console.log("场景 7：不允许列表校验");
{
  check("幽灵模型被判为 stale", staleProfileIds(config.profiles, allowed.routes).includes("p-ghost"));
  const r = assignProfile({ config, allowed, taskText: "测试幽灵", tags: ["调研"], intelligence: "high", speed: "high" });
  check("幽灵模型不参与分派", r.profileId !== "p-ghost");
}

console.log("场景 8：requireTagMatch 门控");
{
  const cfg3 = normalizeConfig({
    requireTagMatch: true,
    profiles: [
      { id: "tagged", displayName: "有标签", provider: "ai395", model: "Qwen3.8-27B", tags: ["调研"] },
      { id: "plain", displayName: "无标签", provider: "ai395", model: "Qwen3.8-Flash-Next" },
    ],
  });
  const r = assignProfile({ config: cfg3, allowed, taskText: "写作相关任务", tags: ["写作"], intelligence: "medium", speed: "medium" });
  check("无命中时回退到最接近档案而非报错", r.ok && r.profileId === "plain", `实际 ${r.profileId}`);
  const cfg4 = normalizeConfig({
    requireTagMatch: true,
    profiles: [
      { id: "tagged", displayName: "有标签", provider: "ai395", model: "Qwen3.8-27B", tags: ["调研"] },
      { id: "plain", displayName: "无标签", provider: "ai395", model: "Qwen3.8-Flash-Next" },
    ],
  });
  const r2 = assignProfile({ config: cfg4, allowed, taskText: "调研任务", tags: ["调研"], intelligence: "medium", speed: "medium" });
  check("有命中时门控到命中档案", r2.profileId === "tagged", `实际 ${r2.profileId}`);
}

console.log("场景 9：提示词段落");
{
  const section = buildPromptSection({ config, allowed });
  check("段落生成", typeof section === "string" && section.length > 100);
  check("包含允许列表", section.includes("ai395/Qwen3.8-27B"));
  check("包含档案表", section.includes("极速调研员"));
  check("包含分派标准", section.includes("事实核查"));
  const off = buildPromptSection({ config: { ...config, guidanceMode: "off" }, allowed });
  check("off 模式不注入", off === null);
}

console.log("场景 10：空配置与禁用");
{
  const r = assignProfile({ config: { profiles: [] }, allowed, taskText: "x" });
  check("无档案给出明确错误", !r.ok && r.code === "no-profiles");
  const r2 = assignProfile({ config: { ...config, enabled: false }, allowed, taskText: "x" });
  check("禁用返回 disabled", !r2.ok && r2.code === "disabled");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
