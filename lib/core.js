// dsh-subagent-model-director — 纯逻辑核心（无依赖，可独立测试）
//
// 分派模型（v0.3.0）：
//   - 模型只按智能程度分级（high/medium/low），每个模型声明并发数 = 可同时运行的任务数。
//   - 高级模型能做低级模型的任何任务：任务默认交给"仍有空位的最上级模型"。
//   - 批量并行任务时按复杂程度排序——难的先占高级算力，简单的顺延到低一级。
//   - 某级满载 → 顺延下一级；所有模型满载（任务数超过总并发）→ 按难度与各模型
//     并发份额（负载/并发 比例）分配剩余任务。
//   - 关键词规则 = 可选硬性指定（目标档案有空位时优先，priority 大者优先）。
//
// 本文件不得 import 任何外部模块，保证可以用 node 直接单测。

//#region 常量

const LEVELS = ["high", "medium", "low"];
const TIER_WEIGHT = { high: 3, medium: 2, low: 1 };
const GUIDANCE_MODES = ["off", "compact", "detailed"];
// 复杂度 → 首选档位（溢出阶段使用）
const COMPLEXITY_TIER = { high: "high", medium: "medium", low: "low" };
const MAX_TASKS = 30;
const MAX_CONCURRENCY = 50;

// 复杂度判据（注入提示词 + 工具描述共用）
const RUBRIC_LINES = [
  "1. 需要深度推理 / 创造性 / 计划设计的任务（架构方案、复杂代码设计、创造性写作、跨源综合）→ 复杂度：高。",
  "2. 需要分析、审查与推断的任务（代码审查、根因排查、多源比对核验）→ 复杂度：中。",
  "3. 检索、事实核对、格式化、机械性整理等常规任务 → 复杂度：低。",
];

//#endregion
//#region 归一化

function normalizeLevel(value, fallback = "medium") {
  return typeof value === "string" && LEVELS.includes(value) ? value : fallback;
}

function slugId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// 宿主各适配器的 effort 校验是大小写敏感的（"Max" 会被拒，"max" 合法），
// 这里把常见档位归一化为小写；不在集合内的自定义值原样保留。
const EFFORT_CANONICAL = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

function normalizeEffort(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 32);
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  return EFFORT_CANONICAL.includes(lowered) ? lowered : trimmed;
}

function normalizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 1;
  return Math.min(Math.max(Math.floor(num), 1), MAX_CONCURRENCY);
}

function normalizeProfiles(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const provider = typeof raw.provider === "string" ? raw.provider.trim().slice(0, 120) : "";
    const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 160) : "";
    if (!provider || !model) continue; // 路由不完整的档案直接丢弃
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : "";
    while (!id || seen.has(id)) id = slugId("profile");
    seen.add(id);
    out.push({
      id,
      displayName: typeof raw.displayName === "string" ? raw.displayName.trim().slice(0, 80) : "",
      provider,
      model,
      reasoningEffort: normalizeEffort(raw.reasoningEffort),
      intelligence: normalizeLevel(raw.intelligence, "medium"),
      concurrency: normalizeConcurrency(raw.concurrency),
      enabled: raw.enabled !== false,
    });
  }
  return out;
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : "";
    while (!id || seen.has(id)) id = slugId("rule");
    seen.add(id);
    const priorityRaw = Number(raw.priority);
    out.push({
      id,
      keywords: (Array.isArray(raw.keywords) ? raw.keywords : [])
        .filter((item) => typeof item === "string")
        .map((item) => item.trim().slice(0, 24))
        .filter(Boolean)
        .slice(0, 16),
      profileId: typeof raw.profileId === "string" ? raw.profileId.trim().slice(0, 64) : "",
      priority: Number.isFinite(priorityRaw) ? Math.min(Math.max(Math.trunc(priorityRaw), 0), 1000) : 100,
      enabled: raw.enabled !== false,
    });
  }
  return out;
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: cfg.enabled !== false,
    guidanceMode: GUIDANCE_MODES.includes(cfg.guidanceMode) ? cfg.guidanceMode : "compact",
    profiles: normalizeProfiles(cfg.profiles),
    rules: normalizeRules(cfg.rules),
  };
}

/**
 * 归一化任务列表：每项 { id?, task_summary, complexity }，
 * complexity 缺省 "medium"；summary 去空白并截断；最多 MAX_TASKS 项。
 */
function normalizeTasks(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seenKeys = new Set();
  for (let i = 0; i < Math.min(value.length, MAX_TASKS); i++) {
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const summary = typeof raw.task_summary === "string" ? raw.task_summary.trim().slice(0, 400) : "";
    if (!summary) continue;
    let key = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : `t${i}`;
    let suffix = 0;
    while (seenKeys.has(key)) key = `${key}-${++suffix}`;
    seenKeys.add(key);
    out.push({ key, summary, complexity: normalizeLevel(raw.complexity, "medium") });
  }
  return out;
}

//#endregion
//#region 全局允许模型列表（subagent-model-selection）

function normalizeSelectionState(descriptorValue) {
  const value = descriptorValue && typeof descriptorValue === "object" && !Array.isArray(descriptorValue) ? descriptorValue : null;
  if (!value) return { available: false, enabled: false, routes: [] };
  if (Array.isArray(value.routes)) {
    const routes = [];
    const seen = new Set();
    for (const route of value.routes) {
      if (!route || typeof route.provider !== "string" || typeof route.model !== "string") continue;
      const key = `${route.provider}\u0000${route.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ provider: route.provider, model: route.model });
    }
    return { available: value.available === true, enabled: value.enabled === true, routes };
  }
  if (!Array.isArray(value.allowedModels)) return { available: false, enabled: false, routes: [] };
  const routes = [];
  const seen = new Set();
  for (const raw of value.allowedModels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (typeof raw.provider !== "string" || !raw.provider.trim()) continue;
    if (typeof raw.model !== "string" || !raw.model.trim()) continue;
    const route = { provider: raw.provider.trim(), model: raw.model.trim() };
    const key = `${route.provider}\u0000${route.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  return { available: true, enabled: value.enabled === true, routes };
}

/**
 * 归一化负载表：键 "provider/model"，值为非负整数；非法条目丢弃。
 */
function normalizeLoad(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 120) continue;
    if (typeof raw !== "number") continue;
    if (!Number.isFinite(raw) || raw <= 0) continue;
    out[key] = Math.floor(raw);
  }
  return out;
}

function isRouteAllowed(routes, provider, model) {
  if (!Array.isArray(routes)) return false;
  return routes.some((route) => route.provider === provider && route.model === model);
}

/** 档案路由校验：返回不在允许列表内的档案 id 列表。 */
function staleProfileIds(profiles, routes) {
  const stale = [];
  for (const profile of profiles) {
    if (!isRouteAllowed(routes, profile.provider, profile.model)) stale.push(profile.id);
  }
  return stale;
}

//#endregion
//#region 分派

/**
 * 批量分派：把一组任务分配给可用的模型档案。
 *
 * @param input { config, allowed, load, tasks }
 *   load: { "provider/model": 当前进行中任务数 }
 *   tasks: [{ id?, task_summary, complexity? }]
 * @returns 见 README：{ ok, assignments, totalTasks, totalConcurrency, overflowed, loadTable }
 */
function assignTasks(input) {
  const cfg = normalizeConfig(input && input.config);
  const allowed = normalizeSelectionState(input && input.allowed);
  const load = normalizeLoad(input && input.load);

  if (!cfg.enabled) {
    return { ok: false, code: "disabled", message: "subagent-model-director 当前已停用" };
  }
  const restricting = allowed.available && allowed.routes.length > 0;
  // 可用档案：已启用 + 路由在允许列表内，按 智能程度降序（高级优先）排序
  const eligible = cfg.profiles
    .filter((profile) => profile.enabled !== false)
    .filter((profile) => !restricting || isRouteAllowed(allowed.routes, profile.provider, profile.model))
    .sort(
      (a, b) =>
        TIER_WEIGHT[b.intelligence] - TIER_WEIGHT[a.intelligence] ||
        a.displayName.localeCompare(b.displayName) ||
        a.id.localeCompare(b.id)
    );
  if (eligible.length === 0) {
    return {
      ok: false,
      code: cfg.profiles.length === 0 ? "no-profiles" : "no-eligible-profiles",
      message: cfg.profiles.length === 0
        ? "尚未定义任何模型档案，请先在插件设置页添加"
        : "没有符合条件的档案：已启用档案的路由都不在 subagent 全局允许列表内",
    };
  }
  const tasks = normalizeTasks(input && input.tasks);
  if (tasks.length === 0) {
    return { ok: false, code: "no-tasks", message: "未提供待分派任务（tasks 为空）" };
  }

  const routeOf = (profile) => `${profile.provider}/${profile.model}`;
  const capacityOf = (profile) => profile.concurrency;
  // 每模型进行中数 = 既有负载 + 本批次已分配数
  const active = new Map(eligible.map((profile) => [profile.id, load[routeOf(profile)] ?? 0]));
  const freeOf = (profile) => Math.max(0, capacityOf(profile) - active.get(profile.id));

  // 关键词规则：命中 → 指定档案（有空位时）
  const pinOf = (task) => {
    let best = null;
    for (const rule of cfg.rules) {
      if (rule.enabled === false || !rule.profileId || rule.keywords.length === 0) continue;
      const target = eligible.find((profile) => profile.id === rule.profileId);
      if (!target) continue;
      if (rule.keywords.some((keyword) => task.summary.includes(keyword))) {
        if (!best || rule.priority > best.rule.priority) best = { rule, target };
      }
    }
    return best;
  };

  const assigned = [];
  const pending = [];

  // 处理顺序：规则命中的优先（按优先级）→ 复杂（高）的优先
  const ordered = [...tasks].sort((a, b) => {
    const pa = pinOf(a);
    const pb = pinOf(b);
    const paPriority = pa ? pa.rule.priority : -1;
    const pbPriority = pb ? pb.rule.priority : -1;
    if (paPriority !== pbPriority) return pbPriority - paPriority;
    return TIER_WEIGHT[b.complexity] - TIER_WEIGHT[a.complexity];
  });

  // 阶段一：容量内、高级优先
  for (const task of ordered) {
    const pin = pinOf(task);
    // 规则指定目标有空位 → 用之；否则（无规则/目标已满）按高级优先找第一个有空位者
    const pinned = pin && freeOf(pin.target) > 0 ? pin.target : null;
    const target = pinned ?? eligible.find((profile) => freeOf(profile) > 0); // eligible 已按高级优先排序
    if (target) {
      active.set(target.id, active.get(target.id) + 1);
      const reasons = [];
      if (pinned) {
        reasons.push(`规则指定：${pin.rule.keywords.join("、")}`);
      } else {
        if (pin) reasons.push(`规则目标 ${pin.target.displayName || pin.target.id} 已满，顺延`);
        reasons.push(
          target.intelligence === eligible[0].intelligence
            ? `上级（${target.intelligence}）有空位`
            : `${target.intelligence} 级：上级已满顺延`
        );
      }
      reasons.push(`并发 ${active.get(target.id)}/${capacityOf(target)}`);
      assigned.push({ task, model: target, reason: reasons.join("；") });
    } else {
      pending.push(task);
    }
  }

  // 阶段二：溢出（任务数 > 总并发）。按难度找同档模型，同档内选负载/并发 比例最低者；
  // 无同档模型时回退到全部档案（高级全能），越级越靠近该难度档越好。
  const totalConcurrency = eligible.reduce((sum, profile) => sum + capacityOf(profile), 0);
  for (const task of pending) {
    const desired = COMPLEXITY_TIER[task.complexity] ?? "high";
    let candidates = eligible.filter((profile) => profile.intelligence === desired);
    if (candidates.length === 0) {
      candidates = [...eligible].sort(
        (a, b) =>
          Math.abs(TIER_WEIGHT[a.intelligence] - TIER_WEIGHT[desired]) -
            Math.abs(TIER_WEIGHT[b.intelligence] - TIER_WEIGHT[desired]) ||
          TIER_WEIGHT[b.intelligence] - TIER_WEIGHT[a.intelligence]
      );
    }
    const ratioOf = (profile) => active.get(profile.id) / capacityOf(profile);
    const pick = [...candidates].sort(
      (a, b) =>
        ratioOf(a) - ratioOf(b) ||
        TIER_WEIGHT[b.intelligence] - TIER_WEIGHT[a.intelligence] ||
        a.displayName.localeCompare(b.displayName)
    )[0];
    active.set(pick.id, active.get(pick.id) + 1);
    assigned.push({
      task,
      model: pick,
      reason: `总并发已满（${tasks.length}/${totalConcurrency}）：按难度（${task.complexity}）与并发份额分配，现 ${active.get(pick.id)}/${capacityOf(pick)}`,
    });
  }

  // 按输入顺序还原
  const orderIndex = new Map(tasks.map((task, index) => [task.key, index]));
  assigned.sort((a, b) => orderIndex.get(a.task.key) - orderIndex.get(b.task.key));

  const loadTable = eligible.map((profile) => ({
    route: routeOf(profile),
    displayName: profile.displayName || profile.id,
    tier: profile.intelligence,
    concurrency: capacityOf(profile),
    active: active.get(profile.id),
  }));
  const assignments = assigned.map(({ task, model, reason }) => ({
    taskSummary: task.summary,
    complexity: task.complexity,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    profileId: model.id,
    displayName: model.displayName || model.id,
    tier: model.intelligence,
    reason,
  }));

  return {
    ok: true,
    assignments,
    totalTasks: tasks.length,
    totalConcurrency,
    overflowed: pending.length,
    loadTable,
  };
}

//#endregion
//#region 分派工具 schema（宿主 value-schema DSL 兼容）

// 注意：宿主 dsh-tools 的 value-schema DSL 不支持 JSON Schema 的 `required` 数组
// （参数用每属性 `required: true`，输出 schema 完全不能用 required）；
// object 节点必须显式声明 additionalProperties: true|false。改动前先跑测试守卫。
const ASSIGN_TOOL_PARAMETERS = {
  tasks: {
    type: "array",
    required: true,
    description: "Planned delegations (max 30).",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_summary: {
          type: "string",
          description: "One- or two-sentence summary of the task you are about to delegate.",
        },
        complexity: {
          type: "string",
          description: "high | medium | low. high = deep reasoning/design/planning/creative synthesis; medium = code analysis/review/root-cause with inference; low = search/fact-check/formatting/mechanical. Default medium.",
        },
      },
    },
  },
};

const ASSIGN_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskSummary: { type: "string" },
          complexity: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          reasoningEffort: { type: "string" },
          profileId: { type: "string" },
          displayName: { type: "string" },
          tier: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    totalTasks: { type: "number" },
    totalConcurrency: { type: "number" },
    overflowed: { type: "number" },
    loadSummary: { type: "string" },
    note: { type: "string" },
  },
};

//#endregion
//#region 系统提示词段落

function formatRoute(route) {
  return `${route.provider}/${route.model}`;
}

function buildPromptSection(input) {
  const cfg = normalizeConfig(input && input.config);
  if (!cfg.enabled || cfg.guidanceMode === "off" || cfg.profiles.length === 0) return null;
  const allowed = normalizeSelectionState(input && input.allowed);
  const restricting = allowed.available && allowed.routes.length > 0;

  // 只渲染"实际可用"的档案：已启用，且（允许列表可用时）路由在全局允许列表内。
  const usable = cfg.profiles
    .filter((profile) => profile.enabled !== false && (!restricting || isRouteAllowed(allowed.routes, profile.provider, profile.model)))
    .sort((a, b) => TIER_WEIGHT[b.intelligence] - TIER_WEIGHT[a.intelligence] || a.displayName.localeCompare(b.displayName));
  if (usable.length === 0) return null;
  const usableIds = new Set(usable.map((profile) => profile.id));

  const lines = [];
  lines.push("## Subagent model assignment (model-director)");
  lines.push("When delegating with the `subagent` tool, judge each task's complexity yourself, then pick the child model below.");
  if (allowed.available && allowed.routes.length > 0) {
    lines.push(`Allowed subagent routes (global policy${allowed.enabled ? ", enabled" : ""}): ${allowed.routes.map(formatRoute).join(", ")}.`);
  }
  lines.push("Models (intelligence tier · concurrency · route):");
  for (const profile of usable) {
    const name = profile.displayName || profile.id;
    const effort = profile.reasoningEffort ? ` · effort: ${profile.reasoningEffort}` : "";
    lines.push(`- ${name} → ${formatRoute(profile)}${effort} · tier=${profile.intelligence} concurrency=${profile.concurrency}`);
  }
  lines.push("Complexity rubric:");
  for (const rubric of RUBRIC_LINES) lines.push(rubric);
  lines.push("Policy:");
  lines.push("- Default routing: give each task to the highest tier that still has free capacity — even for simple tasks, because higher tiers can do anything lower tiers can.");
  lines.push("- Complexity (high/medium/low) sets batch priority, never a tier lock: in a parallel batch, judge each task's complexity and let the hardest claim the highest free tier first; simpler tasks then take the next tier down as higher tiers fill up.");
  lines.push("- Do not route a task to a lower tier while a higher tier still has free capacity (keyword rules are the only exception).");
  lines.push("- Each model runs up to its `concurrency` simultaneous tasks; a full tier overflows to the next tier; when everything is full, distribute the rest by difficulty and each model's concurrency share.");
  lines.push("- Call `subagent_assign_model` once with all planned delegations (task summary + complexity each) before spawning them; it returns the exact provider/model per task and tracks live concurrency.");
  const rules = cfg.rules
    .filter((rule) => rule.enabled !== false && rule.profileId && usableIds.has(rule.profileId) && rule.keywords.length > 0)
    .sort((a, b) => b.priority - a.priority);
  if (rules.length > 0) {
    lines.push("Keyword rules (strongest signal — when the task text contains a keyword, prefer the mapped profile while it has capacity; highest priority first):");
    for (const rule of rules) {
      const target = usable.find((profile) => profile.id === rule.profileId);
      const name = target ? target.displayName || target.id : rule.profileId;
      lines.push(`- ${rule.keywords.join(" / ")} → ${name} (${formatRoute(target)})`);
    }
  }
  lines.push("Then pass `provider` and `model` (plus `reasoning_effort` when the profile sets one) on each `subagent` call. `subagent_fork` cannot select routes.");
  return lines.join("\n");
}

//#endregion

export {
  LEVELS,
  TIER_WEIGHT,
  GUIDANCE_MODES,
  COMPLEXITY_TIER,
  RUBRIC_LINES,
  MAX_TASKS,
  MAX_CONCURRENCY,
  normalizeLevel,
  normalizeConcurrency,
  normalizeProfiles,
  normalizeRules,
  normalizeConfig,
  normalizeSelectionState,
  normalizeLoad,
  normalizeTasks,
  isRouteAllowed,
  staleProfileIds,
  assignTasks,
  buildPromptSection,
  formatRoute,
  normalizeEffort,
  EFFORT_CANONICAL,
  ASSIGN_TOOL_PARAMETERS,
  ASSIGN_TOOL_OUTPUT_SCHEMA,
};
