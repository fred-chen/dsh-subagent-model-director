// dsh-subagent-model-director — 纯逻辑核心（无依赖，可独立测试）
//
// 职责：
//   1. 归一化插件配置（模型档案 profiles / 路由规则 rules / 全局开关）
//   2. 读取并校验宿主 subagent 全局允许模型列表（subagent-model-selection）
//   3. 任务 → 模型档案的评分与择优（标签优先，其次复杂度/速度匹配，规则加权）
//   4. 生成注入父会话的系统提示词段落
//
// 本文件不得 import 任何外部模块，保证可以用 node 直接单测。

//#region 常量

const LEVELS = ["high", "medium", "low"];
const LEVEL_WEIGHT = { high: 3, medium: 2, low: 1 };

const GUIDANCE_MODES = ["off", "compact", "detailed"];

// 负载均衡：在"胜任集合"（与最高基础分相差 LOAD_BALANCE_BAND 以内）内，
// 按调整分 = 基础分 - 惩罚 × 进行中任务数 择优。
// off=不分摊；balanced=高分档案领先 1~2 个任务后轮换；strict=近乎轮换。
const LOAD_MODES = ["off", "balanced", "strict"];
const LOAD_PENALTY = { off: 0, balanced: 25, strict: 60 };
const LOAD_BALANCE_BAND = 45;

// 用户定义的分派标准（注入提示词 + 工具描述共用）
const RUBRIC_LINES = [
  "1. 硬核事实核查、调研、大量工具调用后阅读提取结论的任务 → 智能程度低、推理速度最快的模型。",
  "2. 分析代码、审核代码并需要推断得出结论、同时大量调用工具的任务 → 智能程度高或居中、速度较快的模型。",
  "3. 计划、设计类任务，需要创造性思维并结合已核查事实推理得出结论 → 智能程度最高的模型。",
];

//#endregion
//#region 归一化

function normalizeLevel(value, fallback = "medium") {
  return typeof value === "string" && LEVELS.includes(value) ? value : fallback;
}

function slugId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTagList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().slice(0, 24);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
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
      reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort.trim().slice(0, 32) : "",
      intelligence: normalizeLevel(raw.intelligence, "medium"),
      speed: normalizeLevel(raw.speed, "medium"),
      tags: normalizeTagList(raw.tags),
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
      keywords: normalizeTagList(raw.keywords, 16),
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
    requireTagMatch: cfg.requireTagMatch === true,
    loadBalancing: LOAD_MODES.includes(cfg.loadBalancing) ? cfg.loadBalancing : "balanced",
    defaultProfileId: typeof cfg.defaultProfileId === "string" ? cfg.defaultProfileId.trim().slice(0, 64) : "",
    profiles: normalizeProfiles(cfg.profiles),
    rules: normalizeRules(cfg.rules),
  };
}

//#endregion
//#region 全局允许模型列表（subagent-model-selection）

/**
 * 归一化从宿主 settings 读到的 subagent-model-selection 值。
 * @param descriptorValue 形如 { enabled: boolean, allowedModels: [{provider, model}] }
 */
function normalizeSelectionState(descriptorValue) {
  const value = descriptorValue && typeof descriptorValue === "object" && !Array.isArray(descriptorValue) ? descriptorValue : null;
  if (!value) {
    return { available: false, enabled: false, routes: [] };
  }
  // 已经是归一化形状（{ available, enabled, routes }）时直接吸收
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
  if (!Array.isArray(value.allowedModels)) {
    return { available: false, enabled: false, routes: [] };
  }
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
//#region 评分与分派

function levelDistance(a, b) {
  return Math.abs((LEVEL_WEIGHT[a] ?? 2) - (LEVEL_WEIGHT[b] ?? 2));
}

/** 规则命中：关键词出现在任务文本中即命中；priority 大者优先。 */
function ruleHits(rules, taskText, profileIds) {
  const text = String(taskText || "");
  if (!text) return [];
  const hits = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!rule.profileId || !profileIds.has(rule.profileId)) continue;
    if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) continue;
    const matched = rule.keywords.filter((keyword) => text.includes(keyword));
    if (matched.length > 0) hits.push({ rule, matched });
  }
  hits.sort((a, b) => b.rule.priority - a.rule.priority);
  return hits;
}

/**
 * 单档案评分。
 * 标签命中 +40/个；智能程度贴近 +30/-10·距离；速度贴近 +18/-6·距离；默认档案 +5。
 */
function scoreProfile(profile, criteria) {
  const reasons = [];
  let score = 0;
  // 标签命中 = 显式传入的任务标签精确匹配，或任务文本包含该标签（≥2 字符才做文本匹配，避免单字误命中）
  const haystack = criteria.taskText ? criteria.taskText.toLowerCase() : "";
  const tagHits = [];
  const textHits = [];
  for (const tag of profile.tags) {
    if (criteria.tags.includes(tag)) tagHits.push(tag);
    else if (haystack && tag.length >= 2 && haystack.includes(tag.toLowerCase())) textHits.push(tag);
  }
  const matchedTags = [...tagHits, ...textHits];
  if (matchedTags.length > 0) {
    score += 40 * matchedTags.length;
    const parts = [];
    if (tagHits.length > 0) parts.push(`指定标签：${tagHits.join("、")}`);
    if (textHits.length > 0) parts.push(`任务文本：${textHits.join("、")}`);
    reasons.push(`标签命中（${parts.join("；")}）`);
  }
  const di = levelDistance(profile.intelligence, criteria.intelligence);
  score += 30 - di * 10;
  if (di === 0) reasons.push(`智能程度匹配（${profile.intelligence}）`);
  const ds = levelDistance(profile.speed, criteria.speed);
  score += 18 - ds * 6;
  if (ds === 0) reasons.push(`速度匹配（${profile.speed}）`);
  if (criteria.defaultProfileId && profile.id === criteria.defaultProfileId) {
    score += 5;
    reasons.push("默认档案");
  }
  return { score, reasons, tagHits: matchedTags };
}

/**
 * 任务 → 模型档案分派。
 * @param input { config, allowed, taskText, tags, intelligence, speed }
 */
function assignProfile(input) {
  const cfg = normalizeConfig(input && input.config);
  if (!cfg.enabled) {
    return { ok: false, code: "disabled", message: "subagent-model-director 当前已停用" };
  }
  const allowed = normalizeSelectionState(input && input.allowed);
  const restricting = allowed.available && allowed.routes.length > 0;
  const pool = cfg.profiles
    .filter((profile) => profile.enabled !== false)
    .filter((profile) => !restricting || isRouteAllowed(allowed.routes, profile.provider, profile.model));
  if (pool.length === 0) {
    return {
      ok: false,
      code: cfg.profiles.length === 0 ? "no-profiles" : "no-eligible-profiles",
      message: cfg.profiles.length === 0
        ? "尚未定义任何模型档案，请先在插件设置页添加"
        : "没有符合条件的档案：已启用档案的路由都不在 subagent 全局允许列表内",
    };
  }

  const criteria = {
    tags: normalizeTagList(input && input.tags),
    intelligence: normalizeLevel(input && input.intelligence, "medium"),
    speed: normalizeLevel(input && input.speed, "high"),
    taskText: String((input && input.taskText) || ""),
    defaultProfileId: cfg.defaultProfileId,
  };
  const load = normalizeLoad(input && input.load);

  const profileIds = new Set(pool.map((profile) => profile.id));
  const hits = ruleHits(cfg.rules, criteria.taskText, profileIds);

  const scored = pool.map((profile) => {
    const base = scoreProfile(profile, criteria);
    let score = base.score;
    const reasons = [...base.reasons];
    const hit = hits.find((candidate) => candidate.rule.profileId === profile.id);
    if (hit) {
      score += 500 + hit.rule.priority;
      reasons.push(`规则命中（关键词：${hit.matched.join("、")}）`);
    }
    return { profile, score, reasons, tagHits: base.tagHits };
  });

  // 标签门控：开启 requireTagMatch 且存在标签命中档案时，只在命中集合里择优（规则命中的档案保留）。
  let gated = scored;
  let gateNote = "";
  if (cfg.requireTagMatch && criteria.tags.length > 0) {
    const tagMatched = scored.filter((entry) => entry.tagHits.length > 0 || entry.reasons.some((reason) => reason.startsWith("规则命中")));
    if (tagMatched.length > 0) {
      gated = tagMatched;
      gateNote = "已按任务标签过滤候选档案";
    }
  }

  // 负载均衡：胜任集合（与最高基础分相差 band 以内）内按 调整分 = 基础分 - 惩罚×负载 择优。
  // 集合外的高负载档案永远不会被"均衡"上来——弱档案不因空闲而胜出。
  const penalty = LOAD_PENALTY[cfg.loadBalancing] ?? 0;
  const loadOf = (entry) => {
    const value = load[`${entry.profile.provider}/${entry.profile.model}`];
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  for (const entry of gated) entry.load = loadOf(entry);

  const maxScore = Math.max(...gated.map((entry) => entry.score));
  const band = gated
    .filter((entry) => entry.score >= maxScore - LOAD_BALANCE_BAND)
    .map((entry) => ({ ...entry, adjusted: entry.score - penalty * entry.load }));

  band.sort((a, b) =>
    b.adjusted - a.adjusted ||
    b.score - a.score ||
    a.profile.displayName.localeCompare(b.profile.displayName) ||
    a.profile.id.localeCompare(b.profile.id)
  );
  const best = band[0];
  const topBase = [...band].sort((a, b) => b.score - a.score)[0];
  if (penalty > 0 && best.load > 0) {
    best.reasons.push(`负载均衡：该档案当前 ${best.load} 个进行中任务（-${penalty * best.load} 分后仍胜出）`);
  } else if (penalty > 0 && topBase.score > best.score) {
    best.reasons.push(`负载均衡：原始最高分档案已有 ${topBase.load} 个进行中任务，让位给负载更低的档案`);
  }
  const alternatives = band.slice(1, 3).map((entry) => ({
    profileId: entry.profile.id,
    displayName: entry.profile.displayName,
    provider: entry.profile.provider,
    model: entry.profile.model,
    reasoningEffort: entry.profile.reasoningEffort || "",
    score: entry.score,
    load: entry.load,
  }));
  const loadTable = band.map((entry) => ({
    route: `${entry.profile.provider}/${entry.profile.model}`,
    displayName: entry.profile.displayName || entry.profile.id,
    load: entry.load,
  }));

  if (best.score <= 0) {
    best.reasons.push("无标签/规则命中，按需求档位就近匹配");
  }

  return {
    ok: true,
    profileId: best.profile.id,
    displayName: best.profile.displayName,
    loadBalancing: cfg.loadBalancing,
    loadTable,
    route: {
      provider: best.profile.provider,
      model: best.profile.model,
      ...(best.profile.reasoningEffort ? { reasoningEffort: best.profile.reasoningEffort } : {}),
    },
    reasons: best.reasons,
    gateNote,
    alternatives,
  };
}

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
  // 失配档案在设置页标黄；提示词与规则都不应把父模型指向不可用的路由。
  const usable = cfg.profiles.filter(
    (profile) => profile.enabled !== false && (!restricting || isRouteAllowed(allowed.routes, profile.provider, profile.model))
  );
  if (usable.length === 0) return null;
  const usableIds = new Set(usable.map((profile) => profile.id));

  const lines = [];
  lines.push("## Subagent model assignment (model-director)");
  lines.push("When delegating with the `subagent` tool, you judge each task's complexity and type yourself, then pick the child model profile below:");
  if (allowed.available && allowed.routes.length > 0) {
    lines.push(`Allowed subagent routes (global policy${allowed.enabled ? ", enabled" : ""}): ${allowed.routes.map(formatRoute).join(", ")}.`);
  }
  lines.push("Profiles:");
  for (const profile of usable) {
    const name = profile.displayName || profile.id;
    const effort = profile.reasoningEffort ? ` · effort: ${profile.reasoningEffort}` : "";
    const tags = profile.tags.length > 0 ? ` · tags: ${profile.tags.join("/")}` : "";
    lines.push(`- ${name} → ${formatRoute(profile)}${effort} · intelligence=${profile.intelligence} speed=${profile.speed}${tags}`);
  }
  lines.push("Assignment rubric:");
  for (const rubric of RUBRIC_LINES) lines.push(rubric);
  lines.push("Tags first: when the task matches a profile tag, prefer those profiles, then break ties by intelligence/speed fit.");
  if (cfg.loadBalancing === "strict") {
    lines.push("Load balancing (strict) is on: spread qualifying tasks evenly across profiles — call `subagent_assign_model` before each delegation and follow its load-balanced recommendation.");
  } else if (cfg.loadBalancing === "balanced") {
    lines.push("Load balancing (balanced) is on: when several profiles qualify, prefer the less loaded ones — call `subagent_assign_model` before each delegation for the live tally and recommendation.");
  }
  if (cfg.requireTagMatch) lines.push("Tag matching is mandatory in this deployment: without a tag hit, fall back to the default profile or the closest match.");
  // 关键词规则：部署者定义的强信号，直接渲染给父模型（此前只影响工具评分，父模型不可见）。
  // 只渲染启用的、目标档案可用的规则；按优先级从高到低列出。
  const rules = cfg.rules
    .filter((rule) => rule.enabled !== false && rule.profileId && usableIds.has(rule.profileId) && rule.keywords.length > 0)
    .sort((a, b) => b.priority - a.priority);
  if (rules.length > 0) {
    lines.push("Keyword rules (strongest signal — when the delegated task text contains a keyword, assign the task to the mapped profile; listed highest priority first):");
    for (const rule of rules) {
      const target = cfg.profiles.find((profile) => profile.id === rule.profileId);
      const name = target ? target.displayName || target.id : rule.profileId;
      lines.push(`- ${rule.keywords.join(" / ")} → ${name} (${formatRoute(target)})`);
    }
  }
  if (cfg.defaultProfileId) {
    const fallback = usable.find((profile) => profile.id === cfg.defaultProfileId);
    if (fallback) lines.push(`Default profile when nothing matches: ${fallback.displayName || fallback.id} → ${formatRoute(fallback)}.`);
  }
  lines.push("Then pass `provider` and `model` (plus `reasoning_effort` when the profile sets one) on the subagent call. `subagent_fork` cannot select routes.");
  lines.push("Call `subagent_assign_model` with the task summary when unsure; it returns the recommended route and alternatives.");
  return lines.join("\n");
}

//#endregion

export {
  LEVELS,
  LEVEL_WEIGHT,
  GUIDANCE_MODES,
  LOAD_MODES,
  LOAD_PENALTY,
  LOAD_BALANCE_BAND,
  RUBRIC_LINES,
  normalizeLevel,
  normalizeTagList,
  normalizeProfiles,
  normalizeRules,
  normalizeConfig,
  normalizeSelectionState,
  normalizeLoad,
  isRouteAllowed,
  staleProfileIds,
  levelDistance,
  ruleHits,
  scoreProfile,
  assignProfile,
  buildPromptSection,
  formatRoute,
};
