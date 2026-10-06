import { assignTasks, normalizeConfig, normalizeSelectionState, normalizeLoad } from "../lib/core.js";

const allowed = normalizeSelectionState({ enabled: true, allowedModels: [
  { provider: "ai395", model: "Qwen3.8-27B" },
  { provider: "ai395", model: "Qwen3.8-Flash-Next" },
  { provider: "ai4090", model: "GLM-5.3-Flash" },
]});

const mkCfg = (profiles) => normalizeConfig({ profiles });
const P = (id, name, provider, model, intelligence, concurrency = 1, extra = {}) =>
  ({ id, displayName: name, provider, model, intelligence, concurrency, enabled: true, ...extra });
const ARCH = (n = 1, extra = {}) => P("arch", "架构师", "ai4090", "GLM-5.3-Flash", "high", n, extra);
const DEV = (n = 1, extra = {}) => P("dev", "程序員", "ai395", "Qwen3.8-Flash-Next", "medium", n, extra);
const RES = (n = 1, extra = {}) => P("res", "调查员", "ai395", "Qwen3.8-27B", "low", n, extra);
const T = (s, c) => ({ task_summary: s, complexity: c });

let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? " — " + detail : ""}`); };

console.log("1. 并发数限制：满则顺延");
{
  const cfg = mkCfg([ARCH(1), DEV(2)]);
  const r = assignTasks({ config: cfg, allowed, tasks: [T("高A", "high"), T("高B", "high"), T("高C", "high")] });
  const routes = r.assignments.map((a) => a.profileId);
  check("高级并发 1 → 只接 1 个", routes.filter((x) => x === "arch").length === 1);
  check("其余顺延中档（并发2全收）", routes.filter((x) => x === "dev").length === 2);
  check("无溢出", r.overflowed === 0);
}

console.log("2. 超过总并发 → 溢出按难度+并发份额");
{
  const cfg = mkCfg([ARCH(1), DEV(1), RES(1)]);
  const r = assignTasks({ config: cfg, allowed, tasks: [
    T("难1", "high"), T("难2", "high"), T("中1", "medium"), T("中2", "medium"), T("简1", "low"),
  ]});
  check("溢出 2 个", r.overflowed === 2, r.overflowed);
  const bySum = (s) => r.assignments.find((a) => a.taskSummary === s);
  check("难1→高级", bySum("难1")?.profileId === "arch");
  check("难2→中/低（高级满后顺延，恰好是 dev）", bySum("难2")?.profileId === "dev", bySum("难2")?.profileId);
  check("溢出任务全部落位", r.assignments.length === 5);
  check("负载表覆盖三档", r.loadTable.length === 3);
  // 每档各接 1，另外 2 个溢出按难度就近（中1/中2 → 高/低 的并发份额相对最低者）
  check("总并发 3，任务 5，分配正确计数", r.loadTable.reduce((s, e) => s + e.active, 0) === 5);
}

console.log("3. 既有负载参与判断（工具记账点）");
{
  const cfg = mkCfg([ARCH(1), DEV(1)]);
  // arch 已有 1 个进行中任务（来自之前的工具推荐）→ 新任务直接顺延 dev
  const r = assignTasks({ config: cfg, allowed, load: { "ai4090/GLM-5.3-Flash": 1 }, tasks: [T("新任务", "medium")] });
  check("arch 满载 → 新任务去 dev", r.assignments[0].profileId === "dev", r.assignments[0].profileId);
}

console.log("4. 负载归一化");
{
  const clean = normalizeLoad({ "a/b": 2.7, "c/d": -1, "e/f": 0, "g/h": "3", one: 1 });
  check("浮点取整", clean["a/b"] === 2);
  check("负数丢弃", !("c/d" in clean));
  check("零丢弃", !("e/f" in clean));
  check("字符串丢弃（只接受 number）", !("g/h" in clean));
  check("合法数字保留", clean["one"] === 1);
}

console.log("5. 并发数上限钳制");
{
  const cfg = normalizeConfig({ profiles: [P("a", "A", "ai395", "Qwen3.8-27B", "high", 9999)] });
  check("大于 50 → 50", cfg.profiles[0].concurrency === 50);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
