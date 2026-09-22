# ADR-009: 排班冲突 — 事务内区间查询 + 父实体行锁 + 唯一约束兜底

## Status
Accepted (Phase 1)

## Background
R3 要求排班时校验：①学生周时段重叠 ②班级容量 ③余额 > 0。并发下两个 admin 同时把同一学生排进两个重叠的班，或两人同时抢最后一个座位，都必须被拦住。

## 验证到的事实

| 事实 | 来源 |
|---|---|
| InnoDB 默认 RR，范围 `SELECT ... FOR UPDATE` 会加 next-key/gap lock，理论上阻止区间插入 | MySQL 8.0 手册 17.7.1：`BETWEEN 10 and 20 FOR UPDATE` "prevents other transactions from inserting a value of 15" |
| **但实测 MySQL 8.0.x 在 READ COMMITTED 下范围加锁不阻塞 insert**；gap lock 只在 RR 生效，且查询必须走索引，否则退化为表锁 | 社区 5.7/8.0 × RR/RC 实测矩阵 |
| MySQL 没有 PostgreSQL 的 `EXCLUDE USING gist` 排它范围约束 | 能力事实；CHECK 只能做行内布尔表达式，不能跨行 |
| MySQL 8.0.16+ 的 CHECK 约束才真正生效 | caniusesql / MySQL 手册 |

## Decision

### 存储
`classes`：`weekday TINYINT`（0=周日..6=周六）、`start_min SMALLINT`、`end_min SMALLINT`（自 00:00 起的分钟数，墨尔本墙上时间）。用整数分钟而非 `TIME`：纯数值比较，可读、可索引、无隐式转换坑。
CHECK 钉死：`weekday BETWEEN 0 AND 6`、`end_min > start_min`、`end_min <= 1440`、`capacity > 0`。

### 事务（R3 完整实现）
```sql
START TRANSACTION;

-- (0) 串行化点：同一学生的排班变更互斥；同一班级的容量变更互斥
SELECT id FROM students WHERE id = :student_id FOR UPDATE;
SELECT id FROM classes  WHERE id = :class_id   FOR UPDATE;

-- (a) 学生周时段重叠：半开区间相交
SELECT c.id, c.name, c.start_min, c.end_min
FROM class_enrollments e JOIN classes c ON c.id = e.class_id
WHERE e.student_id = :student_id AND e.status = 'active'
  AND c.weekday = :weekday
  AND c.start_min < :end_min AND :start_min < c.end_min
LIMIT 1;

-- (b) 老师同一时段两个班
SELECT c.id FROM classes c
WHERE c.teacher_id = :teacher_id AND c.status='active' AND c.id <> :class_id
  AND c.weekday = :weekday
  AND c.start_min < :end_min AND :start_min < c.end_min
LIMIT 1;

-- (c) 容量
SELECT COUNT(*) FROM class_enrollments WHERE class_id = :class_id AND status='active';

-- (d) 余额（R6）
SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id = :student_id;

INSERT INTO class_enrollments (class_id, student_id, weekday, start_min, status, enrolled_on)
VALUES (:class_id, :student_id, :weekday, :start_min, 'active', :today);
COMMIT;
```

### 唯一约束兜底
把 `weekday`、`start_min` 冗余进 `class_enrollments`，加 `UNIQUE KEY uq_student_slot (student_id, weekday, start_min)`。数据库层挡住"同一学生同一周同一起始时间排两个班"这一最常见的重复排班，即便应用层被绕过或隔离级别被改。

### 为什么不用 gap lock
8.0.x 在 RC 下范围锁不阻塞 insert，连接池一旦被改成 RC 就静默失效。用 `students` / `classes` 的行锁作为**显式互斥点**，语义与隔离级别无关、行为可预测。加锁顺序固定"先 student 后 class"以避免死锁。

### 已知取舍（写进 DESIGN.md）
`uq_student_slot` 挡不住**起点不同但部分重叠**的排班（如 09:00–10:30 与 10:00–11:00）。PostgreSQL 有 `EXCLUDE USING gist` 可以，MySQL 没有。这部分只能由事务区间查询 (a) 覆盖。这是 MySQL 的能力边界，不是设计疏漏。

## Consequences

正面：
- 并发正确性不依赖隔离级别配置，行为可预测、可复现（curl 并发打两次即可演示）。
- 数据库层仍有一道唯一约束，符合"哪些用数据库约束"的评分点。
- 老师维度冲突 (b) 一并处理，覆盖"一个老师被排到两个班"的真实事故。

负面：
- 每行排班都要两次 `FOR UPDATE` 加锁。10 admin / 1000 学生规模下无影响。
- `weekday`/`start_min` 冗余字段存在与 `classes` 不同步的理论可能。缓解：写入时从 `classes` 读出后同一事务写入，不开放外部传参。

风险：忘记 `FOR UPDATE` → 并发双排班。缓解：所有写 `class_enrollments` 的路径必须走 `EnrollmentService.Enroll()` 单一入口（编译期约束 + 代码评审）。

## Related ADRs
ADR-007（weekday + 墙上时间存储）, ADR-008（余额查询与同类行锁约定）, ADR-010（规则落 service 层）
