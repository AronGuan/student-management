# ADR-010: 分层架构、目录约束与 openapi.yaml 作为前后端唯一契约

## Status
Accepted (Phase 1) — **部分被 ADR-011 取代（Phase 3）**

> 取代说明：本 ADR 的「端点与错误码」「分层与依赖方向」「目录约束」仍然有效，并且是本次交付的结构基础。
> 但其中关于 **`openapi.yaml` 效力的两条主张在交付中未成为事实**，见文末「§ Phase 3 修正」。
> 二者冲突处**以 ADR-011 为准**。

## Background
需要一套让"规则在哪一层执行"一目了然的结构，并且约束生成式代码不要发散（单文件膨胀、职责混杂、入口塞业务逻辑）。同时前后端要有一份唯一契约，避免两边各猜一套 DTO。

## Decision

### 分层与依赖方向（单向）
```
handler  →  service  →  repository  →  domain
```
- `domain`：实体 + 枚举 + 规则常量，**零外部依赖**，不 import 任何上层。
- `repository`：GORM 常规 CRUD + 关键路径手写 SQL。不 import `gin`。
- `service`：**R1–R8 的唯一落地处**。不 import `gin`。
- `handler`：只做解析参数 / 绑定校验 / 调 service / 装响应。**不含任何业务规则**。
- `middleware`：OriginCheck → Authn → RequireRole → CanWriteStudent(R7)。
- `cmd/server/main.go`：**只装配**（读配置 → 连库 → 建 router → Listen）。

### 目录结构（可执行约束）
```
backend/
├── cmd/server/main.go
├── internal/{config,domain,repository,service,handler,middleware,llm,pkg}/
├── migrations/          # golang-migrate，一文件一条 DDL
├── seed/
└── go.mod
frontend/
├── src/{api,components,features,styles,lib}/
├── scripts/{check-no-emoji.mjs,check-no-hex.mjs}
└── package.json
```

硬规则：
1. **单文件 <= 300 行**（超出即拆，不允许"再忍一下"）。
2. **单一职责**：一个文件一个资源 / 一个用例。
3. **入口只装配**，不含业务逻辑。
4. **按资源分包**（`student_repo.go` / `class_repo.go` ...），不按技术层堆大文件。

### API 契约
`docs/openapi.yaml`（OpenAPI 3.0）是唯一依据：
- 所有端点带 `/api/v1` 前缀；MVP 只有 v1，但路径结构从一开始就带版本。
- 统一响应 `{code, data, message}`；分页 `{items,total,page,limit,hasMore}`。
- 前端用 `openapi-typescript` 生成 `src/api/types.ts`，**不手写 DTO**；`npm run gen:types` 挂进 `prebuild`。
- 变更流程：改 API 先改 `openapi.yaml`，再改实现（活规格：实现与规格冲突时先改规格）。

### 错误码
业务规则冲突用可机读 code：`40000` 数字型 query 参数无法解析 / `40901` 周时段重叠 / `40902` 老师时段冲突 / `40903` 班级已满 / `40904` 余额为 0 / `40905` 重复试听 / `40906` 重复结算 / `40907` 学生不在该课次所属班级在册名单 / `40301` 非本人学生或 household 读别家孩子 / `42201` 出勤状态非法 / `42202` LLM 输出未过白名单；`50000` 兜底 500。
LLM 不可用**不是错误**：HTTP 200 + `ai_status='unavailable'`（见 ADR-006）。

### 契约不变量（客户端可依赖，服务端必须保证）
这两条由第 3 轮实现暴露出来，提升为契约级硬约束，写进 `openapi.yaml` 的 `info.description`：

1. **空集合恒为 `[]`，绝不返回 `null`**。所有列表端点在无匹配时返回空数组（分页端点返回 `items: []`）。Go 侧切片零值是 `nil`，`encoding/json` 会把它序列化成 `null`——必须在 handler 层统一 `if items == nil { items = []T{} }`（或让 repository 用 `make([]T, 0)` 初始化）。`/students/{id}/credits` 的 `items:null` 会让前端 `.map()` 直接崩，属可复现的线上级缺陷。
2. **参数解析失败必须显式报错，不得静默降级**。数字型 query 参数无法解析时返回 `400 / 40000`，而不是忽略它继续执行。静默忽略的后果是过滤条件消失、整个结果集被返回（越权式的数据泄露），比报错严重得多。同时废弃语义模糊的 `-1`（与兜底 500 撞码，客户端无法区分），统一用 `50000`。

这两条属于"沉默逻辑错误"的典型温床：不报错、不崩溃，只是悄悄返回错误的数据。因此在契约里写死，并在端到端验证中作为断言项。

## Consequences

正面：
- "规则在哪一层"有唯一答案：全在 `service` + 数据库约束，前端只是体验层。
- 目录与行数约束让代码在 10h 内可被快速审阅与讲解（Code walkthrough 环节）。
- openapi 生成类型，消灭前后端字段不一致这类低级返工。

负面：
- 分层带来更多小文件。10h 内要用 AI 工具辅助生成样板，否则机械劳动占比过高。
- openapi.yaml 与实现可能失同步。缓解：生成步骤挂进 `prebuild`，且改动 API 必须先动 spec。

风险：AI 生成代码倾向把校验塞进 handler（"反正能跑"）。缓解：spawn 指令里写死"handler 不得包含 `if` 业务判断，判断一律下沉到 service"，并在评审 checklist 中逐条核。

---

## § Phase 3 修正（由 ADR-011 引入，此处如实登记）

Phase 3 联调时发现本 ADR 有**两条主张未成为事实**。登记在此，避免后续读文档的人以为机制已经存在：

| 本 ADR 的主张 | Phase 3 的事实 | 处置 |
|---|---|---|
| 「前端用 `openapi-typescript` 生成类型，**不手写 DTO**」 | **生成链路从未接上**：`frontend/package.json` 无 `gen:types`、无 `openapi-typescript` 依赖；`frontend/src/lib/types.ts` 是手写的，路径也与本 ADR 设想的 `src/api/types.ts` 不同 | 承认未生效。`openapi.yaml` 降格为**人工维护的对照契约与评审依据**，不是机器强制的类型源。接生成步骤 + `openapi-diff` 已登记进 `OPEN-DECISIONS.md` |
| 「消灭前后端字段不一致」 | 手写 DTO 恰恰是漂移成因，而不是解法 —— 联调期实测到十余处不一致，方向两侧都有 | 由 ADR-011 逐项裁定（不以"谁先写的"为准，按**哪边更对**逐项判） |

**同时新增一条本 ADR 未覆盖的契约不变量（参数角色分档）**：

`info.description` 里原先写的是「数字型 query 参数无法解析时返回 400」。这条**过宽**，与 `limit` / `sort` 的实际行为（回落默认值）自相矛盾。已修正为按参数角色分档：

| 参数角色 | 非法值行为 | 判据 |
|---|---|---|
| 过滤 / 作用域（`owner_admin_id` `teacher_id` `weekday` `class_id` `student_id` `lesson_id`） | **400 / 40000** | 被忽略会返回调用者没要的数据 —— 正确性问题，可能构成越权读 |
| 分页（`limit` `page`） | 回落 20 / 1 | 只决定"取多少"，作用域仍正确 |
| 排序（`sort`） | 回落 `updated_at DESC` | 只决定顺序，数据本身是对的 —— 表现问题 |

一句话判据：**参数被忽略后，返回的数据是否仍是调用者本来要看的那批？** 是 → 回落；不是 → 400。

**关于 `sort` 刻意不写 `enum`**：OpenAPI 的 `enum` 语义是「仅这些值合法」，而服务端实测对未知值返回 200 并回落（`sort=bogus` → 200）。契约不声明服务端没有的强制力，因此只在 description 里写清有效值与回落行为。
代价是 `openapi-typescript` 会把该参数生成为 `string` 而非联合类型，前端类型安全需自行维持（`fe-admin` 已手写 `SortKey = 'name' | 'balance_asc' | undefined`）。若将来真的接上生成步骤、且希望拿到编译期约束，**那时再补 `enum`**（届时同时要接受：旧 URL 里带废弃 sort 值会被生成的客户端类型拒绝）。

## Related ADRs
ADR-001, ADR-003, ADR-004, ADR-005, ADR-006, ADR-007, ADR-008, ADR-009, **ADR-011（取代本 ADR 的两条效力主张）**
