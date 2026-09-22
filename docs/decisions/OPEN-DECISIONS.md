# OPEN-DECISIONS 悬而未决登记册

> 只追加 + 就地关闭（OPEN → RESOLVED 时补 Resolution 列）。已关闭项可升格为 ADR。
> slug 取值：`waiting-on-external-condition` / `design-decision-to-evaluate` / `existing-design-boundary`

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-09-21 | Phase 1 / PM | 每周 60 节课是**学期固定周期表**还是**每周重排** | 决定 `Class` / `LessonSession` 建模与节假日、顺延处理 | 已裁定**"每周固定班级 + 按日期生成课次"**：`classes` 存 weekday+start_min+end_min，`lessons` 是按日期展开的实例。依据背景原文"被排进每周的固定班级"。学期制/假期顺延不在 MVP，`lessons` 的实例结构已能容纳（取消即置 `cancelled` 不生成 attendance） | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / PM | 试听"限一次"的粒度：学生×科目 还是 学生×老师 | R1 唯一性约束建在哪个字段组合上 | 倾向 学生×科目（换老师重听仍是同科目，应拦截） | 业务方（作业中不保证回答） | 无法确认则写进 DESIGN.md 假设区 | OPEN |
| 2026-09-21 | Phase 1 / PM | 48h SLA 从下课算还是次工作日算？没接通算不算跟进？ | R2 跟进逾期判定 | 倾向 从试听下课时刻起算自然小时，只要创建了跟进记录即算 | 业务方 | 无法确认则写为可配置常量并注明假设 | OPEN |
| 2026-09-21 | Phase 1 / PM | 课时包有效期、赠送课时的退费定价 | R9 `expires_at` | 倾向 建字段但 MVP 不强制校验；退费按原价折算 | 业务方定价规则 | v2.0 | OPEN |
| 2026-09-21 | Phase 1 / PM | 10 名 admin 之间是**竞争**还是**协作**？能否互看别的学生余额 | R7 非对称读写权限 | 倾向 协作为主、撞单排查需要 → 可读全量、只写自己的 | 组织事实（作业留白） | DESIGN.md 中明示为**假设**而非结论 | OPEN |
| 2026-09-21 | Phase 1 / PM → Phase 3 / 架构师裁定 | 老师请假一周：课时退回 / 顺延 / 照扣 | R10 冲正策略 | **已裁定：退回（冲正），不引入顺延，绝不删除原记录**。①课次尚未点名 → 取消即不产生 `consume` 流水，学生天然不被扣；②该课次已因迟到请假（`leave_late`）扣过费 → 取消时对每条 `-1` 追加一条 `+1`（`reason=manual_adjust`，`note="cancel-range compensation: …"`），原 `-1` 保留供审计（ADR-008 只增不改，命中 `uq_ledger_consume` 天然幂等）。"顺延"需改 `lessons.lesson_date` 并级联全部下游排期，MVP 不做。实现见 `backend/internal/service/scheduling.go:207 CancelRange` | ADR-008 / ADR-009 | — | RESOLVED |
| 2026-09-21 | Phase 1 / PM | R6 低课时预警的形态 | 原设计"预警队列"vs 竞品"老板看的图表" | 已裁定为**可被处理掉的任务**（进 admin 队列，跟进后消失） | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / PM | R5 的法理基础是否写进 DESIGN.md | 预付式消费司法解释：消费记录由经营者控制，拒不提交按消费者主张认定 | 已裁定写进，作为本项目最强的一条"为什么" | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / PM | 补 R9/R10/R11 三条规则 | 追问环节必问"老师请假一周""学生转 admin" | 已裁定：三条均进 DESIGN.md，R10 实现冲正流水，R9/R11 只建字段与表不建 UI | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | Design Token 双源冲突 | UIUX.md `#0F5C73` vs 架构初版 `#1f5f8b` | 裁定 **UIUX.md §3.2 为唯一源**，主色 Petrol Blue `#0F5C73`，色板冻结 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | 请假是否需 admin 人工审批 | 设计师草图引入审批 vs 架构 openapi.yaml:811 服务端 24h 自动判定 | 裁定**去掉审批**，提交即判定 `leave_approved` / `leave_late` | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | 是否引入 shadcn/ui | 设计师建议 vs 架构师排除 Radix（shadcn 底层依赖） | 裁定**不引入**，Tokens 全保留，组件按 Tailwind v4 自建 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | ASCII 线框用 dingbat 字符（⚠ ⬭ ⬚ ✕ ✚）是否违规 | ⚠⬭✕✚ 落在 U+2600–27BF / U+2B00–2BFF | 裁定 `docs/*.md` 豁免 emoji 扫描；`frontend/src` 与 `backend/` 零容忍 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | 课后能否补交请假 | 设计师 advisory 3 | 裁定**不允许**；课前任意时刻可提交，课开始后出勤由老师判定 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监实测 | MySQL 版本与账号权限 | 架构 advisory 3/5 担心共享实例无法按表授权、CHECK 失效 | 实测 **8.0.46** + `geo@%` 含 `CREATE USER`/`GRANT OPTION` → **Ledger 三层防护全做，不降级** | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监实测 | 数据库系统时区 | 架构 advisory 4 | 实测 `sys_tz=CST`、`session=SYSTEM` → SQL 禁 `NOW()/CURDATE()` 从建议升级为**硬约束** | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监实测 | `student_management` 库不存在 | 现有库：geo / coking_plant / coking_assistant / golf | 迁移脚本首步须 `CREATE DATABASE` | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 设计师 | 48h SLA 是否含周末 | R2 跟进逾期判定；澳洲机构周末通常营业 | 倾向不含（自然小时），但澳洲补习班周末上课，含更合理 | 业务方 | 无法确认则写为可配置常量 | OPEN |
| 2026-09-21 | Phase 1 / 总监裁定 | Tailwind v4 实现方式冲突 | 设计师附录 C 写"Tailwind config 映射 theme.extend" vs 架构师 advisory 6"不建 tailwind.config.js" | 裁定**架构师胜出**：Tailwind v4 是 CSS-first，Tokens 走 CSS `@theme`，**不建 `tailwind.config.js`**；设计师 Tokens 值全部保留 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | 请假撤销的时限 | 设计师草图给 `[撤销]` 但未定义边界；`leave_late` 课后撤销等于绕过扣课时 | 裁定**仅在开课前可撤销**；开课后按钮置灰 + tooltip「课已开始，出勤由老师判定」。不做"撤销即还原为 absent"的复杂逻辑 | — | — | RESOLVED |
| 2026-09-21 | Phase 1 / 总监裁定 | 阈值在前后端各写一份会漂移 | R2 的 48h、R4 的 24h、R6 的余额 4 均为假设值，无外部基准 | 裁定后端新增 `GET /api/v1/config` 返回 `followup_sla_hours` / `leave_threshold_hours` / `low_credit_threshold`，**前端读取渲染文案**，保证 UI 与规则同源 | — | — | RESOLVED |
| 2026-09-21 | Phase 3 / 总监 | ADR-010 的"openapi 生成类型"机制从未接上，导致规格与实现漂移了十余处（详见 ADR-011） | ADR-010 承诺 `npm run gen:types` 挂 `prebuild` + 手写 DTO 禁令；实际 `package.json` 无该 script、无 `openapi-typescript` 依赖、`lib/types.ts` 为手写 | 本轮以运行时为准人工逐项对齐（ADR-011）；**机制**留待接上：`openapi-typescript` 生成 + CI 跑 `openapi-diff` | 10h 预算，回填 30 端点规格的收益低于"切片跑通" | v2.0 或接 CI 时 | OPEN |
| 2026-09-21 | Phase 3 / 总监实测 | `/auth/me`、`/students/:id`、`/students`、`/lessons/:id/roster`、`/students/:id/credits` 实现比规格少字段；`/dashboard/admin`、`/dashboard/teacher` 实现比规格更丰富 | ADR-011 逐项裁定表；前端页面的抽屉/工作台依赖这些字段 | 已按"哪边更对"逐项裁定并实施：弱的一侧补齐，强的一侧保留并回改规格 | — | — | RESOLVED |
| 2026-09-21 | Phase 3 / fe-teach 发现 | `late_lt_24h` 请假从不写账本 → DESIGN.md 的"<24h 仍扣 1 课时"在实现中为假 | R4/R5；`Settle` 只接受 present/late/absent 且只对提交上来的学生计费 | 已修：`RequestLeave` 在 `<24h` 时于同一事务内 `LockStudent` → 写 `attendances(leave_late)` → 写 `-1` 流水；用 `ReasonConsume` 以命中 `uq_ledger_consume` 天然幂等；R10 取消课次时补 `+1` 冲正 | — | — | RESOLVED |
