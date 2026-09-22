# ADR-001: 数据访问层用 GORM，关键路径手写 SQL

## Status
Accepted (Phase 1)

## Background
10 小时工时预算下，要为 16 张表做出可用的数据访问层，同时必须让 R3（排班冲突）、R4/R5（课时账本）的 SQL 与事务语义**可被展示、可被追问**。后者是评分表里明确的一条："知道哪些用数据库约束、哪些用业务逻辑"。

候选：GORM / sqlc / ent / database/sql。

## Decision
**默认用 GORM（v1.31.2 + gorm.io/driver/mysql v1.6.0），三条关键路径强制手写 SQL。**

- 常规 CRUD（学生档案、班级、科目、跟进、AI 卡）：GORM 模型 + `db.Transaction`。
- 关键路径（必须手写 SQL，走 `db.Raw` / `db.Exec`）：
  1. 排班事务里的重叠检测与容量计数（ADR-009）
  2. `credit_ledger` 的插入与 `SUM(delta)` 余额聚合（ADR-008）
  3. 老师/学生视角的课表联表查询（带预填出勤状态）
- 行锁统一用 GORM 的 `clause.Locking{Strength: "UPDATE"}` 或直接 `db.Exec("SELECT id FROM students WHERE id=? FOR UPDATE", id)`。
- 禁止裸 `db.Updates(map[string]any{...})`（会写零值且可能全表更新）；写操作显式 `Select` 字段或走 `Exec`。

## Consequences

正面：
- 省掉 16 张表 × CRUD 的样板代码，这是 10h 预算里最大的一块。
- 关键路径的 SQL 是手写的，面试官问"这条规则在哪一层"时可以直接翻到那段 SQL 和它的事务边界。
- 没有 codegen 步骤，CI 与本地开发都少一个环节。

负面：
- GORM 查询不是编译期校验的，`Where("statuss = ?", ...)` 这类拼写错误只在运行时炸。缓解：关键路径全部手写 SQL（本来就要写），非关键路径用结构体条件而非字符串。
- `AutoMigrate` 有"改列会丢精度/隐式提交"的风险。**明确不使用 AutoMigrate**，schema 变更一律走 golang-migrate（ADR-002）。
- 混用两套风格需要团队自律。缓解：`repository` 按资源分包，每个文件顶部注释标明该文件是否含手写 SQL。

## Related ADRs
ADR-002（迁移）, ADR-008（账本）, ADR-009（排班冲突）, ADR-010（分层）
