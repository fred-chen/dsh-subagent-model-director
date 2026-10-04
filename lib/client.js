window.__ModuleLoader__.load({
  id: "dsh-subagent-model-director",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    const createElement = react.createElement;
    const { useState, useEffect, useCallback } = react;

    const BRIDGE_PREFIX = "/api/dsh-subagent-model-director";
    const LEVEL_OPTIONS = [
      { value: "high", label: "高" },
      { value: "medium", label: "中" },
      { value: "low", label: "低" },
    ];
    const MODE_OPTIONS = [
      { value: "compact", label: "简洁（档案表+分派标准）" },
      { value: "detailed", label: "详细（含使用说明）" },
      { value: "off", label: "关闭（不注入提示词）" },
    ];
    const LOAD_OPTIONS = [
      { value: "balanced", label: "均衡（推荐）" },
      { value: "strict", label: "严格轮换" },
      { value: "off", label: "关闭" },
    ];
    const EFFORT_HINTS = "常用：off / low / medium / high / xhigh / max，留空表示不指定";

    //#region css
    const css = [
      ".dsmd-page{display:flex;flex-direction:column;gap:16px;color:inherit;font-size:14px;line-height:1.5}",
      ".dsmd-card{border:1px solid rgba(0,0,0,.08);border-radius:12px;background:rgba(255,255,255,.72);padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
      "@media (prefers-color-scheme: dark){.dsmd-card{background:rgba(30,30,32,.7);border-color:rgba(255,255,255,.08)}}",
      ".dsmd-title{font-weight:600;font-size:14px;margin:0}",
      ".dsmd-hint{color:#6e6e73;font-size:12px;margin:0}",
      "@media (prefers-color-scheme: dark){.dsmd-hint{color:#a1a1a6}}",
      ".dsmd-warn{color:#b45309;font-size:12px;margin:0}",
      "@media (prefers-color-scheme: dark){.dsmd-warn{color:#f59e0b}}",
      ".dsmd-error{color:#dc2626;font-size:12px;margin:0;white-space:pre-wrap}",
      "@media (prefers-color-scheme: dark){.dsmd-error{color:#f87171}}",
      ".dsmd-ok{color:#16a34a;font-size:12px;margin:0}",
      "@media (prefers-color-scheme: dark){.dsmd-ok{color:#4ade80}}",
      ".dsmd-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsmd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}",
      ".dsmd-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dsmd-label{font-size:12px;font-weight:500;display:flex;align-items:center;gap:6px}",
      ".dsmd-input,.dsmd-select,.dsmd-textarea{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;color:inherit;background:rgba(0,0,0,.03);width:100%;box-sizing:border-box}",
      ".dsmd-textarea{min-height:64px;resize:vertical}",
      "@media (prefers-color-scheme: dark){.dsmd-input,.dsmd-select,.dsmd-textarea{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.05)}}",
      ".dsmd-input:focus-visible,.dsmd-select:focus-visible,.dsmd-textarea:focus-visible{outline:none;border-color:#0071e3}",
      ".dsmd-btn{border:1px solid rgba(0,0,0,.14);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:inherit}",
      ".dsmd-btn:hover:not(:disabled){background:rgba(0,0,0,.05)}",
      "@media (prefers-color-scheme: dark){.dsmd-btn:hover:not(:disabled){background:rgba(255,255,255,.07)}}",
      ".dsmd-btnPrimary{background:#0071e3;border-color:#0071e3;color:#fff}",
      ".dsmd-btnPrimary:hover:not(:disabled){background:#0a84ff}",
      ".dsmd-btnDanger{color:#dc2626}",
      "@media (prefers-color-scheme: dark){.dsmd-btnDanger{color:#f87171}}",
      ".dsmd-btn:disabled{opacity:.5;cursor:default}",
      ".dsmd-profile{border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}",
      "@media (prefers-color-scheme: dark){.dsmd-profile{border-color:rgba(255,255,255,.1)}}",
      ".dsmd-profileStale{border-color:#f59e0b}",
      ".dsmd-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,.15);color:#b45309}",
      "@media (prefers-color-scheme: dark){.dsmd-badge{color:#f59e0b}}",
      ".dsmd-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,113,227,.12);color:#0071e3}",
      ".dsmd-result{border:1px dashed rgba(0,0,0,.15);border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap;word-break:break-word}",
      "@media (prefers-color-scheme: dark){.dsmd-result{border-color:rgba(255,255,255,.18)}}",
      ".dsmd-toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}",
      ".dsmd-empty{color:#6e6e73;font-size:13px;font-style:italic}",
    ];
    (function injectCss() {
      if (typeof document === "undefined") return;
      const existing = document.getElementById("dsmd-styles");
      if (existing) return;
      const style = document.createElement("style");
      style.id = "dsmd-styles";
      style.textContent = css.join("\n");
      document.head.appendChild(style);
    })();
    //#endregion

    // 统一桥接调用：网络失败 / 非 2xx / 非 JSON 响应都转成
    // { ok: false, code, message }，让界面能显示具体原因而不是笼统的“调用失败”。
    async function bridgeCall(path, payload) {
      let response;
      try {
        response = await fetch(`${BRIDGE_PREFIX}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        });
      } catch (error) {
        return { ok: false, code: "network", message: "无法连接宿主接口：" + (error && error.message ? error.message : String(error)) };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail = body && (body.message || body.error);
        return { ok: false, code: "http-" + response.status, message: `接口返回 ${response.status}${detail ? "：" + detail : ""}` };
      }
      if (body === null || typeof body !== "object") {
        return { ok: false, code: "bad-response", message: "接口返回了无法解析的内容（宿主插件版本可能与页面不一致，请重载后重试）" };
      }
      return body;
    }
    const bridgeDescribe = () => bridgeCall("/describe", {});
    const bridgeSave = (payload) => bridgeCall("/save", payload);
    const bridgeAssign = (payload) => bridgeCall("/assign", payload);

    function newId(prefix) {
      return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    }
    function parseTags(text) {
      return String(text || "")
        .split(/[,，、]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 12);
    }
    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function Field(props) {
      return createElement(
        "label",
        { className: "dsmd-field" },
        createElement("span", { className: "dsmd-label" }, props.label),
        props.children,
        props.hint ? createElement("span", { className: "dsmd-hint" }, props.hint) : null
      );
    }
    function TextInput(props) {
      return createElement("input", {
        className: "dsmd-input",
        value: props.value ?? "",
        placeholder: props.placeholder || "",
        onChange: (event) => props.onChange(event.target.value),
      });
    }
    function Select(props) {
      return createElement(
        "select",
        { className: "dsmd-select", value: props.value ?? "", onChange: (event) => props.onChange(event.target.value) },
        createElement("option", { value: "" }, props.placeholder || "（请选择）"),
        (props.options || []).map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label)
        )
      );
    }
    function Toggle(props) {
      return createElement(
        "label",
        { className: "dsmd-toggle" },
        createElement("input", {
          type: "checkbox",
          checked: props.checked === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        props.label
      );
    }

    function routeOptions(allowed) {
      const routes = (allowed && Array.isArray(allowed.routes) ? allowed.routes : []);
      const providers = [];
      for (const route of routes) {
        if (!providers.includes(route.provider)) providers.push(route.provider);
      }
      return providers.map((provider) => ({
        value: provider,
        label: provider,
        models: routes.filter((route) => route.provider === provider).map((route) => ({
          value: route.model,
          label: route.model,
        })),
      }));
    }

    function ProfileCard(props) {
      const { profile, index, allowed, stale, liveLoad, onChange, onRemove } = props;
      const providers = routeOptions(allowed);
      const hasRoutes = providers.length > 0;
      const providerEntry = providers.find((entry) => entry.value === profile.provider);
      const modelOptions = providerEntry ? providerEntry.models : [];
      const routeKnown = hasRoutes && providerEntry && modelOptions.some((option) => option.value === profile.model);
      const update = (patch) => onChange(index, patch);
      return createElement(
        "div",
        { className: `dsmd-profile${stale ? " dsmd-profileStale" : ""}` },
        createElement(
          "div",
          { className: "dsmd-row" },
          createElement("strong", null, profile.displayName || profile.id || `档案 ${index + 1}`),
          stale ? createElement("span", { className: "dsmd-badge" }, "不在允许列表") : null,
          !profile.enabled ? createElement("span", { className: "dsmd-chip" }, "已停用") : null,
          (profile.enabled !== false && liveLoad && Number.isFinite(liveLoad[`${profile.provider}/${profile.model}`]))
            ? createElement("span", { className: "dsmd-chip" }, `进行中 ${liveLoad[`${profile.provider}/${profile.model}`]}`)
            : null,
          createElement("span", { style: { flex: 1 } }),
          createElement("button", {
            className: "dsmd-btn dsmd-btnDanger",
            type: "button",
            onClick: () => onRemove(index),
          }, "删除")
        ),
        createElement(
          "div",
          { className: "dsmd-grid" },
          createElement(Field, { label: "显示名称" },
            createElement(TextInput, {
              value: profile.displayName,
              placeholder: "例如：技术调研与事实核查",
              onChange: (value) => update({ displayName: value }),
            })),
          createElement(Field, { label: "Provider", hint: hasRoutes ? undefined : "全局允许列表不可用，直接输入 provider id" },
            hasRoutes
              ? createElement(Select, {
                  value: profile.provider,
                  options: providers,
                  placeholder: "（请选择 provider）",
                  onChange: (value) => {
                    const next = providers.find((entry) => entry.value === value);
                    const keepModel = next && next.models.some((option) => option.value === profile.model);
                    update({ provider: value, model: keepModel ? profile.model : (next && next.models[0] ? next.models[0].value : "") });
                  },
                })
              : createElement(TextInput, { value: profile.provider, onChange: (value) => update({ provider: value }) })),
          createElement(Field, { label: "Model" },
            hasRoutes
              ? createElement(Select, {
                  value: profile.model,
                  options: routeKnown ? modelOptions : [...modelOptions, { value: profile.model, label: `${profile.model}（当前值）` }],
                  placeholder: "（请选择 model）",
                  onChange: (value) => update({ model: value }),
                })
              : createElement(TextInput, { value: profile.model, onChange: (value) => update({ model: value }) })),
          createElement(Field, { label: "智能程度", hint: "高=计划/设计/创造 · 中=代码分析/审查 · 低=调研/事实核查" },
            createElement(Select, {
              value: profile.intelligence || "medium",
              options: LEVEL_OPTIONS,
              placeholder: "",
              onChange: (value) => update({ intelligence: value || "medium" }),
            })),
          createElement(Field, { label: "推理速度" },
            createElement(Select, {
              value: profile.speed || "medium",
              options: LEVEL_OPTIONS,
              placeholder: "",
              onChange: (value) => update({ speed: value || "medium" }),
            })),
          createElement(Field, { label: "Reasoning effort", hint: EFFORT_HINTS },
            createElement(TextInput, {
              value: profile.reasoningEffort || "",
              placeholder: "留空=模型默认",
              onChange: (value) => update({ reasoningEffort: value }),
            })),
          createElement(Field, { label: "标签（逗号分隔）", hint: "任务命中标签的档案会被优先选中，例如：写作, 调研, 代码审查" },
            createElement(TextInput, {
              value: (profile.tags || []).join(", "),
              onChange: (value) => update({ tags: parseTags(value) }),
            }))
        ),
        createElement(Toggle, {
          checked: profile.enabled !== false,
          label: "启用该档案",
          onChange: (value) => update({ enabled: value }),
        })
      );
    }

    function RuleRow(props) {
      const { rule, index, profiles, onChange, onRemove } = props;
      const update = (patch) => onChange(index, patch);
      const options = profiles.map((profile) => ({
        value: profile.id,
        label: profile.displayName || profile.id,
      }));
      return createElement(
        "div",
        { className: "dsmd-profile" },
        createElement(
          "div",
          { className: "dsmd-grid" },
          createElement(Field, { label: "目标档案" },
            createElement(Select, {
              value: rule.profileId,
              options,
              placeholder: "（请选择档案）",
              onChange: (value) => update({ profileId: value }),
            })),
          createElement(Field, { label: "优先级", hint: "数值越大越优先（默认 100）" },
            createElement(TextInput, {
              value: String(rule.priority ?? 100),
              onChange: (value) => update({ priority: Number(value) || 0 }),
            })),
          createElement(Field, { label: "关键词（逗号分隔）", hint: "任务描述中出现任一关键词即命中该规则" },
            createElement(TextInput, {
              value: (rule.keywords || []).join(", "),
              onChange: (value) => update({ keywords: parseTags(value) }),
            }))
        ),
        createElement(
          "div",
          { className: "dsmd-row" },
          createElement(Toggle, { checked: rule.enabled !== false, label: "启用", onChange: (value) => update({ enabled: value }) }),
          createElement("span", { style: { flex: 1 } }),
          createElement("button", { className: "dsmd-btn dsmd-btnDanger", type: "button", onClick: () => onRemove(index) }, "删除")
        )
      );
    }

    function DirectorCard() {
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState("");
      const [saved, setSaved] = useState(false);
      const [taskText, setTaskText] = useState("");
      const [testResult, setTestResult] = useState(null);
      const [testing, setTesting] = useState(false);

      const load = useCallback(async () => {
        const result = await bridgeDescribe();
        if (result && result.ok) {
          setData(result.value);
          setDraft(clone(result.value.config));
        } else {
          setError("无法读取插件配置：" + ((result && result.message) || "unknown"));
        }
        setLoading(false);
      }, []);
      useEffect(() => { void load(); }, [load]);

      const save = useCallback(async () => {
        if (!draft) return;
        setSaving(true);
        setError("");
        setSaved(false);
        const result = await bridgeSave({
          enabled: draft.enabled,
          guidanceMode: draft.guidanceMode,
          requireTagMatch: draft.requireTagMatch,
          loadBalancing: draft.loadBalancing,
          defaultProfileId: draft.defaultProfileId,
          profiles: draft.profiles,
          rules: draft.rules,
          expectedRevision: data && data.revision,
        });
        if (result && result.ok) {
          setData(result.value);
          setDraft(clone(result.value.config));
          setSaved(true);
        } else {
          const code = result && result.code;
          if (code === "settings-conflict") {
            setError("配置已被其他窗口修改（revision 冲突），已重新加载最新值，请合并后再保存。");
            await load();
          } else {
            setError((result && result.message) || "保存失败");
          }
        }
        setSaving(false);
      }, [draft, data, load]);

      const runTest = useCallback(async () => {
        if (!taskText.trim()) return;
        setTesting(true);
        const result = await bridgeAssign({ task: taskText });
        setTestResult(result && result.ok ? result.value : { ok: false, message: (result && result.message) || "调用失败" });
        setTesting(false);
      }, [taskText]);

      if (loading) {
        return createElement("div", { className: "dsmd-page" }, createElement("p", { className: "dsmd-hint" }, "加载中…"));
      }
      if (!draft) {
        return createElement("div", { className: "dsmd-page" }, createElement("p", { className: "dsmd-error" }, error || "配置不可用"));
      }

      const allowed = data && data.allowed ? data.allowed : { available: false, enabled: false, routes: [] };
      const staleIds = new Set((data && data.staleProfileIds) || []);
      const update = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
      const updateProfile = (index, patch) =>
        setDraft((prev) => ({
          ...prev,
          profiles: prev.profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile)),
        }));
      const addProfile = () =>
        setDraft((prev) => ({
          ...prev,
          profiles: [
            ...prev.profiles,
            {
              id: newId("profile"),
              displayName: "",
              provider: "",
              model: "",
              reasoningEffort: "",
              intelligence: "medium",
              speed: "medium",
              tags: [],
              enabled: true,
            },
          ],
        }));
      const removeProfile = (index) =>
        setDraft((prev) => ({ ...prev, profiles: prev.profiles.filter((_, i) => i !== index) }));
      const updateRule = (index, patch) =>
        setDraft((prev) => ({
          ...prev,
          rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
        }));
      const addRule = () =>
        setDraft((prev) => ({
          ...prev,
          rules: [...prev.rules, { id: newId("rule"), keywords: [], profileId: "", priority: 100, enabled: true }],
        }));
      const removeRule = (index) =>
        setDraft((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));

      const activeProfiles = draft.profiles.filter((profile) => profile.enabled !== false);
      const defaultOptions = activeProfiles.map((profile) => ({
        value: profile.id,
        label: profile.displayName || profile.id,
      }));

      return createElement(
        "div",
        { className: "dsmd-page" },
        createElement(
          "div",
          { className: "dsmd-card" },
          createElement("p", { className: "dsmd-hint" },
            allowed.available && allowed.routes.length > 0
              ? `全局 subagent 允许模型：${allowed.routes.length} 条路由（策略${allowed.enabled ? "已启用" : "未启用"}）。模型档案只能从这个列表中选择。`
              : "尚未读到全局 subagent 允许模型列表。请先到 设置 → 插件 → Subagent 的 Model selection 里启用并选择允许的模型，再回来配置档案。"),
          staleIds.size > 0
            ? createElement("p", { className: "dsmd-warn" }, `${staleIds.size} 个档案的路由已不在允许列表中，运行时会跳过它们。`)
            : null,
          createElement(
            "div",
            { className: "dsmd-row" },
            createElement(Toggle, { checked: draft.enabled, label: "启用智能分派", onChange: (value) => update({ enabled: value }) }),
            createElement("span", { style: { flex: 1 } }),
            createElement("span", { className: "dsmd-hint" }, `版本 ${data && data.version ? data.version : "0.1.0"}`)
          )
        ),
        createElement(
          "div",
          { className: "dsmd-card" },
          createElement("h3", { className: "dsmd-title" }, "全局设置"),
          createElement(
            "div",
            { className: "dsmd-grid" },
            createElement(Field, { label: "提示词注入", hint: "把档案表与分派标准注入产生 subagent 的会话" },
              createElement(Select, {
                value: draft.guidanceMode || "compact",
                options: MODE_OPTIONS,
                placeholder: "",
                onChange: (value) => update({ guidanceMode: value || "compact" }),
              })),
            createElement(Field, { label: "默认档案", hint: "任务没有命中任何标签/规则时兜底" },
              createElement(Select, {
                value: draft.defaultProfileId || "",
                options: defaultOptions,
                placeholder: "（不指定）",
                onChange: (value) => update({ defaultProfileId: value }),
              })),
            createElement(Field, { label: "标签匹配模式", hint: "开启后：有标签命中时只在命中档案中择优" },
              createElement(Toggle, {
                checked: draft.requireTagMatch === true,
                label: "标签优先过滤",
                onChange: (value) => update({ requireTagMatch: value }),
              })),
            createElement(Field, { label: "负载均衡", hint: "多个档案胜任同一任务时在其间分摊：均衡=高分档案领先1~2个任务后轮换；严格=近乎轮换。统计口径：subagent_assign_model 推荐计数（30分钟半衰，进程内）。" },
              createElement(Select, {
                value: draft.loadBalancing || "balanced",
                options: LOAD_OPTIONS,
                placeholder: "",
                onChange: (value) => update({ loadBalancing: value || "balanced" }),
              }))
          )
        ),
        createElement(
          "div",
          { className: "dsmd-card" },
          createElement(
            "div",
            { className: "dsmd-row" },
            createElement("h3", { className: "dsmd-title" }, "模型档案"),
            createElement("span", { style: { flex: 1 } }),
            createElement("button", { className: "dsmd-btn", type: "button", onClick: addProfile }, "+ 添加档案")
          ),
          createElement("p", { className: "dsmd-hint" },
            "每个档案 = 一个可分配给 subagent 的模型：智能程度、推理速度、标签、可选的 reasoning effort。provider/model 必须来自全局允许列表。"),
          draft.profiles.length === 0
            ? createElement("p", { className: "dsmd-empty" }, "还没有档案，点击「+ 添加档案」创建。")
            : draft.profiles.map((profile, index) =>
                createElement(ProfileCard, {
                  key: profile.id || index,
                  profile,
                  index,
                  allowed,
                  stale: profile.id ? staleIds.has(profile.id) : false,
                  liveLoad: data && data.load,
                  onChange: updateProfile,
                  onRemove: removeProfile,
                })
              )
        ),
        createElement(
          "div",
          { className: "dsmd-card" },
          createElement(
            "div",
            { className: "dsmd-row" },
            createElement("h3", { className: "dsmd-title" }, "关键词规则（可选）"),
            createElement("span", { style: { flex: 1 } }),
            createElement("button", { className: "dsmd-btn", type: "button", onClick: addRule }, "+ 添加规则")
          ),
          createElement("p", { className: "dsmd-hint" },
            "规则同时作用于两处：① 注入父会话系统提示词——父模型直接看到「关键词 → 档案」映射，是它分派时的最强信号；② 参与 subagent_assign_model 工具评分。关键词按任务文本包含匹配；多条规则按优先级从高到低列出。"),
          createElement("p", { className: "dsmd-hint" },
            "停用的规则、指向已停用或路由失配档案的规则不会出现在提示词里。"),
          draft.rules.length === 0
            ? createElement("p", { className: "dsmd-empty" }, "没有规则。大多数场景用标签 + 复杂度匹配就够了。")
            : draft.rules.map((rule, index) =>
                createElement(RuleRow, {
                  key: rule.id || index,
                  rule,
                  index,
                  profiles: draft.profiles,
                  onChange: updateRule,
                  onRemove: removeRule,
                })
              )
        ),
        createElement(
          "div",
          { className: "dsmd-card" },
          createElement("h3", { className: "dsmd-title" }, "分派测试（规则模拟，不调用大模型）"),
          createElement("p", { className: "dsmd-hint" },
            "这里跑的是与 subagent_assign_model 工具相同的评分内核：标签命中 + 复杂度贴近 + 关键词规则，纯代码计算。"),
          createElement("p", { className: "dsmd-hint" },
            "真实会话中的分派由当前会话的大模型完成：它读到系统提示词里的档案表与分派标准后自行判断任务，并在 subagent 调用里填写 provider/model；负载均衡开启时会先调用 subagent_assign_model 获取计入实时负载的推荐。本测试会采用当前实时负载，但不会写入计数。验证方法：重启后让主代理连续委派多个同类任务，观察 provider/model 是否在胜任档案间轮换。"),
          createElement("textarea", {
            className: "dsmd-textarea",
            value: taskText,
            placeholder: "例如：调研 UniRow 和 ReactFlow 的差异，输出选型建议",
            onChange: (event) => setTaskText(event.target.value),
          }),
          createElement(
            "div",
            { className: "dsmd-row" },
            createElement("button", {
              className: "dsmd-btn",
              type: "button",
              disabled: testing || !taskText.trim(),
              onClick: () => void runTest(),
            }, testing ? "计算中…" : "运行规则模拟")
          ),
          testResult
            ? createElement(
                "div",
                { className: "dsmd-result" },
                testResult.ok
                  ? [
                      `推荐：${testResult.displayName || testResult.profileId} → ${testResult.route.provider}/${testResult.route.model}`,
                      testResult.route.reasoningEffort ? `reasoning_effort: ${testResult.route.reasoningEffort}` : null,
                      testResult.reasons && testResult.reasons.length > 0 ? `理由：\n- ${testResult.reasons.join("\n- ")}` : null,
                      testResult.alternatives && testResult.alternatives.length > 0 ? `备选：${testResult.alternatives.join("；")}` : null,
                      testResult.gateNote || null,
                    ].filter(Boolean).join("\n")
                  : testResult.message || "不可用"
              )
            : null
        ),
        createElement(
          "div",
          { className: "dsmd-card" },
          error ? createElement("p", { className: "dsmd-error" }, error) : null,
          saved ? createElement("p", { className: "dsmd-ok" }, "已保存。提示词与工具会在下一次会话组装时使用新配置。") : null,
          createElement(
            "div",
            { className: "dsmd-row" },
            createElement("button", {
              className: "dsmd-btn dsmd-btnPrimary",
              type: "button",
              disabled: saving,
              onClick: () => void save(),
            }, saving ? "保存中…" : "保存"),
            createElement("button", {
              className: "dsmd-btn",
              type: "button",
              disabled: saving || loading,
              onClick: () => void load(),
            }, "放弃修改并重新加载")
          )
        )
      );
    }

    function summaryText() {
      return "按任务复杂度与标签为 subagent 挑选模型";
    }

    const inject = ["slots"];

    function apply(ctx) {
      // 挂插件页 slot：侧栏 插件 → subagent-model-director → 行配置页。
      // key 规则：<包名>#<patch 里声明的行 id>。
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-subagent-model-director#subagent-model-director",
          },
          (slotProps) =>
            slotProps && slotProps.view === "summary"
              ? summaryText()
              : createElement(DirectorCard, null)
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
