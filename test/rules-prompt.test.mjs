import { assignTasks, buildPromptSection, normalizeConfig, normalizeSelectionState } from "../lib/core.js";

const allowed = normalizeSelectionState({ enabled: true, allowedModels: [
  { provider: "ai395", model: "Qwen3.8-27B" },
  { provider: "ai395", model: "Qwen3.8-Flash-Next" },
  { provider: "ai4090", model: "GLM-5.3-Flash" },
]});

const mkCfg = (profiles, extra = {}) => normalizeConfig({ profiles, ...extra });
const P = (id, name, provider, model, intelligence, concurrency = 1, extra = {}) =>
  ({ id, displayName: name, provider, model, intelligence, concurrency, enabled: true, ...extra });
const ARCH = P("arch", "架构师", "ai4090", "GLM-5.3-Flash", "high", 1, { reasoningEffort: "Max" });
const DEV = P("dev", "程序員", "ai395", "Qwen3.8-Flash-Next", "medium", 1, { reasoningEffort: "xhigh" });
const RES = P("res", "调查员", "ai395", "Qwen3.8-27B", "low", 1);

let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? " — " + detail : ""}`); };

console.log("1. 关键词规则：指定目标（有空位时）");
{
  const cfg = mkCfg([ARCH, DEV, RES], {
    rules: [{ id: "r1", keywords: ["源码核验"], profileId: "dev", priority: 200, enabled: true }],
  });
  const r = assignTasks({ config: cfg, allowed, tasks: [{ task_summary: "源码核验两引擎事实", complexity: "high" }] });
  check("规则命中 → 程序員（即使高级有空位）", r.assignments[0].profileId === "dev", r.assignments[0].profileId);
  check("理由含规则", r.assignments[0].reason.includes("规则指定"));
}

console.log("2. 规则指定目标已满 → 正常级联");
{
  const cfg = mkCfg([{ ...ARCH, concurrency: 1 }, { ...DEV, concurrency: 1 }], {
    rules: [{ id: "r1", keywords: ["核验"], profileId: "dev", priority: 200, enabled: true }],
  });
  // dev 满：既有 1 个 + 新任务命中规则 → dev 无空位 → 交给 arch
  const r = assignTasks({ config: cfg, allowed, load: { "ai395/Qwen3.8-Flash-Next": 1 }, tasks: [{ task_summary: "核验 A", complexity: "medium" }] });
  check("目标满 → 级联到高级", r.assignments[0].profileId === "arch", r.assignments[0].profileId);
}

console.log("3. 多条规则命中 → 高优先级胜出");
{
  const cfg = mkCfg([ARCH, DEV], {
    rules: [
      { id: "rLow", keywords: ["审查"], profileId: "dev", priority: 50, enabled: true },
      { id: "rHigh", keywords: ["安全"], profileId: "arch", priority: 300, enabled: true },
    ],
  });
  const r = assignTasks({ config: cfg, allowed, tasks: [{ task_summary: "安全审查 auth 模块", complexity: "medium" }] });
  check("优先级 300 > 50 → arch", r.assignments[0].profileId === "arch", r.assignments[0].profileId);
}

console.log("4. 提示词段落：档案表含分级+并发，无 tag/速度");
{
  const cfg = mkCfg([ARCH, DEV, RES], { rules: [{ id: "r1", keywords: ["源码核验"], profileId: "dev", priority: 200, enabled: true }] });
  const section = buildPromptSection({ config: cfg, allowed });
  check("段落生成", typeof section === "string" && section.length > 100);
  check("含 tier 与 concurrency", section.includes("tier=high concurrency=1"));
  check("不含 speed/tags 旧字段", !section.includes("speed=") && !section.includes("· tags"));
  check("复杂度判据注入（中文复杂度行）", section.includes("复杂度"));
  check("含 Complex rubric", section.includes("Complexity rubric"));
  check("Policy：默认最高级有空位", section.includes("highest tier that still has free capacity"));
  check("Policy：复杂度不是档位锁", section.includes("never a tier lock"));
  check("Policy：禁止在有更高级空位时越级下放", section.includes("Do not route a task to a lower tier"));
  check("Policy：满载顺延与溢出说明", section.includes("overflow"));
  check("规则渲染", section.includes("源码核验") && section.includes("程序員"));
  check("允许列表渲染", section.includes("ai4090/GLM-5.3-Flash"));
  check("fork 提示", section.includes("subagent_fork"));
}

console.log("5. 提示词边界");
{
  const cfgOff = mkCfg([ARCH], { guidanceMode: "off" });
  check("off → null", buildPromptSection({ config: cfgOff, allowed }) === null);
  const cfgDisabled = mkCfg([ARCH], { enabled: false });
  check("disabled → null", buildPromptSection({ config: cfgDisabled, allowed }) === null);
  // 停用档案不渲染
  const cfgWithDisabled = mkCfg([{ ...ARCH, enabled: false }, DEV]);
  const s2 = buildPromptSection({ config: cfgWithDisabled, allowed });
  check("停用档案不渲染", s2 && !s2.includes("架构师 →"));
  // 失配档案不渲染 + 指向它的规则不渲染
  const ghost = P("ghost", "幽灵", "ai999", "Ghost-Model", "high");
  const cfgGhost = mkCfg([ARCH, ghost], { rules: [{ id: "rg", keywords: ["幽灵词"], profileId: "ghost", priority: 300, enabled: true }] });
  const s3 = buildPromptSection({ config: cfgGhost, allowed });
  check("失配档案不渲染", s3 && !s3.includes("幽灵"));
  check("指向失配档案的规则不渲染", s3 && !s3.includes("幽灵词"));
  // 全失配 → null
  const cfgAllStale = mkCfg([ghost]);
  check("全部失配 → null", buildPromptSection({ config: cfgAllStale, allowed }) === null);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
