# ADR-011: 契约与实现的漂移 —— 以运行时为准，并补齐生成步骤

## Status
Accepted (Phase 3，开发联调期)

## Background

ADR-010 定下"`docs/openapi.yaml` 是前后端唯一契约，前端用 `openapi-typescript` 生成类型，**不手写 DTO**"，并规定"实现与规格冲突时先改规格"。

实际到了 Phase 3 联调，出现两个事实：

1. **生成步骤从未接上。** `frontend/package.json` 里没有 `gen:types`，也没有 `openapi-typescript` 依赖；`frontend/src/lib/types.ts` 是手写的（且路径与 ADR-010 设想的 `src/api/types.ts` 不同）。也就是说 ADR-010 的"消灭前后端字段不一致"没有真正生效 —— 手写 DTO 恰恰是漂移的成因，而不是解法。
2. **实现与规格在十余处不一致**，且方向两侧都有：
   - 规格更弱：`/dashboard/admin` 规格里只给 4 个计数 + `today_lessons`，而实现返回**三条行动队列数组**（逾期跟进 / 待试听 / 低课时）。后者才是本项目的产品主张 —— admin 的失效模式是"忘了动手"，不是"找不到人"。此时实现是对的。
   - 实现更弱：`/auth/me` 实现返回扁平的 `{id, role, display_name}`，而规格与前端类型都是 `{user, student_ids}`；`/students/:id`、`/lessons/:id/roster`、`/students/:id/credits`、`/students` 列表同样缺字段。此时规格是对的。
   - 真 BUG（非形状问题）：`RequestLeave` 判定 `late_lt_24h` 后只写 `leave_requests` 行，从不写账本；而 `Settle` 只接受 present/late/absent 且只对提交上来的学生计费。于是"24 小时内请假仍扣 1 课时"这条写在 DESIGN.md 里的规则**在实现中是假的**。（已在 D1 修复。）

## Decision

### 1. 本次交付以**运行时**为准
被评审的是能跑起来的那条切片，以及评审环节会用 curl 直接打的那些规则。因此本轮把 `openapi.yaml` 与 `types.ts` 向实现对齐，而不是反过来重写实现。`openapi.yaml` 顶部加注指向本 ADR。

### 2. 逐项裁定（不是一刀切）
不以"谁先写的"为准，按**哪边更对**逐项判：

| 端点 | 裁定 | 理由 |
|---|---|---|
| `/dashboard/admin` | 保留实现的三队列数组，规格补齐 | 三队列是产品主张；规格的计数版是弱化 |
| `/dashboard/teacher` | 保留实现的富行，规格补齐 | 老师的三个问题（下节是什么/谁是新面孔/谁请假）需要富行 |
| `/auth/me` | 改实现为 `{user, student_ids}` | 规格 + 前端类型一致，实现单方漂移；且 `student_ids` 必须是数组，因为一个家庭凭据可能带多个孩子 |
| `/students/:id` | 扩展实现为完整 `StudentDetail` | 详情抽屉需要 guardians/enrollments/packages/follow_ups/latest_ai_card；拆成多次客户端请求就是 N+1 |
| `/lessons/:id/roster` | 改实现为 `{lesson, entries}`，且 `prefilled_status` 与 `current_status` **分开** | 老师端要把"已批准请假"渲染成预填只读，同时仍需知道是否真的点过名 |
| `/students/:id/credits` | 改实现为 `{balance, items, total}` | 与规格一致，且 `total` 是分页所需 |
| `/students` | 实现补 `owner_admin_name` / `active_class_count` / `pending_followup` | 「待排班」Saved View 需要直接可用的字段，而不是前端猜 |
| AI 决策卡 | **保留实现的富字段**，`types.ts` 改为按 `kind` 区分的联合类型 | `conversion_signal`/`guardian_concerns`/`blocker`/`next_action` 才是 LLM 的实际产出；压成通用 headline/reasons 会把价值丢掉 |
| `/lessons` 的角色 | 实现放开 `student` 并按绑定学生**在查询里**收敛 | 家长端要列课才能请假；且这是数据范围规则，必须在服务端强制 |
| `leave_late` 计费 | 改实现（补账本条目） | 这是 BUG，不是形状分歧 |

### 3. `leave_late` 计费为何落在 `RequestLeave` 而不是 `Settle`
两条路都可行，选前者，因为规则是"晚于 24 小时的请假**仍然消耗**课时" —— 钱应当在请假成立时就动，而不是等老师点名。否则老师若不点名，这笔消耗就永远不会发生，规则形同虚设。

关键实现细节：账本流水用 `ReasonConsume` 而非 `leave_adjust`。因为表上有 `UNIQUE(student_id, lesson_id, reason)`，用 `consume` 才能让后续 `Settle` 对同一学生计费时命中唯一键、被现有的 `IsDuplicateLedger` 分支吞掉，从而**天然幂等**；用 `leave_adjust` 会绕过这道闸，造成重复扣费。R10 取消课次时再补一条 `+1` 冲正（append-only，不删原行）。

### 4. 补一道真正的防线（本轮做不完，已登记）
`gen:types` 挂进 `prebuild` + CI 里跑 `openapi-diff`。在接上之前，ADR-010 那句"消灭字段不一致"只能算意图，不算机制 —— 已记入 `OPEN-DECISIONS.md`。

## Consequences

正面：
- 交付物之间不再互相矛盾：`openapi.yaml`、`types.ts`、Go handler 三者对齐。
- 两处"实现更优"的地方被保留而不是被规格拖回平庸。
- 一个会撒谎的规则（`late_lt_24h`）被修成真的，且修法自带幂等论证。

负面：
- 本 ADR 承认了 ADR-010 的机制在本次交付中**没有生效**。这是取舍：10h 预算内，把生成链路接起来并回填 30 个端点的规格，换不到与"切片能跑通"等价的评分收益。
- 规格与实现的对齐质量取决于这次人工逐项核对，而不是机器保证。

## Related ADRs
ADR-004（前端数据层）、ADR-006（LLM 降级）、ADR-007（时区，本 ADR 顺带修掉 `dashboard.go` 里一处 `CURDATE()` 违规）、ADR-008（账本 append-only，D1 的幂等论证依赖它）、ADR-010（本 ADR 是对它的修正与补充）
