# dsh-subagent-model-director

DeepSeek Harness 插件：**按任务复杂度与标签，为每个 subagent 智能挑选模型**。

产生 subagent 的那个会话（父会话）的当前模型负责判断任务复杂程度；本插件把「模型档案表 + 分派标准」注入父会话的系统提示词，并提供 `subagent_assign_model` 工具兜底，父模型据此在 `subagent` 调用中填写 `provider` / `model` / `reasoning_effort`。

## 安装

**要求**：DeepSeek Harness ≥ 0.1.7-rc.1（依赖宿主的 settings 桥、tools API 与 subagent 组合）。

### 方式一：DSH 插件管理器（推荐）

1. 打开侧栏 **插件** 页 → 点击 **安装**（Install bundle）；
2. 输入仓库地址：

   ```
   github:fred-chen/dsh-subagent-model-director
   ```

   （或完整地址 `https://github.com/fred-chen/dsh-subagent-model-director.git`）
3. 确认安装后插件默认启用；若宿主提示兼容性，按界面指引处理。

### 方式二：CLI

```bash
dsh plugin --profile <你的profile名> add github:fred-chen/dsh-subagent-model-director
```

### 方式三：手动 pnpm

```bash
cd ~/.dsh/profiles/<你的profile名>
pnpm add github:fred-chen/dsh-subagent-model-director
```

然后编辑该 profile 的 `package.json`，把包名加入 bundle 列表：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-subagent-model-director"
    ]
  }
}
```

## 安装后配置

1. **重启 DSH**（新 bundle 建议重启一次确认加载）；
2. 确认侧栏 **插件** 页出现 **subagent-model-director** 且已启用；
3. **前置条件**：先到 设置 → 插件 → **Subagent** → Model selection 启用并勾选允许子代理使用的模型——本插件的模型档案**只能从这个全局允许列表中选择**；
4. 打开 **插件 → subagent-model-director → Configure**：
   - 添加模型档案：从下拉框选择 provider/model，标注智能程度（高/中/低）、推理速度（高/中/低）、自定义标签（如 `调研`、`代码分析`、`写作`），可选填 reasoning effort；
   - 可选：添加关键词规则（强信号）、设置默认档案、切换负载均衡模式；
5. 用页面底部的 **分派测试** 验证规则链（纯代码模拟，不调用大模型）；
6. 保存后，**新会话**即生效——父会话的系统提示词会出现档案表与分派标准，父模型据此为每次 `subagent` 委派填写路由。

### 卸载 / 更新

- 卸载：插件页删除该 bundle，或 `pnpm remove dsh-subagent-model-director`（profile 目录内）；
- 更新：`pnpm add github:fred-chen/dsh-subagent-model-director#main` 后重启；发布 npm 后可直接 `pnpm add dsh-subagent-model-director@latest`。

## 它解决什么问题

DSH 原生已有：

- `subagent` 工具的 `provider` / `model` / `reasoning_effort` 字段（in-process 后端支持 `agentOptions`）；
- `list_subagent_models` 运行时发现工具；
- **Subagent 全局允许模型列表**（设置 → 插件 → Subagent → Model selection，即 `subagent-model-selection-settings` 条目），保存后成为该会话的 exact-route 白名单。

原生没有的：模型档案（智能程度/速度/标签）、任务→模型的匹配算法、面向父模型的分派标准提示词。本插件补齐这三块。

## 负载均衡

多个档案胜任同一任务（如两个档案共享 `代码分析` tag）时，在其间分摊任务，而不是每次都选同一个"最优"。

**机制**：在"胜任集合"（与最高基础分相差 45 分以内，约等于一个 tag 命中的差距）内，按 `调整分 = 基础分 − 惩罚 × 进行中任务数` 择优：

| 模式 | 惩罚 | 行为 |
|---|---|---|
| 均衡（默认） | 25 | 高分档案领先 1~2 个任务后轮换；能力差距大时仍尊重能力 |
| 严格轮换 | 60 | 近乎轮流分配胜任档案 |
| 关闭 | 0 | 永远选最高分档案（忽略负载） |

胜任集合外的弱档案永远不会因"空闲"而胜出；关键词规则（+500）强于负载惩罚。

**统计口径（诚实说明）**：负载计数 = `subagent_assign_model` 的推荐次数（30 分钟半衰，进程内存活，重启清零）。负载均衡开启时，系统提示词会指示父模型"每次委派前先调用 `subagent_assign_model`"，使工具成为记账点；未走工具的直接委派不会计入——宁缺勿错，计数不足只会削弱均衡效果，不会分错路由。实时数字刻意不写入系统提示词（避免每次委派都打断 KV 前缀复用），由工具按需返回。

## 分派是怎么决定的（三层）

| 层 | 谁决策 | 在哪里发生 |
|---|---|---|
| 1. 主路径 | **大模型**（父会话当前模型） | 会话内：模型读到注入的档案表+分派标准+关键词规则，自行判断任务复杂度/标签，在 `subagent` 调用里填 `provider`/`model`/`reasoning_effort` |
| 2. 会话内兜底 | 大模型判断 + 代码查表 | 会话内：模型调用 `subagent_assign_model` 提供 task_summary/智能程度/速度/标签，工具内核在允许列表内的档案中评分择优；模型可不采纳 |
| 3. 设置页"分派测试" | 纯代码（无模型） | 设置页：与第 2 层相同的评分内核做规则模拟，用于预览规则链效果 |

为什么工具内核不内置一次大模型调用：父模型本身就是大模型——它调用工具时已经完成了"判断"（填了 intelligence/speed/tags）；工具内部再调一次模型会循环（用哪个模型分类？那本身就是分派问题）、增加延迟与费用。若需要"工具内部再请一个模型分类"的可选模式，可以作为后续扩展。

## 模型档案

每个档案 = 一个可分配给 subagent 的模型：

| 属性 | 说明 |
|---|---|
| Provider / Model | **只能从全局允许列表中选择**，保存与运行时都会校验 |
| 智能程度 | 高（计划/设计/创造性综合）· 中（代码分析/审查+推断）· 低（调研/事实核查） |
| 推理速度 | 高 · 中 · 低 |
| 标签 | 自定义多标签（如 `写作`、`调研`、`代码审查`），多个模型可共用同一标签 |
| Reasoning effort | 可选；留空 = 使用所选模型的默认档 |
| 启用 | 关闭的档案不参与分派 |

## 分派算法

1. **候选池**：已启用且路由在全局允许列表内的档案。
2. **标签优先**：任务标签（父模型显式传入）或任务文本包含档案标签（≥2 字符）→ 命中，每个 +40 分。
3. **复杂度择优**：智能程度贴近需求 +30（每差一档 -10）；速度贴近 +18（每差一档 -6）。
4. **关键词规则**（可选强信号）：任务描述命中关键词 → +500 + 优先级，压过普通标签匹配。
5. **默认档案**：无命中时兜底（+5）。
6. `requireTagMatch` 开启时：存在命中档案则只在命中集合里择优。

分派不是硬拦截：父模型仍可能自己填路由，宿主的 exact-route 预检始终是最后一道闸门。

## 分派标准（注入父会话）

1. 硬核事实核查、调研、大量工具调用后阅读提取结论的任务 → 智能程度低、推理速度最快的模型。
2. 分析代码、审核代码并需要推断得出结论、同时大量调用工具的任务 → 智能程度高或居中、速度较快的模型。
3. 计划、设计类任务，需要创造性思维并结合已核查事实推理得出结论 → 智能程度最高的模型。

## 组成

- **设置页**（侧栏 插件 → subagent-model-director → Configure）：档案/规则增删改、全局开关、提示词注入模式、分派测试；通过 `/api/dsh-subagent-model-director/*` 桥接读写，revision 乐观锁防覆盖。
- **系统提示词段落**（`subagent-model-director:profiles`）：档案表 + 分派标准 + **关键词规则**（父模型直接可见的强信号，按优先级排序；停用/失配目标的规则不渲染）；`guidanceMode` 可选 简洁/详细/关闭。
- **`subagent_assign_model` 工具**：父模型拿不准时调用，返回推荐路由、理由与备选。
- **`lib/core.js`**：纯逻辑核心（无依赖），22+ 场景单测覆盖。

## 注意

- `subagent_fork` 不能选择子模型路由（继承父会话以复用 KV 前缀），分派只对 `subagent`（spawn 等支持 `agentOptions` 的后端）生效。
- 全局允许列表变更后，失配档案会在设置页标黄并在运行时跳过。
- 提示词段落是动态的：修改配置会改变父会话请求前缀（与 free-search 等动态段落同样的权衡）。

## 开发

```bash
git clone https://github.com/fred-chen/dsh-subagent-model-director.git
cd dsh-subagent-model-director
npm test        # 纯逻辑核心测试（无需 DSH 运行时）
```

零构建、零运行时依赖：`lib/core.js` 是纯函数核心，`lib/index.js` 是宿主插件（依赖宿主提供的 `dsh-settings` / `dsh-tools` / `schemastery`），`lib/client.js` 是浏览器端设置页。

## License

[MIT](LICENSE)
