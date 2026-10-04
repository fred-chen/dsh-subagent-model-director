// dsh-subagent-model-director — 宿主插件
//
// 让「产生 subagent 的那个会话的当前模型」按任务复杂度/标签为每个 subagent 选择模型：
//   1. 设置桥（/api/dsh-subagent-model-director/*）：浏览器端设置页读写模型档案与规则；
//      档案路由必须取自宿主 subagent 全局允许列表（subagent-model-selection 设置）。
//   2. 系统提示词段落：向父会话注入档案表 + 分派标准（复杂度三档 + 标签优先）。
//   3. subagent_assign_model 工具：拿不准时由模型调用，返回推荐路由与备选。
//
// 分派本身不做硬拦截：subagent 工具的 provider/model 仍由父模型填写，
// 宿主的 exact-route 预检始终是最后一道闸门。

import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import {
  GUIDANCE_MODES,
  LOAD_MODES,
  assignProfile,
  buildPromptSection,
  isRouteAllowed,
  normalizeConfig,
  normalizeProfiles,
  normalizeRules,
  normalizeSelectionState,
  staleProfileIds,
} from "./core.js";

const PLUGIN_VERSION = "0.2.0";
const NS = "subagent-model-director";
const BRIDGE_PREFIX = "/api/dsh-subagent-model-director";
// 宿主 subagent 全局允许模型列表所在的 settings 命名空间（entry id）。
const MODEL_SELECTION_NS = "subagent-model-selection-settings";

//#region 配置读写

// Unwrap the live `Volatile<T>` references the Loader passes for `.volatile()`
// fields into a plain object, once per read.
function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

//#endregion
//#region 设置桥（HTTP routes）

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
}

function makeBridgeRoutes({ describe, save, assign }) {
  const guard = (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "use POST" });
      return false;
    }
    return true;
  };
  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          writeJson(res, 200, await describe());
        } catch (error) {
          writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/save`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const body = await readJsonBody(req);
          if (body === undefined) {
            writeJson(res, 400, { ok: false, code: "bad-request", message: "malformed JSON body" });
            return;
          }
          writeJson(res, 200, await save(body));
        } catch (error) {
          writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/assign`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const body = (await readJsonBody(req)) ?? {};
          writeJson(res, 200, await assign(body));
        } catch (error) {
          writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}

//#endregion
//#region 分派工具

function buildAssignTool({ current, getAllowed }) {
  return defineTool({
    name: "subagent_assign_model",
    description:
      "Pick the configured subagent model profile for a delegated task, with load balancing. Call it right before each `subagent` delegation when several profiles could fit (or whenever unsure): it returns the recommended provider/model/reasoning_effort, alternatives, reasons, and the live per-profile task tally — each call counts toward the tally so repeated delegations spread across qualifying profiles. You still make the final call — judge task complexity first (fact-checking/research vs code analysis/review vs planning/design) and match task tags before other attributes.",
    parameters: {
      task_summary: {
        type: "string",
        description: "One- or two-sentence summary of the task you are about to delegate (the task itself, not your plan).",
      },
      intelligence: {
        type: "string",
        description: "Required intelligence: high (planning/design/creative synthesis over verified facts), medium (code analysis/review with inference), low (fact-checking/research with many tool calls). Default medium.",
      },
      speed: {
        type: "string",
        description: "Required speed: high | medium | low. Default high.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Task tags to match against profile tags, e.g. 写作, 调研, 代码审查.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          provider: { type: "string" },
          model: { type: "string" },
          reasoningEffort: { type: "string" },
          profileId: { type: "string" },
          displayName: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
          alternatives: { type: "array", items: { type: "string" } },
          loadSummary: { type: "string" },
          note: { type: "string" },
        },
        required: ["ok"],
      },
      render(args, value) {
        if (!value.ok) {
          return [{ type: "text", text: `subagent_assign_model: ${value.note || "no recommendation available"}` }];
        }
        const lines = [];
        lines.push(`推荐档案：${value.displayName || value.profileId}`);
        lines.push(`路由：${value.provider}/${value.model}${value.reasoningEffort ? `（reasoning_effort: ${value.reasoningEffort}）` : ""}`);
        if (Array.isArray(value.reasons) && value.reasons.length > 0) {
          lines.push("理由：");
          for (const reason of value.reasons) lines.push(`- ${reason}`);
        }
        if (Array.isArray(value.alternatives) && value.alternatives.length > 0) {
          lines.push(`备选：${value.alternatives.join("；")}`);
        }
        if (value.loadSummary) {
          lines.push(value.loadSummary);
        }
        lines.push("请把该 provider/model（及 reasoning_effort）填入 subagent 调用的对应字段。");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const cfg = current();
      const allowed = getAllowed();
      const load = getLoadSnapshot();
      const result = assignProfile({
        config: cfg,
        allowed,
        load,
        taskText: args?.task_summary,
        tags: args?.tags,
        intelligence: args?.intelligence,
        speed: args?.speed,
      });
      if (!result.ok) {
        return { ok: false, note: result.message || result.code || "assignment unavailable" };
      }
      // 记账：本次推荐计入负载（30 分钟半衰），下次推荐自动向其它胜任档案倾斜。
      recordRecommendation(result.route.provider, result.route.model);
      const loadSummary = (result.loadTable ?? [])
        .map((entry) => `${entry.route}=${entry.load}`)
        .join(", ");
      return {
        ok: true,
        provider: result.route.provider,
        model: result.route.model,
        ...(result.route.reasoningEffort ? { reasoningEffort: result.route.reasoningEffort } : {}),
        profileId: result.profileId,
        displayName: result.displayName,
        reasons: result.reasons,
        alternatives: (result.alternatives ?? []).map((alt) => {
          const base = `${alt.displayName || alt.profileId} → ${alt.provider}/${alt.model}`;
          return Number.isFinite(alt.load) ? `${base}（进行中 ${alt.load}）` : base;
        }),
        ...(loadSummary ? { loadSummary: `进行中任务计数：${loadSummary}（本次推荐已计入 ${result.route.provider}/${result.route.model}）` } : {}),
        ...(result.gateNote ? { note: result.gateNote } : {}),
      };
    },
  });
}

//#endregion
//#region 插件

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  guidanceMode: z.string().default("compact").volatile(), // off | compact | detailed
  requireTagMatch: z.boolean().default(false).volatile(),
  loadBalancing: z.string().default("balanced").volatile(),
  defaultProfileId: z.string().default("").volatile(),
  profiles: z
    .array(
      z.object({
        id: z.string().default(""),
        displayName: z.string().default(""),
        provider: z.string().default(""),
        model: z.string().default(""),
        reasoningEffort: z.string().default(""),
        intelligence: z.string().default("medium"), // high | medium | low
        speed: z.string().default("medium"), // high | medium | low
        tags: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      })
    )
    .default([])
    .volatile(),
  rules: z
    .array(
      z.object({
        id: z.string().default(""),
        keywords: z.array(z.string()).default([]),
        profileId: z.string().default(""),
        priority: z.number().default(100),
        enabled: z.boolean().default(true),
      })
    )
    .default([])
    .volatile(),
});

function apply(ctx, config) {
  const current = () => normalizeConfig(resolveConfig(config));
  const logger = ctx.logger;

  // 读取宿主 subagent 全局允许模型列表（settings 服务可能晚于本插件挂载，运行期动态获取）
  const getAllowed = () => {
    let settings;
    try {
      settings = ctx.get("settings");
    } catch {
      settings = undefined;
    }
    if (!settings || typeof settings.describe !== "function") {
      return { available: false, enabled: false, routes: [] };
    }
    try {
      const descriptors = settings.describe({ redactSecrets: true });
      let descriptor = descriptors.find((candidate) => String(candidate.ns) === MODEL_SELECTION_NS);
      if (!descriptor) {
        descriptor = descriptors.find((candidate) => candidate.value && Array.isArray(candidate.value.allowedModels));
      }
      if (!descriptor) return { available: false, enabled: false, routes: [] };
      return normalizeSelectionState(descriptor.value);
    } catch (error) {
      logger.warn(`subagent-model-director: 读取 subagent 允许模型列表失败（${error instanceof Error ? error.message : String(error)}）`);
      return { available: false, enabled: false, routes: [] };
    }
  };

  // ── 负载追踪 ──────────────────────────────────────────────────────
  // 计数口径：subagent_assign_model 的推荐次数（提示词会指示父模型每次委派前先调用本工具）。
  // 30 分钟半衰：突发任务分摊后逐渐衰减；未走工具的直接委派不会计入（宁缺勿错）。
  const LOAD_DECAY_MS = 30 * 60 * 1000;
  const loadCounters = new Map(); // "provider/model" -> { count, updatedAt }
  const decayLoad = (now = Date.now()) => {
    for (const [key, entry] of loadCounters) {
      if (now - entry.updatedAt <= LOAD_DECAY_MS) continue;
      const halved = Math.floor(entry.count / 2);
      if (halved <= 0) loadCounters.delete(key);
      else {
        entry.count = halved;
        entry.updatedAt = now;
      }
    }
  };
  const getLoadSnapshot = () => {
    decayLoad();
    const out = {};
    for (const [key, entry] of loadCounters) {
      if (entry.count > 0) out[key] = entry.count;
    }
    return out;
  };
  const recordRecommendation = (provider, model) => {
    decayLoad();
    const key = `${provider}/${model}`;
    const entry = loadCounters.get(key) ?? { count: 0, updatedAt: Date.now() };
    entry.count += 1;
    entry.updatedAt = Date.now();
    loadCounters.set(key, entry);
  };

  // 生效档案：已启用 且（允许列表可用时）路由在列表内
  const eligibleProfiles = () => {
    const cfg = current();
    const allowed = getAllowed();
    const restricting = allowed.available && allowed.routes.length > 0;
    const valid = cfg.profiles.filter(
      (profile) => profile.enabled !== false && (!restricting || isRouteAllowed(allowed.routes, profile.provider, profile.model))
    );
    const stale = restricting ? staleProfileIds(cfg.profiles.filter((profile) => profile.enabled !== false), allowed.routes) : [];
    return { cfg, allowed, valid, stale };
  };

  // 系统提示词 + 工具的动态刷新（配置或允许列表变化时重建）
  let refreshPrompt = null;
  let refreshTool = null;
  const refresh = () => {
    if (typeof refreshPrompt === "function") refreshPrompt();
    if (typeof refreshTool === "function") refreshTool();
  };

  ctx.inject(["settings"], (sctx) => {
    // 本插件自带设置页，不要宿主自动生成表单
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
    sctx.on("settings/document-updated", (ns) => {
      const key = String(ns);
      if (key === NS || key.includes("subagent-model-selection")) refresh();
    });
  });

  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const myDescriptor = () =>
        sctx.settings
          .describe({ redactSecrets: true })
          .find((candidate) => String(candidate.ns) === NS);

      const handlers = {
        async describe() {
          const { cfg, allowed, stale } = eligibleProfiles();
          const descriptor = myDescriptor();
          return {
            ok: true,
            value: {
              ns: NS,
              version: PLUGIN_VERSION,
              revision: descriptor ? descriptor.revision : undefined,
              config: cfg,
              allowed,
              staleProfileIds: stale,
              load: getLoadSnapshot(),
            },
          };
        },
        async save(body) {
          if (body === null || typeof body !== "object") {
            return { ok: false, code: "bad-request", message: "malformed save request" };
          }
          const allowed = getAllowed();
          const restricting = allowed.available && allowed.routes.length > 0;
          const profiles = normalizeProfiles(body.profiles);
          if (restricting) {
            for (const profile of profiles) {
              if (!isRouteAllowed(allowed.routes, profile.provider, profile.model)) {
                return {
                  ok: false,
                  code: "route-not-allowed",
                  message: `模型 ${profile.provider}/${profile.model} 不在 subagent 全局允许列表中；请先在 设置 → 插件 → Subagent 的 Model selection 里维护允许列表`,
                };
              }
            }
          }
          const rules = normalizeRules(body.rules);
          const ids = new Set(profiles.map((profile) => profile.id));
          for (const rule of rules) {
            if (rule.profileId && !ids.has(rule.profileId)) {
              return { ok: false, code: "rule-target-missing", message: `规则指向的模型档案不存在：${rule.profileId}` };
            }
          }
          const ops = [
            { op: "set", path: ["enabled"], value: body.enabled !== false },
            { op: "set", path: ["guidanceMode"], value: GUIDANCE_MODES.includes(body.guidanceMode) ? body.guidanceMode : "compact" },
            { op: "set", path: ["requireTagMatch"], value: body.requireTagMatch === true },
            { op: "set", path: ["loadBalancing"], value: LOAD_MODES.includes(body.loadBalancing) ? body.loadBalancing : "balanced" },
            { op: "set", path: ["defaultProfileId"], value: typeof body.defaultProfileId === "string" ? body.defaultProfileId : "" },
            { op: "set", path: ["profiles"], value: profiles },
            { op: "set", path: ["rules"], value: rules },
          ];
          const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
          try {
            await sctx.settings.mutate(NS, ops, expectedRevision);
          } catch (error) {
            if (error instanceof SettingsConflictError) {
              return { ok: false, code: "settings-conflict", message: error.message };
            }
            return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
          }
          const descriptor = myDescriptor();
          const { cfg, allowed: freshAllowed, stale } = eligibleProfiles();
          return {
            ok: true,
            value: {
              ns: NS,
              version: PLUGIN_VERSION,
              revision: descriptor ? descriptor.revision : undefined,
              config: cfg,
              allowed: freshAllowed,
              staleProfileIds: stale,
              load: getLoadSnapshot(),
            },
          };
        },
        async assign(body) {
          const result = assignProfile({
            config: current(),
            allowed: getAllowed(),
            load: getLoadSnapshot(),
            taskText: body && typeof body.task === "string" ? body.task : "",
            tags: body && Array.isArray(body.tags) ? body.tags : [],
            intelligence: body && typeof body.intelligence === "string" ? body.intelligence : undefined,
            speed: body && typeof body.speed === "string" ? body.speed : undefined,
          });
          // 注意：设置页测试不计入负载统计（避免污染真实分摊）。
          return { ok: true, value: result };
        },
      };

      const disposers = makeBridgeRoutes(handlers).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "subagent-model-director: settings bridge");
  });

  ctx.inject(["systemPrompt"], (sctx) => {
    let disposeSection = null;
    refreshPrompt = () => {
      if (disposeSection) {
        disposeSection();
        disposeSection = null;
      }
      const { cfg, allowed } = eligibleProfiles();
      const text = buildPromptSection({ config: cfg, allowed });
      if (text) {
        disposeSection = sctx.systemPrompt.section({
          name: "subagent-model-director:profiles",
          order: 505,
          text,
        });
      }
    };
    sctx.effect(() => {
      refreshPrompt();
      return () => {
        if (disposeSection) {
          disposeSection();
          disposeSection = null;
        }
      };
    }, "subagent-model-director: dynamic profile prompt");
  });

  ctx.inject(["tools"], (sctx) => {
    let disposeTool = null;
    refreshTool = () => {
      if (disposeTool) {
        disposeTool();
        disposeTool = null;
      }
      if (!current().enabled) return;
      disposeTool = sctx.tools.register(buildAssignTool({ current, getAllowed }));
    };
    sctx.effect(() => {
      refreshTool();
      return () => {
        if (disposeTool) {
          disposeTool();
          disposeTool = null;
        }
      };
    }, "subagent-model-director: assign tool");
  });

  logger.info(
    `subagent-model-director: ready (${PLUGIN_VERSION}) — set profiles at Plugins → subagent-model-director`
  );
}

export { Config, apply, PLUGIN_VERSION, NS, BRIDGE_PREFIX };
