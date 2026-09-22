# ADR-006: LLM 用 DeepSeek Chat Completions 的 json_object 模式，服务端白名单校验 + 规则兜底降级

## Status
Accepted (Phase 1)

## Background
需要两处 LLM（试听转化决策卡、续费流失决策卡），要求 structured output + 服务端校验 + 失败有合理降级，且系统动作不能依赖 LLM。核心问题是：**DeepSeek 到底能保证多少结构？**

## 验证到的事实（官方文档）

| 事实 | 来源 |
|---|---|
| Chat Completions 的 `response_format` 只文档化 `text` 与 `json_object` | `api-docs.deepseek.com/guides/json_mode` |
| 用 `json_object` 必须：①提示词里出现 "json" 一词 ②给出期望 JSON 示例 ③`max_tokens` 给足防截断 | 同上 |
| **JSON Output 偶发返回空 content**，官方列为已知问题 | 同上原文："the API may occasionally return empty content" |
| `json_schema` 只在 **Responses API**（`text.format.type=json_schema`，需 `name` + schema）被文档化 | `api-docs.deepseek.com/zh-cn/api/create-response/` |
| 严格结构化另有 strict tool calling，但需 **beta base URL `https://api.deepseek.com/beta`** 且 `strict:true`；官方标注 Beta 不稳定 | DeepSeek Tool Calls 指南 / API 升级公告 news0725 |
| Go 侧可用 `github.com/sashabaranov/go-openai` 通过 `config.BaseURL` 对接 | 官方 README：`DefaultConfig(key)` + `BaseURL` + `NewClientWithConfig` |

## Decision

1. **用 Chat Completions + `response_format: {type:"json_object"}`**，模型 `deepseek-chat`（不用 `deepseek-reasoner`：思考模式下 temperature/top_p 不生效，且推理与正文分离，不利于抽取）。
2. 系统提示词必须包含 "json" 字样 + 完整 JSON 示例 + "只输出 JSON，不要 Markdown 代码围栏"。
3. `max_tokens >= 1024`；**检查 `finish_reason`**，`== "length"` 直接判无效（截断）。
4. 防御式解析：`strings.TrimSpace` → 剥掉可能的 ``` 围栏 → `json.Unmarshal` 到结构体。
5. **服务端枚举白名单校验（R8）**：枚举值 ∈ 白名单、数值在区间、字符串长度有上限。任一不合法 → `ai_status='invalid'`。
6. **降级**：最多重试 1 次（换更短提示词）；仍失败或 8s 超时 → `ai_status='unavailable'`，返回**规则引擎兜底卡**（纯数据推导：试听次数、距试听天数、余额、出勤率、跟进是否逾期），前端展示"AI 不可用，已用规则兜底"。
7. **系统动作零依赖 LLM**：48h 跟进 SLA（R2）、余额 ≤4 预警（R6）由查询/定时任务实现；LLM 只产出建议卡，不触发任何写操作。
8. 每次调用落 `ai_decisions`（`model` / `prompt_version` / `input_hash` / `output_json` / `ai_status`），可审计、可复盘。
9. `llm` 层加 8s 超时 + 单飞（同一 `student_id` + `kind` 60s 内不重复请求）。
10. 密钥 `DEEPSEEK_API_KEY` 走环境变量，缺失时**启动不失败**，所有卡片直接走兜底路径。

## Consequences

正面：
- 不依赖 beta 接口，演示当天不会因为 DeepSeek 调整 beta 行为而翻车。
- "模型不保证 schema"这个风险被第 3–6 步完全兜住，最坏情况是决策卡退化成规则卡，主流程不受影响——正是评分表要的"失败了系统照常工作"。
- `ai_decisions` 表让"AI 用了什么、输出了什么、是否被判无效"可被追问。

负面：
- 放弃 strict 模式意味着偶尔一次调用浪费（重试）。量级：演示场景个位数调用，成本可忽略。
- 兜底规则引擎要额外写一份逻辑（约 40 行）。这是"AI 不是必需品"的最好证明，值得写。

风险：`json_object` 保证合法 JSON 语法，不保证业务 schema —— 第 5 步不可省略。已确认这是 DeepSeek 与 OpenAI Structured Outputs 的关键差异。

## Related ADRs
ADR-010（规则 R8 的执行层）
