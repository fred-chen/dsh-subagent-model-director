// dsh-subagent-model-director — 宿主插件（v0.3.0）
//
// 让「产生 subagent 的那个会话的当前模型」按任务复杂度 + 模型智能分级与并发数分派：
//   1. 设置桥（/api/dsh-subagent-model-director/*）：浏览器端设置页读写模型档案与规则；
//      档案路由必须取自宿主 subagent 全局允许列表（subagent-model-selection 设置）。
//   2. 系统提示词段落：向父会话注入档案表（智能分级 + 并发数）+ 复杂度判据 + 分配策略。
//   3. subagent_assign_model 工具：批量分派——传入全部计划中的委派（任务+复杂度），
//      返回每个任务的 provider/model/reasoning_effort，并把各档案的并发计数更新为记账点。
//
// 分派本身不做硬拦截：subagent 工具的 provider/model 仍由父模型填写，
// 宿主的 exact-route 预检始终是最后一道闸门。

import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import {
  ASSIGN_TOOL_OUTPUT_SCHEMA,
  ASSIGN_TOOL_PARAMETERS,
  GUIDANCE_MODES,
  assignTasks,
  buildPromptSection,
  isRouteAllowed,
  normalizeConfig,
  normalizeProfiles,
  normalizeRules,
  normalizeSelectionState,
  staleProfileIds,
} from "./core.js";

const PLUGIN_VERSION = "0.3.1";
const NS = "subagent-model-director";
const BRIDGE_PREFIX = "/api/dsh-subagent-model-director";
// 宿主 subagent 全局允许模型列表所在的 settings 命名空间（entry id）。
const MODEL_SELECTION_NS = "subagent-model-selection-settings";

//#region 配置读写

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
  const wrap = (handler) => async (req, res) => {
    if (!guard(req, res)) return;
    try {
      await handler(req, res);
    } catch (error) {
      writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: wrap(async (req, res) => {
        writeJson(res, 200, await describe());
      }),
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/save`,
      handler: wrap(async (req, res) => {
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "bad-request", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await save(body));
      }),
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/assign`,
      handler: wrap(async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        writeJson(res, 200, assign(body));
      }),
    },
  ];
}

//#endregion
//#region 分派工具（批量）

function buildAssignTool({ current, getAllowed, getLoadSnapshot, recordRecommendations }) {
  return defineTool({
    name: "subagent_assign_model",
    description:
      "Allocate planned subagent delegations across the configured models with tier-and-concurrency-aware routing. Pass every task you are about to spawn as one entry in `tasks` (task_summary plus your complexity judgment: high = deep reasoning/design/planning/creative, medium = code analysis/review/root-cause with inference, low = search/fact-check/formatting). It returns the exact provider/model/reasoning_effort per task with reasons, and tracks each model's concurrency — higher tiers are preferred, hard tasks reserve the high tier first, and a full tier overflows to the next. Call it once per parallel batch before spawning, so capacities are respected and the tally stays accurate.",
    parameters: ASSIGN_TOOL_PARAMETERS,
    output: {
      schema: ASSIGN_TOOL_OUTPUT_SCHEMA,
      render(args, value) {
        const lines = [];
        if (!value.ok) {
          return [{ type: "text", text: `subagent_assign_model: ${value.note || "no allocation available"}` }];
        }
        lines.push(`分派结果（${value.totalTasks} 个任务 / 总并发 ${value.totalConcurrency}）：`);
        for (const item of value.assignments || []) {
          const who = item.displayName || item.profileId;
          const route = `${item.provider}/${item.model}${item.reasoningEffort ? `（effort ${item.reasoningEffort}）` : ""}`;
          const summary = String(item.taskSummary).slice(0, 80);
          lines.push(`- [${item.complexity}] ${summary} → ${who} (${route}) · ${item.reason}`);
        }
        if (value.overflowed > 0) {
          lines.push(`⚠ 任务数超过总并发：${value.overflowed} 个任务按难度与并发份额分配。`);
        }
        if (value.loadSummary) lines.push(value.loadSummary);
        lines.push("请把每个任务对应的 provider/model（及 reasoning_effort）填入相应的 subagent 调用。");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const load = getLoadSnapshot();
      const result = assignTasks({
        config: current(),
        allowed: getAllowed(),
        load,
        tasks: args?.tasks,
      });
      if (!result.ok) {
        return { ok: false, note: result.message || result.code || "assignment unavailable" };
      }
      // 记账：本次分配的各路由此轮计入负载（30 分钟半衰），下次分配自动向未满档案倾斜。
      recordRecommendations(result.assignments || []);
      const loadSummary = (result.loadTable ?? [])
        .map((entry) => `${entry.displayName}(${entry.route}) ${entry.active}/${entry.concurrency}`)
        .join(", ");
      return {
        ok: true,
        assignments: result.assignments,
        totalTasks: result.totalTasks,
        totalConcurrency: result.totalConcurrency,
        overflowed: result.overflowed,
        ...(loadSummary ? { loadSummary: `各模型并发状态：${loadSummary}` } : {}),
        ...(result.overflowed > 0 ? { note: `任务数超过总并发，${result.overflowed} 个任务按难度与并发份额分配` } : {}),
      };
    },
  });
}

//#endregion
//#region 插件

const ProfileSchema = z.object({
  id: z.string().default(""),
  displayName: z.string().default(""),
  provider: z.string().default(""),
  model: z.string().default(""),
  reasoningEffort: z.string().default(""),
  intelligence: z.string().default("medium"), // high | medium | low
  concurrency: z.number().default(1), // 可同时运行的任务数
  enabled: z.boolean().default(true),
});

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  guidanceMode: z.string().default("compact").volatile(), // off | compact | detailed
  profiles: z.array(ProfileSchema).default([]).volatile(),
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

  // ── 负载追踪（并发计数）────────────────────────────────────────────
  // 计数口径：subagent_assign_model 的分配次数（提示词会指示父模型批量委派前先调用本工具）。
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
  const recordRecommendations = (assignments) => {
    if (!Array.isArray(assignments)) return;
    decayLoad();
    const now = Date.now();
    for (const item of assignments) {
      if (!item || typeof item.provider !== "string" || typeof item.model !== "string") continue;
      const key = `${item.provider}/${item.model}`;
      const entry = loadCounters.get(key) ?? { count: 0, updatedAt: now };
      entry.count += 1;
      entry.updatedAt = now;
      loadCounters.set(key, entry);
    }
  };

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

  // 系统提示词 + 工具的动态刷新（配置变化时重建）
  let refreshPrompt = null;
  let refreshTool = null;
  const refresh = () => {
    if (typeof refreshPrompt === "function") refreshPrompt();
    if (typeof refreshTool === "function") refreshTool();
  };

  ctx.inject(["settings"], (sctx) => {
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
          const result = assignTasks({
            config: current(),
            allowed: getAllowed(),
            load: getLoadSnapshot(),
            tasks: body && Array.isArray(body.tasks) ? body.tasks : [],
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
      try {
        disposeTool = sctx.tools.register(
          buildAssignTool({ current, getAllowed, getLoadSnapshot, recordRecommendations })
        );
      } catch (error) {
        logger.warn(
          `subagent-model-director: subagent_assign_model 注册失败（${error instanceof Error ? error.message : String(error)}）——请检查工具 schema 与宿主 dsh-tools 的兼容性`
        );
      }
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
