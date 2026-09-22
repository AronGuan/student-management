# ADR-002: 迁移工具用 golang-migrate

## Status
Accepted (Phase 1)

## Background
需要一个能进版本库、能在阿里云 MySQL 8 上跑、10 小时内不添麻烦的 schema 变更方案。候选：golang-migrate / atlas / goose。

## Decision
**用 golang-migrate v4.20.1 的 CLI 二进制**，迁移文件放 `backend/migrations/`，命名 `NNNN_name.up.sql` / `NNNN_name.down.sql`。

- 作为**命令行工具**使用（`migrate -path backend/migrations -database "mysql://$DSN" up`），不把 migrate 作为库依赖打进应用二进制。
- **一个迁移文件只放一条 DDL**。MySQL 的 DDL 会隐式提交，多语句文件中途失败会留下无法回滚的半截 schema。
- 顺序：`0001_users` → `0002_students` → `0003_guardians` → `0004_subjects` → `0005_classes` → `0006_class_enrollments` → `0007_lessons` → `0008_attendances` → `0009_leave_requests` → `0010_credit_packages` → `0011_credit_ledger` → `0012_trials` → `0013_follow_ups` → `0014_ai_decisions` → `0015_indexes_constraints`。
- **不使用 GORM AutoMigrate**（见 ADR-001：它改列的语义不可控，且没法产出可评审的迁移文件）。

### 建库与建账号（迁移前置步骤，用管理账号执行一次）

实测：`student_management` 库不存在（现有库 `geo` / `coking_plant` / `coking_assistant` / `golf`），必须先建库；管理账号含 `CREATE USER`，可建专用 app 账号。

```sql
-- 1) 建库
CREATE DATABASE student_management
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2) 专用 app 账号（应用运行时只用它）
CREATE USER 'ae_app'@'%' IDENTIFIED BY '<强随机口令>';
GRANT SELECT, INSERT, UPDATE, DELETE ON student_management.* TO 'ae_app'@'%';
FLUSH PRIVILEGES;

-- 3) 跑迁移（此时用管理账号，DSN 指向 student_management）
--    migrate -path backend/migrations \
--            -database "mysql://<admin>:<pw>@tcp(39.102.63.30:3306)/student_management" up

-- 4) 账本收权：credit_ledger 只留 SELECT + INSERT（ADR-008 第一层）
REVOKE UPDATE, DELETE ON student_management.credit_ledger FROM 'ae_app'@'%';
GRANT SELECT, INSERT ON student_management.credit_ledger TO 'ae_app'@'%';
FLUSH PRIVILEGES;

-- 5) seed（用管理账号）
--    mysql student_management < backend/seed/seed.sql

-- 6) 自检，结果打进应用启动日志
SHOW GRANTS FOR 'ae_app'@'%';
SELECT VERSION();
SELECT @@sql_mode;
```

注意：第 4 步必须在 `0011_credit_ledger` 建表**之后**执行（不能对不存在的表授权）。因此顺序固定为 建库 → 建账号 → migrate up → 收权 → seed。
`@@sql_mode` 实测含 `STRICT_TRANS_TABLES`、`ONLY_FULL_GROUP_BY`：seed 脚本必须显式给出字段类型与完整 GROUP BY，不能被严格模式拦下。

## Consequences

正面：
- 零学习成本，`up`/`down` 成对，回滚路径明确。
- MIT 许可，单二进制，README 里两行命令就能让别人跑起来。
- 迁移文件本身就是可评审的 schema 历史（作业要求保留完整 git 历史，这点加分）。

负面：
- 只有命令式 diff，没有 atlas 那种"声明目标态自动算差异"的能力。本项目 15 次迁移一次性写完，不需要。
- 每个文件都要手写 `down`。缓解：`down` 只做 `DROP TABLE` / `DROP INDEX`，保持简单。

风险：远程 MySQL 上跑 DDL 前必须先备份。seed 数据与迁移解耦（`seed/seed.sql` 单独执行）。迁移用管理账号、运行用 `ae_app`，两者不得混用（否则账本收权形同虚设）。

## Related ADRs
ADR-001（ORM）, ADR-008（账本表结构）
