# ADR-008: 课时账本 — Ledger 只增不改，三层防护

## Status
Accepted (Phase 1)

## Background
课时是家长已付的钱，账本必须不可篡改。R5 要求：Ledger 只增不改、余额 = `SUM(ledger)`。评分表明确看"知道哪些用数据库约束、哪些用业务逻辑"。

## 验证到的事实

| 事实 | 来源 |
|---|---|
| MySQL 8.0.16 起 CHECK 约束才真正强制执行；8.0.16 之前**解析但静默忽略** | MySQL 8.0 手册 / caniusesql 兼容性表 |
| MySQL 可按表授予 `INSERT` 而不授予 `UPDATE` / `DELETE` | MySQL GRANT 语法 |
| MySQL 唯一索引允许多个 NULL | MySQL 索引语义 |
| **实测（team-lead 连库）**：`VERSION() = 8.0.46` → CHECK 强制执行成立 | 阿里云 39.102.63.30:3306 |
| **实测**：`SHOW GRANTS` 含 `ALL PRIVILEGES ON *.*` + `SUPER` + `CREATE USER` → 可自建专用 app 账号做按表授权 | 同上 |

## Decision

### 表结构（关键：没有 `updated_at`，没有 `deleted_at`）
```sql
CREATE TABLE credit_ledger (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id    BIGINT UNSIGNED NOT NULL,
  package_id    BIGINT UNSIGNED NULL,
  delta         INT NOT NULL COMMENT '正=进，负=出',
  reason        ENUM('purchase','consume','leave_adjust','manual_adjust','refund','transfer_out') NOT NULL,
  lesson_id     BIGINT UNSIGNED NULL,
  attendance_id BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  note          VARCHAR(255) NULL,
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_delta_nonzero CHECK (delta <> 0),
  INDEX idx_ledger_student (student_id, created_at),
  UNIQUE KEY uq_ledger_consume (student_id, lesson_id, reason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`uq_ledger_consume` 是**幂等闸门**：同一学生同一节课同一原因只能产生一条流水（`lesson_id IS NULL` 的购买/退款条目因多 NULL 不受影响）。直接防住重复点击结算导致的重复扣课时。

### 三层防护（**实测成立后，三层全做，不采用退化方案**）

实测依据：`VERSION() = 8.0.46`（>= 8.0.16，CHECK 强制执行）；`SHOW GRANTS` 含 `CREATE USER`，可自建专用 app 账号。原先"共享实例可能拿不到独立账号 → 退化为两层"的风险**已消除**。

**建账号语句**（由具备 `CREATE USER` 权限的管理账号执行一次，见 ADR-002）：
```sql
CREATE USER 'ae_app'@'%' IDENTIFIED BY '<强随机口令>';
GRANT SELECT, INSERT, UPDATE, DELETE ON student_management.* TO 'ae_app'@'%';
-- 账本收权：撤销全库写权限后只放回 SELECT + INSERT
REVOKE UPDATE, DELETE ON student_management.credit_ledger FROM 'ae_app'@'%';
GRANT SELECT, INSERT ON student_management.credit_ledger TO 'ae_app'@'%';
FLUSH PRIVILEGES;
-- 自检（把结果打进启动日志，演示时可直接展示）
SHOW GRANTS FOR 'ae_app'@'%';
```
应用运行时**只使用 `ae_app`**；迁移与建账号用管理账号，两者分离。

| 层 | 措施 | 能挡住什么 |
|---|---|---|
| 数据库 | ①app 账号 `ae_app` 对 `credit_ledger` 只有 `SELECT, INSERT`（全库的其他表仍有 UPDATE/DELETE）②`CHECK(delta<>0)`（8.0.46 实测强制执行）③无 `updated_at`/`deleted_at` 列 ④`uq_ledger_consume` 幂等 | 绕过应用直连数据库也改不动历史流水；重复扣课时 |
| Repository | `CreditRepository` **只暴露** `Insert(ctx, tx, entry)` 与 `SumBalance(ctx, tx, studentID)`，**不存在** Update/Delete 方法 | 应用层调不到改流水的入口（编译期约束） |
| Service | 唯一入口 `CreditService.Apply(ctx, tx, entry)`：强制 `actor_user_id`、`reason` 白名单、写前必先锁 `students` 行 | 业务侧无法绕过审计字段与串行化 |

### 余额并发安全扣减（出勤结算）
```sql
START TRANSACTION;
SELECT id FROM students WHERE id = :student_id FOR UPDATE;      -- 该学生账务串行化点
SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id = :student_id;
-- present/late/absent/leave_late => delta = -1；leave_approved(>=24h请假) => 不写流水
INSERT INTO credit_ledger (student_id, package_id, delta, reason, lesson_id,
                           attendance_id, actor_user_id, note, created_at)
VALUES (:student_id, NULL, -1, 'consume', :lesson_id, :attendance_id, :actor, NULL, :now);
UPDATE attendances SET status=:status, recorded_by_user_id=:actor, recorded_at=:now
WHERE lesson_id=:lesson_id AND student_id=:student_id;
COMMIT;
```

**约定：任何写 `credit_ledger` 的事务，第一行必须是 `SELECT id FROM students WHERE id=? FOR UPDATE`。** MySQL 无法对聚合结果加锁，只能锁一个真实存在的行——`students` 行就是该学生的账务互斥量。

### 余额读取
`SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id=?`。列表页需要按余额筛选时走视图/子查询，**不冗余 `students.credit_balance` 字段**（冗余必然与流水不一致，而 R5 明确要求余额 = sum）。

### 退款/补偿（追问"课时怎么退"）
- 退未消耗课时：`credit_packages.status='refunded'` + append `reason='refund'`、`delta = -当前余额`。
- 退已扣的那节：`reason='manual_adjust'`、`delta=+1`、`note` 写明原因与审批人。
两者都不 UPDATE 任何历史流水。

## Consequences

正面：
- 三层都能在演示时指着具体位置讲：权限（`SHOW GRANTS FOR 'ae_app'@'%'` 直接展示 credit_ledger 上只有 SELECT, INSERT）、表结构（`SHOW CREATE TABLE` 里没有 `updated_at`）、代码（Repository 无 Update 方法）。
- "绕过应用也改不动流水"这条最硬的证据现在由数据库权限层直接提供，不靠应用层自律。
- 幂等唯一约束让"重复结算"这个高频 bug 在数据库层就死掉。
- `VERSION() = 8.0.46` + `sql_mode` 含 `STRICT_TRANS_TABLES`：截断与非法值直接报错，账务写路径不会被静默降级。

负面：
- 每次余额读取都是一次聚合。数据量（~1000 学生 × 几十条流水）下可忽略；真到瓶颈再加视图或缓存，且缓存只能是"派生读"，不参与写路径。
- 允许余额为负（已排的课照扣，不然学生白上课），需要 UI 明确区分"预警"与"透支"。
- 双账号（迁移用管理账号 / 运行用 `ae_app`）增加一处运维配置面，README 必须写清。

风险（降级触发条件，已由实测排除但保留预案）：若将来换到不提供 `CREATE USER` 的托管实例，则**退化为 CHECK + Repository 两层**，并在启动时 `SHOW GRANTS` 打进日志作为证据。**约束不变：三层里至少要有一层落在数据库。**

## Related ADRs
ADR-001（手写 SQL）, ADR-007（`created_at` 由 Go 写入）, ADR-009（同类行锁约定）
