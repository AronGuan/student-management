# ADR-007: 时间全部按 Australia/Melbourne 墙上时钟处理，DATETIME 存储，二进制内嵌 tzdata

## Status
Accepted (Phase 1)

## Background
作业硬约束：所有时间按 `Australia/Melbourne` 处理，**不做任何时区转换**。系统在 Windows 上开发、在 Linux(systemd) 上部署，连阿里云 MySQL 8。核心风险是 Go 在 Windows 上找不到 IANA tzdata，以及 MySQL 会话时区与 Go 侧不一致导致的静默偏移。

## 验证到的事实

| 事实 | 来源 |
|---|---|
| Windows 无系统级 IANA tzdata，`time.LoadLocation` 失败（"unknown time zone" / "The system cannot find the path specified"）；装了 Go 的机器会碰巧走 `$GOROOT/lib/time/zoneinfo.zip` 成功，形成 works-on-my-machine | golang/go#50248（Windows/amd64, go1.17），解法原文："import `_ time/tzdata`" |
| `import _ "time/tzdata"` 把 tzdata 嵌进二进制，约 +450KB | Go 官方 `time/tzdata` 文档 |
| `go-sql-driver` 的 `loc` 参数走 `time.LoadLocation`，同样受影响；`loc` 默认 **UTC**；`/` 必须转义为 `%2F` | 驱动 README |
| `loc` **只**设置 Go 侧 `time.Time` 的 location，**不改** MySQL 的 `time_zone` | 驱动 README 原文："does not change MySQL's time_zone setting" |
| 发送 `time.Time` 参数时驱动按 `t.In(cfg.loc)` 后格式化为 `'2006-01-02 15:04:05'` | 驱动源码 `packets.go` 写入路径 |
| 读取时 `parseTime=true` 下 DATE / DATETIME / TIMESTAMP 均返回带 `loc` 的 `time.Time` | 驱动行为实测（v1.5.0 源码走读） |
| `time_zone` 系统变量需 MySQL 已加载时区表，共享实例常为空，会报 ERROR 1298 | MySQL 时区支持文档 |
| **实测（team-lead 连库）**：`@@system_time_zone = CST`、`@@global.time_zone = SYSTEM`、`@@session.time_zone = SYSTEM` | 阿里云 39.102.63.30:3306 实测 |

## Decision

1. **`cmd/server/main.go` 顶部必须 `import _ "time/tzdata"`**。硬要求，不是可选优化——否则在没有 Go 环境的机器上启动即失败。
2. **DSN**：
   ```
   user:pass@tcp(39.102.63.30:3306)/austin?parseTime=true&loc=Australia%2FMelbourne&charset=utf8mb4&collation=utf8mb4_0900_ai_ci
   ```
3. **不使用 `time_zone` DSN 参数**（依赖 MySQL 时区表，共享实例不可靠）。
4. **硬约束（不是建议）—— SQL 中禁止 `NOW()` / `CURDATE()` / `CURRENT_TIMESTAMP` 参与业务语义**。
   **实测依据**：`@@session.time_zone = SYSTEM`、`@@system_time_zone = CST`（team-lead 连库实测）。服务器会话时区是中国标准时，依赖服务器时钟写入的值会静默错 2 小时（冬令时）或 3 小时（夏令时）——不报错、不崩溃、只是算错，是最难发现的沉默逻辑错误。
   执行：所有业务时间由 Go 侧 `internal/pkg/clock.Now()` 显式传参。评审 checklist：SQL 中出现 `NOW(` / `CURDATE(` / `CURRENT_TIMESTAMP` 一律打回。
5. **表的 `created_at` 保留 `DEFAULT CURRENT_TIMESTAMP` 仅供运维审计，业务代码与任何查询条件都不得读取它；`credit_ledger.created_at` 由 Go 显式写入**（账务时间必须准）。
6. **时间列统一 `DATETIME(3)`，不用 TIMESTAMP**。理由：TIMESTAMP 存 UTC 并按会话 `time_zone` 读写转换，语义依赖服务器配置，与"不做时区转换"直接冲突；上限 2038；DATETIME 是墙上时钟，正是所需语义。
7. **排班存 `weekday`（0=周日..6=周六，对齐 `DAYOFWEEK()-1`）+ `start_min`/`end_min`（自 00:00 起的分钟数）**，不存 UTC。这是 DST-safe 的：夏令时切换时每周固定时段的课在墙上时间上不变，正是业务语义。
8. **代码评审硬规则：禁止裸 `time.Now()` / `time.Now().UTC()`**，`internal/pkg/clock` 是唯一取时间入口。24h 请假阈值判定也一律用 clock。

## Consequences

正面：
- 二进制自包含 tzdata，开发机 / 部署机 / 面试官电脑行为一致。
- 墙上时钟 + weekday/分钟数存储，让 DST 这个隐形难题自然消失，不需要任何"时区转换"代码。
- 禁用 `NOW()` 与 TIMESTAMP 让业务时间完全不依赖服务器配置。实测 `system_time_zone = CST`（会比墨尔本慢 2–3 小时），这条决策把一个静默 2 小时的系统性偏差在发生前就消除了。

负面：
- 二进制 +450KB。对本项目无所谓。
- 禁用 `NOW()` 意味着每次 INSERT 都要多传一个参数，样板略增。

风险（最高危）：Go 侧混用 UTC 时间与 Melbourne 时间 → 传参时被 `t.In(loc)` **二次偏移**，静默算错 10 或 11 小时。这是典型的"沉默逻辑错误"（编译过、跑得动、结果错）。缓解手段就是第 8 条的唯一入口约定 + 针对 `clock` 的单元用例（构造一个已知 Melbourne 时间，断言写入字符串）。

## Related ADRs
ADR-008（ledger.created_at 由 Go 写入）, ADR-009（weekday + start_min 存储）
