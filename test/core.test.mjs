import {
  ASSIGN_TOOL_OUTPUT_SCHEMA,
  ASSIGN_TOOL_PARAMETERS,
  assignTasks,
  normalizeConfig,
  normalizeProfiles,
  normalizeSelectionState,
} from "../lib/core.js";

const allowed = normalizeSelectionState({ enabled: true, allowedModels: [
  { provider: "ai395", model: "Qwen3.8-27B" },
  { provider: "ai395", model: "Qwen3.8-Flash-Next" },
  { provider: "ai4090", model: "GLM-5.3-Flash" },
]});

const mkCfg = (profiles, extra = {}) => normalizeConfig({ profiles, ...extra });
const simpleProfile = (id, name, provider, model, intelligence, concurrency = 1, extra = {}) =>
  ({ id, displayName: name, provider, model, intelligence, concurrency, enabled: true, ...extra });

// 常见三档模型
const ARCH = simpleProfile("arch", "架构师", "ai4090", "GLM-5.3-Flash", "high", 1, { reasoningEffort: "Max" });
const DEV = simpleProfile("dev", "程序員", "ai395", "Qwen3.8-Flash-Next", "medium", 1, { reasoningEffort: "xhigh" });
const RES = simpleProfile("res", "调查员", "ai395", "Qwen3.8-27B", "low", 1, { reasoningEffort: "xhigh" });

let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? " — " + detail : ""}`); };
const one = (cfg, task, load) =>
  assignTasks({ config: cfg, allowed, load, tasks: [{ task_summary: task }] });

console.log("1. 归一化");
{
  const cfg = normalizeConfig({
    profiles: [
      { id: "a", displayName: "A", provider: "ai395", model: "Qwen3.8-27B", intelligence: "high", concurrency: 2.7, speed: "high", tags: ["x"] },
      { id: "b", displayName: "B", provider: "ai395", model: "Qwen3.8-Flash-Next", intelligence: "medium", concurrency: 0, loadBalancing: "strict" },
      { id: "c", provider: "ai395", model: "Qwen3.8-27B", intelligence: "low", concurrency: -3 },
      { id: "d", provider: "", model: "x" }, // 路由不完整
    ],
    requireTagMatch: true,
    defaultProfileId: "zzz",
  });
  check("并发 2.7 → 2", cfg.profiles[0].concurrency === 2);
  check("并发 0 → 1", cfg.profiles[1].concurrency === 1);
  check("并发 -3 → 1", cfg.profiles[2].concurrency === 1);
  check("路由不完整丢弃", cfg.profiles.length === 3);
  check("旧字段清理：无 speed/tags/loadBalancing", cfg.profiles.every((p) => !("speed" in p) && !("tags" in p) && !("loadBalancing" in p)));
  check("旧顶层字段清理", !("requireTagMatch" in cfg) && !("defaultProfileId" in cfg));
}

console.log("2. 任务默认交给仍有空位的最高级模型");
{
  const cfg = mkCfg([ARCH, DEV, RES]);
  const r = one(cfg, "设计多租户沙箱架构（高）");
  check("单任务 → 最高级（架构师）", r.ok && r.assignments[0].profileId === "arch", JSON.stringify(r.assignments?.[0]));
  // 复杂度缺省 medium 也能安排
  const r2 = one(cfg, "随便一个任务");
  check("缺省复杂度的任务也默认给最高级", r2.assignments[0].profileId === "arch");
}

console.log("3. 批量并行：难的先占高级算力");
{
  const ARCH1 = simpleProfile("arch", "架构师", "ai4090", "GLM-5.3-Flash", "high", 1);
  const cfg = mkCfg([ARCH1, DEV, RES]);
  const r = assignTasks({ config: cfg, allowed, tasks: [
    { task_summary: "简单检索", complexity: "low" },
    { task_summary: "困难设计", complexity: "high" },
  ]});
  const bySummary = (s) => r.assignments.find((a) => a.taskSummary === s);
  check("难任务 → 高级", bySummary("困难设计")?.profileId === "arch");
  // 级联规则：高级满后顺延到"下一级"（中档），批量大时简单任务才会压到底部
  check("简单任务 → 顺延下一级（中档 dev）", bySummary("简单检索")?.profileId === "dev", bySummary("简单检索")?.profileId);
}

console.log("4. 满载顺延下一级");
{
  const ARCH1 = simpleProfile("arch", "架构师", "ai4090", "GLM-5.3-Flash", "high", 1);
  const cfg = mkCfg([ARCH1, DEV, RES]);
  const r = assignTasks({ config: cfg, allowed, tasks: [
    { task_summary: "设计 A", complexity: "high" },
    { task_summary: "设计 B", complexity: "high" },
  ]});
  check("第二个硬任务顺延到中/低", r.assignments[1].profileId !== "arch");
  check("并发计数正确", r.loadTable.find((e) => e.route === "ai4090/GLM-5.3-Flash")?.active === 1);
}

console.log("5. 错误路径");
{
  check("无档案 → no-profiles", !one(normalizeConfig({}), "x").ok && one(normalizeConfig({}), "x").code === "no-profiles");
  check("禁用 → disabled", !one(normalizeConfig({ enabled: false, profiles: [{ id: "a", displayName: "A", provider: "ai395", model: "Qwen3.8-27B", intelligence: "high" }] }), "x").ok);
  const cfg = mkCfg([ARCH, DEV, RES]);
  const empty = assignTasks({ config: cfg, allowed, tasks: [] });
  check("空任务 → no-tasks", !empty.ok && empty.code === "no-tasks");
  const ghostCfg = mkCfg([
    { id: "g1", displayName: "G1", provider: "ai999", model: "Ghost-1", intelligence: "high" },
  ]);
  const noEligible = assignTasks({ config: ghostCfg, allowed, tasks: [{ task_summary: "x" }] });
  check("有档案但路由全失配 → no-eligible-profiles", !noEligible.ok && noEligible.code === "no-eligible-profiles");
}

console.log("6. 阵列内最大 30 个任务");
{
  const cfg = mkCfg([{ ...ARCH, concurrency: 50 }]);
  const tasks = Array.from({ length: 40 }, (_, i) => ({ task_summary: `任务${i}`, complexity: "low" }));
  const r = assignTasks({ config: cfg, allowed, tasks });
  check("只接受前 30 个", r.totalTasks === 30);
  check("30 个任务 → 并发 50 的模型全收，无溢出", r.overflowed === 0 && r.assignments.length === 30);
}

console.log("7. 工具 schema 守卫（宿主 value-schema DSL 兼容性）");
{
  // 宿主 dsh-tools 的 DSL：object 节点只允许 type/properties/additionalProperties(+注解)，
  // required 数组一律不支持（参数只能用每属性 required: true 布尔）。
  // 违反即 defineTool 注册时抛错且被 effect 吞掉 → 工具静默消失（v0.3.0 事故）。
  const VALUE_KEYS = ["type", "properties", "items", "additionalProperties", "description", "title", "default", "examples", "enum", "const", "oneOf"];
  const walk = (node, pathName, isParam) => {
    for (const key of Object.keys(node)) {
      if (VALUE_KEYS.includes(key)) continue;
      if (key === "required" && isParam && node.required === true) continue;
      throw new Error(`${pathName}.${key} 不被宿主 value-schema DSL 支持`);
    }
    if (node.type === "object") {
      if (typeof node.additionalProperties !== "boolean") throw new Error(`${pathName}: object 节点必须显式声明 additionalProperties`);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${pathName}.${k}`, isParam);
    }
    if (node.type === "array") walk(node.items, `${pathName}.items`, isParam);
  };
  try {
    for (const [k, v] of Object.entries(ASSIGN_TOOL_PARAMETERS)) walk(v, `parameters.${k}`, true);
    walk(ASSIGN_TOOL_OUTPUT_SCHEMA, "output", false);
    check("schema 全部关键字在 DSL 允许范围内", true);
  } catch (error) {
    check("schema 全部关键字在 DSL 允许范围内", false, error.message);
  }
  let hasRequired = false;
  const findRequired = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(findRequired); return; }
    if ("required" in node) hasRequired = true;
    Object.values(node).forEach(findRequired);
  };
  findRequired(ASSIGN_TOOL_OUTPUT_SCHEMA);
  check("output schema 无 required（v0.3.0 事故回归守卫）", !hasRequired);
}

console.log("8. reasoning effort 大小写归一化");
{
  const profiles = normalizeProfiles([
    { id: "a", displayName: "A", provider: "ai395", model: "M1", reasoningEffort: "Max" },
    { id: "b", displayName: "B", provider: "ai395", model: "M2", reasoningEffort: "XHIGH" },
    { id: "c", displayName: "C", provider: "ai395", model: "M3", reasoningEffort: "custom-thing" },
    { id: "d", displayName: "D", provider: "ai395", model: "M4", reasoningEffort: "  " },
  ]);
  check("Max → max（宿主适配器大小写敏感）", profiles[0].reasoningEffort === "max", profiles[0].reasoningEffort);
  check("XHIGH → xhigh", profiles[1].reasoningEffort === "xhigh");
  check("未知自定义值原样保留", profiles[2].reasoningEffort === "custom-thing");
  check("空白 → 空串（不指定）", profiles[3].reasoningEffort === "");
}

console.log("9. 理由字段传达「高级优先」原则");
{
  const cfg = mkCfg([ARCH, DEV, RES]);
  const r = one(cfg, "简单检索任务"); // 复杂度缺省 medium
  check("简单任务默认给最高档", r.assignments[0].profileId === "arch", r.assignments[0].profileId);
  check("理由说明默认优先高级原则", r.assignments[0].reason.includes("默认优先高档") && r.assignments[0].reason.includes("可胜任"), r.assignments[0].reason);
  const full = assignTasks({ config: cfg, allowed, load: { "ai4090/GLM-5.3-Flash": 1 }, tasks: [{ task_summary: "另一个任务" }] });
  check("顺延理由说明上级已满", full.assignments[0].reason.includes("更高档已满"), full.assignments[0].reason);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
