import { assignProfile, buildPromptSection, normalizeConfig, normalizeSelectionState, normalizeLoad } from "../lib/core.js";

const allowed = normalizeSelectionState({ enabled: true, allowedModels: [
  { provider: "ai395", model: "Qwen3.8-27B" },
  { provider: "ai395", model: "Qwen3.8-Flash-Next" },
  { provider: "ai4090", model: "GLM-5.3-Flash" },
]});

// 模拟用户当前配置：架构师与程序員共享代码类 tag（用户已加回）
const baseProfiles = [
  { id: "p1", displayName: "调查员", provider: "ai395", model: "Qwen3.8-27B", reasoningEffort: "xhigh", intelligence: "low", speed: "high", tags: ["调查","事实核查","工具调用","简单任务"] },
  { id: "p2", displayName: "架构师", provider: "ai4090", model: "GLM-5.3-Flash", reasoningEffort: "Max", intelligence: "high", speed: "high", tags: ["写作","架构设计","计划","代码分析","代码编写","troubleshooting"] },
  { id: "p3", displayName: "程序員", provider: "ai395", model: "Qwen3.8-Flash-Next", reasoningEffort: "xhigh", intelligence: "medium", speed: "medium", tags: ["代码分析","代码编写","troubleshooting"] },
];
const mkCfg = (over = {}) => normalizeConfig({ profiles: baseProfiles, ...over });

let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? " — " + detail : ""}`); };
const pick = (cfg, load, tags, intel = "high", speed = "high") =>
  assignProfile({ config: cfg, allowed, load, tags, intelligence: intel, speed, taskText: "任务" });

console.log("1. 共享 tag 下的轮换（balanced，架构师88 vs 程序員72）");
{
  const cfg = mkCfg();
  const seq = [];
  const counts = {};
  for (let i = 0; i < 4; i++) {
    const r = pick(cfg, counts, ["代码分析"]);
    seq.push(r.profileId);
    counts[`${r.route.provider}/${r.route.model}`] = (counts[`${r.route.provider}/${r.route.model}`] ?? 0) + 1;
  }
  console.log("    序列:", seq.join(" → "), "计数:", JSON.stringify(counts));
  check("首 selects 架构师（高分优先）", seq[0] === "p2", seq[0]);
  check("第2次轮换到程序員", seq[1] === "p3", seq[1]);
  check("第3次回到架构师", seq[2] === "p2", seq[2]);
  check("第4次轮换到程序員", seq[3] === "p3", seq[3]);
  check("两档案被平分（2:2）", counts["ai4090/GLM-5.3-Flash"] === 2 && counts["ai395/Qwen3.8-Flash-Next"] === 2);
}

console.log("2. off 模式：永远选最高分档案");
{
  const cfg = mkCfg({ loadBalancing: "off" });
  const r = pick(cfg, { "ai4090/GLM-5.3-Flash": 5 }, ["代码分析"]);
  check("高负载也不轮换", r.profileId === "p2", r.profileId);
}

console.log("3. strict 模式：更快轮换");
{
  const cfg = mkCfg({ loadBalancing: "strict" });
  // 基础分差 16（88 vs 72）：balanced 时架构师 1 个任务后仍领先（88-25=63 < 72? 不，63<72 → 轮换）
  // 用 base 差更大的场景区分：调查员(低智能) vs 程序員，代码任务下都不命中 tag… 改用：
  // 架构师(88) vs 程序員(72)，负载 {架构师:1}：balanced → 63 vs 72 → 程序員；strict → 28 vs 72 → 程序員。相同。
  // 区分场景：负载 {程序員:1}，无负载架构师：balanced → 88 vs 47 → 架构师；strict → 88 vs 12 → 架构师。也相同。
  // 区分点：base 差 ~40 的对：A=88(负载1) vs B=48(负载0)：balanced → 63 vs 48 → A；strict → 28 vs 48 → B。
  // A=88（tag+智能+速度全中），B=48（无 tag 但智能/速度全匹配）→ base 差 40，都在胜任集合内
  const cfg2 = normalizeConfig({ loadBalancing: "strict", profiles: [
    { id: "A", displayName: "A", provider: "ai4090", model: "GLM-5.3-Flash", intelligence: "high", speed: "high", tags: ["代码分析"] },
    { id: "B", displayName: "B", provider: "ai395", model: "Qwen3.8-Flash-Next", intelligence: "high", speed: "high", tags: [] },
  ]});
  const rStrict = pick(cfg2, { "ai4090/GLM-5.3-Flash": 1 }, ["代码分析"]);
  check("strict：A 1个任务后让位（28 vs 48）", rStrict.profileId === "B", rStrict.profileId);
  const cfg3 = normalizeConfig({ loadBalancing: "balanced", profiles: cfg2.profiles });
  const rBal = pick(cfg3, { "ai4090/GLM-5.3-Flash": 1 }, ["代码分析"]);
  check("balanced：同样负载下 A 仍胜（63 vs 48）", rBal.profileId === "A", rBal.profileId);
}

console.log("4. 胜任集合边界：弱档案不因空闲胜出");
{
  const cfg = normalizeConfig({ profiles: [
    { id: "A", displayName: "A", provider: "ai4090", model: "GLM-5.3-Flash", intelligence: "high", speed: "high", tags: ["代码分析"] },
    { id: "C", displayName: "C", provider: "ai395", model: "Qwen3.8-27B", intelligence: "low", speed: "low", tags: [] },
  ]});
  // A=88（tag+智能+速度全中），C≈30（差 58 > band 45，不在胜任集合）
  const r = pick(cfg, { "ai4090/GLM-5.3-Flash": 10 }, ["代码分析"]);
  check("A 负载 10 仍胜出（C 不在胜任集合）", r.profileId === "A", r.profileId);
}

console.log("5. 规则 > 负载：强信号不被均衡推翻");
{
  const cfg = normalizeConfig({ profiles: baseProfiles, rules: [
    { id: "r1", keywords: ["源码核验"], profileId: "p3", priority: 200, enabled: true },
  ]});
  const r = assignProfile({ config: cfg, allowed, load: { "ai395/Qwen3.8-Flash-Next": 3 }, tags: [], intelligence: "high", speed: "high", taskText: "源码核验两引擎事实" });
  check("规则命中档案负载 3 仍胜出", r.profileId === "p3", r.profileId);
}

console.log("6. normalizeLoad 清洗");
{
  const clean = normalizeLoad({ "a/b": 2.7, "c/d": -1, "e/f": 0, "g/h": "3", bad: 1 });
  check("浮点取整", clean["a/b"] === 2);
  check("负数丢弃", !("c/d" in clean));
  check("零丢弃", !("e/f" in clean));
  check("字符串数字丢弃（只接受 number）", !("g/h" in clean));
  check("合法数字键保留（键为不透明路由串）", clean["bad"] === 1);
}

console.log("7. 提示词策略行");
{
  const on = buildPromptSection({ config: mkCfg(), allowed });
  check("balanced 模式有策略行", on.includes("Load balancing (balanced) is on"));
  const strict = buildPromptSection({ config: mkCfg({ loadBalancing: "strict" }), allowed });
  check("strict 模式有专属措辞", strict.includes("Load balancing (strict) is on"));
  const off = buildPromptSection({ config: mkCfg({ loadBalancing: "off" }), allowed });
  check("off 模式无策略行", !off.includes("Load balancing"));
}

console.log("8. 结果结构：alternatives 带负载、理由带均衡说明");
{
  const cfg = mkCfg();
  const r = pick(cfg, { "ai4090/GLM-5.3-Flash": 1 }, ["代码分析"]);
  check("让位理由生成", r.reasons.some(x => x.includes("负载均衡") && x.includes("让位")), r.reasons.join("|"));
  check("alternatives 带 load 字段", r.alternatives.every(a => Number.isFinite(a.load)));
  check("loadTable 覆盖胜任集合", r.loadTable.length >= 2 && r.loadTable.every(e => Number.isFinite(e.load)));
  check("loadBalancing 模式回传", r.loadBalancing === "balanced");
}

console.log("9. 空负载回归：与均衡关闭时选择一致");
{
  const cfg = mkCfg();
  const r = pick(cfg, {}, ["代码分析"]);
  check("无计数时选最高分档案", r.profileId === "p2", r.profileId);
  check("无计数时不产生均衡理由", !r.reasons.some(x => x.includes("负载均衡")));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
