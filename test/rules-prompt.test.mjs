import { buildPromptSection, normalizeConfig, normalizeSelectionState } from "../lib/core.js";

const allowed = normalizeSelectionState({ enabled: true, allowedModels: [
  { provider: "ai395", model: "Qwen3.8-27B" },
  { provider: "ai395", model: "Qwen3.8-Flash-Next" },
  { provider: "ai4090", model: "GLM-5.3-Flash" },
]});

const config = normalizeConfig({
  enabled: true,
  defaultProfileId: "p1",
  profiles: [
    { id: "p1", displayName: "调查员", provider: "ai395", model: "Qwen3.8-27B", intelligence: "low", speed: "high", tags: ["调查"] },
    { id: "p2", displayName: "架构师", provider: "ai4090", model: "GLM-5.3-Flash", intelligence: "high", speed: "high", tags: ["写作"] },
    { id: "p3", displayName: "程序員", provider: "ai395", model: "Qwen3.8-Flash-Next", intelligence: "medium", speed: "medium", tags: ["代码分析"] },
    { id: "p-ghost", displayName: "幽灵", provider: "ai999", model: "Ghost-Model", intelligence: "high", speed: "high", tags: ["调研"] },
  ],
  rules: [
    { id: "r-low", keywords: ["写作"], profileId: "p2", priority: 100, enabled: true },
    { id: "r-high", keywords: ["源码核验", "代码审查"], profileId: "p3", priority: 200, enabled: true },
    { id: "r-disabled", keywords: ["停用关键词"], profileId: "p1", priority: 500, enabled: false },
    { id: "r-missing", keywords: ["幽灵关键词"], profileId: "p-nope", priority: 400, enabled: true },
    { id: "r-stale", keywords: ["失配关键词"], profileId: "p-ghost", priority: 300, enabled: true },
  ],
});

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };

const section = buildPromptSection({ config, allowed });

console.log("规则渲染：");
check("段落生成", typeof section === "string");
check("包含 Keyword rules 标题行", section.includes("Keyword rules (strongest signal"));
check("高优先级规则渲染（源码核验 → 程序員）", section.includes("源码核验 / 代码审查 → 程序員 (ai395/Qwen3.8-Flash-Next)"));
check("低优先级规则渲染（写作 → 架构师）", section.includes("写作 → 架构师 (ai4090/GLM-5.3-Flash)"));

console.log("优先级排序：");
{
  const block = section.slice(section.indexOf("Keyword rules"));
  const iHigh = block.indexOf("源码核验");
  const iLow = block.indexOf("写作 →");
  check("高优先级(200)排在低优先级(100)之前", iHigh >= 0 && iLow > iHigh);
}

console.log("目标校验：");
check("停用规则不渲染", !section.includes("停用关键词"));
check("目标不存在的规则不渲染", !section.includes("幽灵关键词"));
check("目标失配的规则不渲染", !section.includes("失配关键词"));

console.log("失配档案过滤（一致性修复）：");
check("失配档案不再出现在 Profiles 列表", !section.includes("幽灵 →"));
check("其他档案正常渲染", section.includes("调查员 → ai395/Qwen3.8-27B"));

console.log("默认档案兜底：");
check("可用默认档案正常渲染", section.includes("Default profile when nothing matches: 调查员"));

console.log("边界：全部档案失配 → 不注入段落");
{
  const cfgAllStale = normalizeConfig({
    profiles: [{ id: "g", displayName: "G", provider: "ai999", model: "Ghost", tags: ["x"] }],
    rules: [{ id: "r", keywords: ["k"], profileId: "g", priority: 100, enabled: true }],
  });
  const s = buildPromptSection({ config: cfgAllStale, allowed });
  check("返回 null（无可用档案不误导模型）", s === null);
}

console.log("边界：默认档案失配 → 不渲染 Default 行");
{
  const cfgStaleDefault = normalizeConfig({
    defaultProfileId: "g",
    profiles: [
      { id: "p1", displayName: "调查员", provider: "ai395", model: "Qwen3.8-27B", tags: ["调查"] },
      { id: "g", displayName: "G", provider: "ai999", model: "Ghost", tags: ["x"] },
    ],
  });
  const s = buildPromptSection({ config: cfgStaleDefault, allowed });
  check("段落仍生成（有可用档案）", typeof s === "string" && s.includes("调查员"));
  check("不渲染失配的默认档案", !s.includes("Default profile"));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
