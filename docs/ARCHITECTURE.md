# ARCHITECTURE.md — Austin Education 学生管理系统

> 版本：v1.0（Phase 1 调研/选型产物）
> 定位：这不是学生 CRUD，而是一个**预付费履约系统**。课时 = 家长已付的钱 + 库存 + 排期承诺。全系统围绕"课时怎么来的、怎么没的"建模。
> 工时预算：10 小时（git init 起算）。本文所有选型的第一权重是**实现速度**，第二权重是**规则能否在服务端被证明拦得住**。

---

## 1. 技术栈基线与版本锚定

技术栈已锁定（Vite + React + TS / Go + Gin / MySQL 8 / Nginx + systemd / DeepSeek），本节只锚定版本与"未锁定项"的结论。

### 1.1 后端（Go 1.24+）

| 模块 | 锚定版本 | 用途 |
|---|---|---|
| `github.com/gin-gonic/gin` | v1.12.0 | HTTP 路由 / 中间件 |
| `gorm.io/gorm` | v1.31.2 | 常规 CRUD |
| `gorm.io/driver/mysql` | v1.6.0 | MySQL 驱动 |
| `github.com/go-sql-driver/mysql` | v1.10.1 | DSN 参数 `parseTime` / `loc` |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | JWT 签发 / 校验 |
| `github.com/golang-migrate/migrate/v4` | v4.20.1 | 迁移（CLI 二进制，非库依赖） |
| `github.com/sashabaranov/go-openai` | v1.42.1 | DeepSeek（OpenAI 兼容协议） |

`go-playground/validator/v10` 不单独引入，直接用 gin 内置 binding 校验。

### 1.2 前端

| 包 | 锚定版本 | 用途 |
|---|---|---|
| `react` / `react-dom` | 19.3.0 | UI |
| `vite` | 8.3.0 | 构建 |
| `@vitejs/plugin-react` | 6.1.1 | — |
| `typescript` | 由 `npm create vite@latest` 生成的版本锁定，禁止跨大版本升级 | — |
| `@tanstack/react-query` | 5.103.2 | 服务端状态 |
| `react-router-dom` | 7.18.4（**有意不升 8.x**：v8 有大版本 API 变动，10h 预算下不值得花时间迁移；路由需求仅 6 个页面，v7 完全够用） | 路由 |
| `tailwindcss` + `@tailwindcss/vite` | 4.3.3 | 样式 / Design Token |
| `lucide-react` | **1.47.0**（ISC 许可） | **唯一图标源** |

### 1.3 数据库

MySQL 8（阿里云 `39.102.63.30:3306`）。

**实测结论（team-lead 已连库验证，账号 `geo@%`）**：

| 项 | 实测值 | 对设计的影响 |
|---|---|---|
| `SELECT VERSION()` | **8.0.46** | >= 8.0.16，**CHECK 约束确实强制执行**。ADR-008 的 `CHECK(delta<>0)` 直接启用，不需要降级为纯应用层校验 |
| `SHOW GRANTS` | `ALL PRIVILEGES ON *.*` + `SUPER` + `CREATE USER` + `CREATE ROLE` | **可自建专用 app 账号**，对 `credit_ledger` 只授 `SELECT, INSERT`。ADR-008 三层防护**全做**，不采用退化方案 |
| `@@system_time_zone` / `@@session.time_zone` | **CST** | 服务器会话时区是中国时间。任何 `NOW()` / `CURDATE()` / `DEFAULT CURRENT_TIMESTAMP` 写进去的都是中国时间 → **禁令从"建议"升级为硬约束**（ADR-007） |
| 现有库 | `geo` / `coking_plant` / `coking_assistant` / `golf` | **`student_management` 库不存在**，迁移第一步必须 `CREATE DATABASE` |
| `@@sql_mode` | 含 `STRICT_TRANS_TABLES`、`ONLY_FULL_GROUP_BY` | 严格模式：插入截断直接报错（对账务是好事）；seed 脚本必须显式字段类型；聚合查询必须满足 ONLY_FULL_GROUP_BY |

---

## 2. 未锁定项选型矩阵

### 2.1 ORM：GORM vs sqlc vs ent vs database/sql

| 方案 | 10h 内实现速度 | 类型安全 | 事务/锁可控性 | 学习/搭建成本 | 结论 |
|---|---|---|---|---|---|
| **GORM** | 高（模型即迁移文档，`Transaction` + `clause.Locking{Strength:"UPDATE"}` 开箱即用） | 中（查询靠字符串/结构体，编译期不校验 SQL） | 高（可随时 `Raw`/`Exec` 逃生到手写 SQL） | 低（无需 codegen 步骤） | **选它** |
| sqlc | 中（每张表要手写 SQL + 生成代码，15 张表约 1.5h） | 高（生成强类型） | 高 | 中（多一个 build 步骤 + CI 依赖） | 不选 |
| ent | 低（schema DSL + 图遍历心智负担） | 高 | 中（锁/原生 SQL 需绕） | 高 | 不选 |
| database/sql | 低（手写 Scan 样板，15 张表 × CRUD 会吃掉大半预算） | 中 | 最高 | 低 | 不选 |

**结论：GORM 作为默认，三条关键路径强制手写 SQL**（见 §5 排班冲突、§6 课时账本、余额聚合）。理由：GORM 省下的是 15 张表的样板时间；而面试官要看的"规则在哪一层执行"，恰恰是手写 SQL + 事务最能证明的地方。混用不矛盾——GORM 的 `db.Exec`/`db.Raw` 就是逃生口。

风险与对策：GORM 的 `Save`/`Updates` 会隐式写入零值、且默认允许全表更新。对策：repository 层禁止裸 `db.Updates`，所有写操作显式 `Select` 字段或走 `Exec`；并在 `gorm.Config` 里不做 `DisableForeignKeyConstraintWhenMigrating`。

### 2.2 迁移工具：golang-migrate vs atlas vs goose

| 方案 | 理念 | 搭建成本 | MySQL DDL 语义 | 结论 |
|---|---|---|---|---|
| **golang-migrate** | 命令式版本化 SQL（up/down 成对） | 最低（单二进制 + `migrations/*.up.sql`） | 明确（DDL 隐式提交，一文件一语句） | **选它** |
| goose | 命令式（SQL 或 Go 函数） | 低 | 同 | 备选 |
| atlas | 声明式 schema-as-code，自动 diff | 中高（要写 HCL/SQL 目标态） | 自动生成的 plan 可能触发昂贵 DDL | 不选（10h 项目不需要 diff 能力，且高级特性在 Pro 版） |

**结论：golang-migrate v4.20.1**，文件命名 `0001_init.up.sql` / `0001_init.down.sql`。硬规则：**一个迁移文件只放一条 DDL**（MySQL 的 DDL 隐式提交，多语句中途失败会留下半截 schema，无法回滚）。

### 2.3 认证：JWT 方案细节

| 决策点 | 结论 |
|---|---|
| 算法 | **HS256**（单服务、单密钥；RS256 在本项目没有多方验签需求，只增加配置负担） |
| 密钥 | 环境变量 **`JWT_SECRET`**（`config/config.go:24`、`:45`），**有默认值 `dev-only-secret-change-me`**，启动**既不校验长度也不 panic**。`.env.example` 只放占位、`.env` 不进仓库，生产由 systemd 显式注入（见 §8）。ADR-003 当初写的「缺失即 panic」**从未实现** |
| Claims | `sub`(**username**，`middleware/auth.go:49`) `uid`(user_id，自定义字段，不在 JWT 标准集里) `role` `name` `iat` `exp`。**没有 `sid`**；`jti` 从未填充（`RegisteredClaims.ID` 留空 ⇒ 整键缺席） |
| TTL | **Access Token 8 小时**（一个工作日），**MVP 不实现 refresh token**（明确降级，见 ADR-003） |
| 传递方式 | **双通道**：浏览器走 httpOnly Cookie `ae_token`（SameSite=Lax，生产加 Secure；Vite dev 用 `server.proxy` 把 `/api` 代理到 `127.0.0.1:8080` 保证同源）；curl / Postman 走 `Authorization: Bearer <token>` |
| CSRF | `SameSite=Lax` 的 httpOnly Cookie（跨站表单提交带不上凭据）+ CORS 只放行 Vite 两个源（`handler/router.go:39-46`）。**没有独立的 Origin 校验中间件**：跨站读取由 CORS 阻断，跨站写入由 SameSite 阻断 |
| Gin 中间件 | 只有两个：`middleware.AuthRequired(secret)` 从 httpOnly Cookie 或 `Authorization: Bearer` 取 token，校验后注入 `middleware.CurrentUser{ID, Role, Name}`；`middleware.RequireRoles(...)` 做角色准入。**R7 的归属校验不在中间件链上**——写路径的 URL 参数是 trial / follow_up / lesson 的 id，从它推不出 `student_id`，所以校验落在 service 层，由 `StudentService.AssertOwner`（`service/student.go:18`）逐路径显式调用 |
| 口令 | bcrypt（`golang.org/x/crypto/bcrypt`），cost 10 |

**为什么双通道**：评分项明说"我们会绕过界面直接测"。curl 能一行带上 Bearer 直接打服务端，是展示"规则在服务端"的最快路径；同时浏览器侧仍走更安全的 httpOnly Cookie。

### 2.4 前端数据请求与状态管理

| 方案 | 10h 内实现速度 | 缓存/失效 | loading/empty/error 状态 | 结论 |
|---|---|---|---|---|
| **TanStack Query v5** | 高（`useQuery` 自带 loading/error；`useMutation` + `invalidateQueries` 一行解决写后刷新） | 内建 | 内建 | **选它** |
| SWR | 中高（mutate/invalidate 的心智负担略高） | 内建 | 内建 | 备选 |
| 裸 fetch + useEffect | 低（竞态、重复请求、手写 loading/error/refetch，5 个页面会写出 5 套 bug） | 无 | 手写 | 不选 |

**结论：@tanstack/react-query 5.103.2 + 一个薄 `apiClient`（fetch 封装，统一注入 credentials 与错误码映射）。**
明确**不引入 Redux / Zustand**：本产品没有跨页面的复杂客户端状态。唯一的全局状态是"当前登录者"，用一个 `AuthContext` 即可。

`apiClient` 契约：所有响应按 `{code, data, message}` 解包；`code != 0` 抛 `ApiError{code, message, httpStatus}`；401 清 AuthContext 并跳登录。`openapi.yaml` 生成 TS 类型（用 `openapi-typescript`，生成的 `types.ts` 直接 import）。

### 2.5 前端 UI 库与图标库

| 方案 | 10h 内实现速度 | Design Token 可控性 | 视觉风险 |
|---|---|---|---|
| **Tailwind v4 + 自建 ~8 个基础组件** | 中高（组件一次写好复用） | **最高**（`@theme` 里定义语义 token，组件只引用 token） | 无（自建即自洽） |
| shadcn/ui（Radix + Tailwind） | 高（组件现成、可访问性好） | 高（源码进仓库，可改） | 低；但多一层 CLI/配置 |
| Ant Design | **最高**（Table/Form/DatePicker 开箱即用） | 低（默认视觉强 opinon，覆盖成本高） | **"后台模板味"**，与 P0 规则冲突 |

**结论：Tailwind CSS v4.3.3 + 自建组件层，不引入 Ant Design。**
自建组件清单（每个 <= 120 行）：`Button` `Input` `Select` `Table` `Badge` `Modal`（基于原生 `<dialog>`）`EmptyState` `Toast` `StatCard` `Skeleton`。
不引入 Radix：`<dialog>` + `<select>` 原生元素在桌面端 Chrome 足够用，省下 30–45 分钟配置时间。

#### 2.5.1 图标库锁定（P0）

**全项目唯一图标源：`lucide-react@1.47.0`（ISC 许可，4270 个 SVG 组件，ESM tree-shakable，React 19 兼容）。**

- 允许尺寸：**仅 16 / 20 / 24 px**（`size` prop）。默认 20，表内行内图标 16，空状态/大按钮 24。
- 描边宽度统一 `strokeWidth={1.75}`（默认 2 在 16px 下偏重）。
- 颜色一律 `currentColor`，由外层文字色 token 决定，**禁止给图标写死色值**。
- 禁止引入第二套图标库（`@heroicons/*`、`react-icons`、`@phosphor-icons/*`、`antd` icons、`react-feather`）。
- 禁止 emoji 作为功能图标或状态图标。

**可执行 Enforcement（三条，缺一不可）：**

1. ESLint `no-restricted-imports`：
```json
{
  "rules": {
    "no-restricted-imports": ["error", {
      "patterns": [
        { "group": ["@heroicons/*", "react-icons", "react-icons/*", "@phosphor-icons/*", "react-feather", "@tabler/icons-react", "antd"], "message": "图标只能来自 lucide-react" }
      ]
    }]
  }
}
```
2. `frontend/scripts/check-no-emoji.mjs`：命中 Unicode emoji / dingbat 区间（`U+1F000–U+1FAFF`、`U+2600–U+27BF`、`U+FE0F`、`U+2B00–U+2BFF`）即 `process.exit(1)`。挂到 `npm run lint`。
   **扫描范围（team-lead 裁定）**：
   - **零容忍**：`frontend/src/**`、`backend/**` —— 出现即失败。
   - **豁免**：`docs/**/*.md` —— ASCII 线框图需要 `⚠` `⬭` `⬚` `✕` `✚` 这类占位符，豁免的是**文档线框**，不是实现。实现时一律换成 lucide-react 具名图标。
3. `frontend/scripts/check-no-hex.mjs`：扫描 `src/**`，命中 `#` + 3/6/8 位十六进制即报错，**白名单仅 `#fff` / `#000`**（Tailwind 的 `@theme` 定义文件 `src/styles/tokens.css` 例外，它本身就是 token 源）。挂到 `npm run lint`。

#### 2.5.2 Design Token

**唯一源：`docs/UIUX.md` §3.2 的 token 定义（Petrol Blue `#0F5C73` 主色体系）。ARCHITECTURE 不另立色板。**

收敛依据（架构侧只做裁定，不重复定义）：

| 项 | 结论 |
|---|---|
| 主色 | `--accent: #0F5C73`（石油蓝-深青）。UIUX 已给出选色理由：澳洲海港意象、与"课时是钱"的财务属性匹配、**刻意避开 Indigo / Violet 系**（直接满足 P0 规则 ②）、不与语义色抢车道 |
| 语义色 | `--success #15803D` / `--warn #B45309` / `--danger #B91C1C`，业务绑定不可挪用（出勤、低课时、旷课与流失风险） |
| 中性 | `--fg #1B1C1F` / `--muted #6C6F78` / `--bg #F4F5F6` / `--surface #FFFFFF` |
| 落地方式 | Tailwind v4 的 `@theme` 把上述 CSS 变量映射为工具类（`--color-accent: var(--accent)` 等），组件层只引用 `@theme` 导出的语义名 |

架构侧追加的三条硬规则（UIUX 定义值，ARCHITECTURE 定义约束）：

1. **禁止紫→粉渐变**；全局无渐变主视觉，层级靠 1px hairline 与 `--surface-sunken` 底色（与 UIUX 的 `VISUAL_DENSITY=7` 一致）。
2. **状态必须三通道冗余**：颜色 + 形状/图标 + 文本，去掉任一仍能表达（UIUX §4 已定，架构侧把它列为验收项：截图转灰度后状态须仍可读）。
3. **图标不得使用 dingbat / 几何字符占位**。UIUX 的 ASCII 线框图里出现的 `⚠` `⬭` `⬚` `✕` `✚` `▸` `▾` 只是线框占位符，**不得进入代码**；实现时一律换成 lucide-react 具名图标（UIUX 已在图标列给出 `calendar-clock` / `x` / `user-round-plus`，与 ADR-005 的 lucide-react 锁定一致）。`scripts/check-no-emoji.mjs` 覆盖 `U+2600–U+27BF` 与 `U+2B00–U+2BFF`，正是这批字符，会被 CI 拦下。

---

## 3. 分层架构

```
┌───────────────────────── 浏览器 (Vite dev / Nginx prod) ─────────────────────────┐
│ React 19 SPA                                                                     │
│  routes → src/pages/*（页面容器）→ src/lib/api.ts（fetch 封装 + openapi 类型）      │
│  components/ui/*（自建，只吃 tokens）  lucide-react（唯一图标源）                  │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │ /api/v1  (同源：Vite proxy 或 Nginx 反代)
┌───────────────────────────────────▼──────────────────────────────────────────────┐
│ Go + Gin                                                                          │
│  middleware: AuthRequired(JWT) → RequireRoles（R7 在 service 层，不在链上）        │
│  handler  : 只做 解析参数 / 绑定校验 / 调 service / 装响应。不含任何业务规则          │
│  service  : 【R1-R8 唯一落地处】编排事务、直接读写库、调 llm                         │
│  repo     : 连接池 / DB 句柄（CRUD 与手写 SQL 直接写在 service）                    │
│  llm      : DeepSeek 客户端 + 结构化校验 + 降级                                     │
│  model    : 实体 / 枚举 / 生命周期常量（GORM 标签直接写在结构体上）                 │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │ go-sql-driver  parseTime=true&loc=Australia%2FMelbourne
┌───────────────────────────────────▼──────────────────────────────────────────────┐
│ MySQL 8  InnoDB                                                                   │
│  CHECK 约束(8.0.16+) / 唯一约束 / 外键 / 事务 + 行锁                                │
│  app 账号对 credit_ledger 只有 SELECT+INSERT，无 UPDATE/DELETE                      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**依赖方向单向**：`handler → service → model`（`apierr` / `clock` 是叶子工具包）。`service` 不 import `gin`。**没有独立的 `repository` 层、也没有零外部依赖的 `domain` 包**：实体 / 枚举 / 生命周期常量都在 `internal/model`，GORM CRUD 与手写 SQL 直接写在 `service`（少数列表查询在 handler，见 `handler/trial.go`）。

### 3.1 目录结构（可执行约束）

```
take-home/
├── DESIGN.md                     # ≤3 页，Part A 交付物
├── README.md                     # 跑起来的步骤 + AI 工具使用说明
├── docs/
│   ├── ARCHITECTURE.md
│   ├── openapi.yaml              # 前后端唯一契约
│   └── decisions/ADR-001..ADR-010.md
├── backend/
│   ├── cmd/server/main.go        # 入口：只装配，不含业务
│   ├── internal/
│   │   ├── config/               # 环境变量 → Config，缺关键项 panic
│   │   ├── domain/               # 实体 + 枚举 + 规则常量（无 import 外部包）
│   │   ├── repository/           # 按资源分包：student_repo.go / class_repo.go /
│   │   │                         #   lesson_repo.go / credit_repo.go / followup_repo.go
│   │   ├── service/              # 按资源分包，R1-R8 全在这里
│   │   ├── handler/              # 按资源分包
│   │   ├── middleware/
│   │   ├── llm/                  # deepseek.go / schema.go / fallback.go
│   │   └── pkg/                  # apierr / clock(Melbourne) / tx
│   ├── migrations/               # golang-migrate：一文件一 DDL
│   ├── seed/                     # seed.sql（2 admin × ~12 学生 + 20 老师 + 60 课/周）
│   └── go.mod
├── frontend/
│   ├── src/{api,components,features,styles,lib}/
│   ├── scripts/{check-no-emoji.mjs,check-no-hex.mjs}
│   └── package.json
└── deploy/{nginx.conf,ae-api.service}
```

硬规则：**单文件 <= 300 行**；**单一职责**（一个文件一个资源/一个用例）；**`cmd/server/main.go` 只做装配**（读配置 → 连库 → 建 router → Listen）。

---

## 4. 四项关键可行性验证

### A. DeepSeek structured output 边界

**验证结论：可行，但不能依赖服务端 strict 模式。**

| 事实 | 证据 |
|---|---|
| Chat Completions 的 `response_format` 官方只文档化 `text` 与 `json_object` 两种 | `api-docs.deepseek.com/guides/json_mode`：使用条件为 ①`response_format={'type':'json_object'}` ②**提示词里必须出现 "json" 一词并给出期望格式示例** ③合理设置 `max_tokens` 防截断 |
| `json_schema` 类型只在 **Responses API**（`text.format.type=json_schema`，需带 `name` + schema）被文档化 | `api-docs.deepseek.com/zh-cn/api/create-response/`：`type` 可选 `text` / `json_object` / `json_schema` |
| 严格结构化另有 "strict tool calling"，但**需要 beta base URL `https://api.deepseek.com/beta` 且 `strict:true`**，官方标注 Beta 不稳定 | DeepSeek Tool Calls 指南 / API 升级公告（news0725）：Beta 接口"subsequent testing and release plans may change flexibly" |
| **JSON Output 偶发返回空 content**（官方已知问题） | json_mode 指南原文："the API may occasionally return empty content. We are actively working on optimizing this issue." |
| Go 侧可用 `github.com/sashabaranov/go-openai` 通过自定义 `BaseURL` 对接 | 官方 README：`config := openai.DefaultConfig(key); config.BaseURL = "..."; openai.NewClientWithConfig(config)`；社区与云厂商文档均以该方式接入 DeepSeek |

**落地决策（ADR-006）**：

1. 用 **Chat Completions + `response_format: {type:"json_object"}`**，模型用 `deepseek-chat`（非 reasoner：思考模式下 temperature/top_p 不生效，且输出分离，不利于抽取）。
2. 系统提示词必须包含 "json" 字样 + 完整 JSON 示例 + "只输出 JSON，不要 Markdown 代码围栏"。
3. `max_tokens` 给足（>= 1024），并检查 `finish_reason == "stop"`；`finish_reason == "length"` 直接判为无效。
4. Go 侧防御式解析：先 `strings.TrimSpace`，再剥掉可能的 ```` ```json ```` 围栏，再 `json.Unmarshal` 到结构体。
5. **服务端枚举白名单校验（R8）**：解出来后逐字段校验枚举值 ∈ 白名单、数值在范围内、字符串长度上限。任一不合法 → 记为 `ai_status='invalid'`。
6. **降级**：最多重试 1 次（换更短的提示词）；仍失败或超时（8s）→ `ai_status='unavailable'`，前端渲染**规则引擎兜底卡**（纯数据推导：试听次数、距试听天数、余额、出勤率、跟进是否逾期），并展示"AI 不可用，已用规则兜底"。
7. **系统动作零依赖 LLM**：48h 跟进 SLA（R2）、余额 ≤4 预警（R6）全部由定时任务/查询实现，LLM 只产出"建议卡片"，不触发任何写操作。

**风险**：
- R1：空 content / 非 JSON → 已由第 4–6 步兜住，最坏是决策卡不可用，主流程不受影响。
- R2：`json_object` 保证的是**合法 JSON 语法**，不保证业务 schema。因此第 5 步的枚举白名单是必须的，不能省。
- R3：DeepSeek 免费额度/限流（429）。对策：`llm` 层加 8s 超时 + 单飞（同一 student+kind 60s 内不重复请求，`ai_decisions` 表查最近一条）。

### B. Go 在 Windows 上加载 Australia/Melbourne 时区

**验证结论：`import _ "time/tzdata"` 是必需的，不是可选的。**

| 事实 | 证据 |
|---|---|
| Windows 没有系统级 IANA tzdata，`time.LoadLocation` 会失败（报 "unknown time zone" 或 "The system cannot find the path specified"）；装了 Go 的机器会碰巧走 `$GOROOT/lib/time/zoneinfo.zip` 成功，形成 "works on my machine" | golang/go#50248（Windows/amd64，go1.17）："binaries of my program worked fine for me, but not for my users that did not have Go installed"；解法原文："the solution to this problem is to import `_ time/tzdata`" |
| `import _ "time/tzdata"` 把 tzdata 嵌进二进制，约 +450KB | Go 官方 `time/tzdata` 文档 |
| `go-sql-driver` 的 `loc` 参数会走 `time.LoadLocation`，因此同样受上一条影响 | 驱动 README：`loc` — "Sets the location for time.Time values (when using parseTime=true)... See time.LoadLocation for details" |
| `loc` **只**决定 Go 侧 `time.Time` 的 location，**不改** MySQL 会话 `time_zone` | 驱动 README 原文："this sets the location for time.Time values but does not change MySQL's time_zone setting" |
| 发送 `time.Time` 参数时，驱动按 `t.In(cfg.loc)` 后格式化成 `'2006-01-02 15:04:05'` 字符串 | 驱动源码 `packets.go` 写入路径（v1.5.0 起即 `t.In(mc.cfg.loc).Format(timeFormat)`） |
| 读取时 `parseTime=true` 下 DATE/DATETIME/TIMESTAMP 均返回带 `loc` 的 `time.Time` | 驱动行为实测（javorszky 2020 对 v1.5.0 的源码走读） |
| **实测（team-lead 连库）**：`@@system_time_zone = CST`、`@@global.time_zone = SYSTEM`、`@@session.time_zone = SYSTEM` | 阿里云 39.102.63.30:3306 实测。服务器会话时区是中国标准时 → `NOW()` / `CURDATE()` / `DEFAULT CURRENT_TIMESTAMP` 写进去的值比墨尔本慢 2h（冬令时）或 3h（夏令时），且不报错 |

**落地决策（ADR-007）**：

1. `cmd/server/main.go` 顶部 `import _ "time/tzdata"`。**这是硬要求**，否则在没有 Go 环境的机器上（systemd 部署机 / 面试官电脑）直接启动失败。
2. DSN：`user:pass@tcp(39.102.63.30:3306)/austin?parseTime=true&loc=Australia%2FMelbourne&charset=utf8mb4&collation=utf8mb4_0900_ai_ci`
   - `loc=Australia%2FMelbourne`：`/` 必须转义为 `%2F`（驱动 README 明示）。
3. **不使用 `time_zone` 系统变量参数**。`SET time_zone='Australia/Melbourne'` 要求 MySQL 已加载时区表（`mysql.time_zone_name`），共享实例上常常是空的，会直接报 ERROR 1298。
4. **硬约束（非建议）**：**SQL 中禁止 `NOW()` / `CURDATE()` / `CURRENT_TIMESTAMP` 参与业务语义**。**实测依据**：`@@system_time_zone = CST`、`@@session.time_zone = SYSTEM`（team-lead 已连库验证），服务器会话时区是中国时间——任何依赖服务器时钟写进去的值都不是墨尔本时间。所有业务时间必须由 Go 侧 `clock.Now()`（`internal/pkg/clock`，内部持有 `melbourneLoc`）显式传参。表的 `created_at` 默认值保留 `DEFAULT CURRENT_TIMESTAMP` 仅供运维审计，**业务代码与任何查询条件都不得读取它**；**`credit_ledger.created_at` 由 Go 显式写入**（它是账务时间，必须准）。
5. **DATETIME，不用 TIMESTAMP**。理由三条：①TIMESTAMP 存 UTC 并在读写时按会话 `time_zone` 转换，语义依赖服务器配置，与"不做任何时区转换"直接冲突；②TIMESTAMP 上限 2038；③DATETIME 是"墙上时钟"，正好是我们要的语义。列统一 `DATETIME(3)`。
6. **排班存 `weekday` + 墙上时间（分钟数），绝不存 UTC**。这是 DST-safe 的：墨尔本夏令时切换时，每周固定时段的课在墙上时间上不变，正是业务想要的。

**风险**：
- R1：忘记 `import _ "time/tzdata"` → 只在别人机器上炸。对策：写进 README + `main.go` 注释。
- R2：Go 侧混用 `time.Now().UTC()` 与 Melbourne 时间 → 参数被 `In(loc)` 二次偏移，静默算错 10/11 小时（典型"沉默逻辑错误"）。对策：`internal/pkg/clock` 是**唯一**取时间入口，代码评审禁止出现裸 `time.Now()`。
- R3：阿里云 MySQL 的 `system_time_zone` 可能是 CST（中国标准时）→ `DEFAULT CURRENT_TIMESTAMP` 的审计字段会是中国时间。已由第 4 条规避（业务不依赖它），并在 README 里明示。

### C. MySQL 8 上周时段重叠检测

**验证结论：可行。必须"事务 + 父实体行锁"，不能依赖间隙锁。**

| 事实 | 证据 |
|---|---|
| InnoDB 默认 RR，范围 `SELECT ... FOR UPDATE` 会加 next-key/gap lock，理论上能阻止区间插入 | MySQL 8.0 手册 17.7.1："`SELECT c1 FROM t WHERE c1 BETWEEN 10 and 20 FOR UPDATE` prevents other transactions from inserting a value of 15" |
| **但实测 MySQL 8.0.x 在 RC 下，范围条件加锁不阻塞 insert**；且 gap lock 只在 RR 生效、且查询必须走索引，否则退化 | 社区实测矩阵（juejin 2023，5.7/8.0 × RR/RC）："事务隔离级别为 RC 时…指定范围加锁，不阻塞 insert"；"事务隔离级别为 RR 时，查询条件无索引，为表锁" |
| MySQL **没有** PostgreSQL 的 `EXCLUDE USING gist` 排它范围约束 | 能力事实；MySQL 8.0.16+ 的 CHECK 只能做行内布尔表达式，不能跨行 |

**存储设计**：`classes` 存 `weekday TINYINT`（0=周日..6=周六，对齐 `DAYOFWEEK()-1`）+ `start_min SMALLINT` + `end_min SMALLINT`（自 00:00 起的分钟数，墨尔本墙上时间）。用整数分钟而非 `TIME`：区间比较是纯数值比较，可读、可索引、无 `TIME` 类型的隐式转换坑。CHECK 约束钉死 `0<=weekday<=6`、`end_min > start_min`、`end_min <= 1440`、`capacity > 0`。

**事务内检测（R3 完整实现）**：

```sql
START TRANSACTION;

-- (0) 串行化点：同一学生的所有排班变更互斥；同一班级的容量变更互斥
SELECT id FROM students WHERE id = :student_id FOR UPDATE;
SELECT id FROM classes  WHERE id = :class_id   FOR UPDATE;

-- (a) 学生周时段重叠：半开区间相交 a.start < b.end AND b.start < a.end
SELECT c.id, c.name, c.start_min, c.end_min
FROM class_enrollments e
JOIN classes c ON c.id = e.class_id
WHERE e.student_id = :student_id
  AND e.status = 'active'
  AND c.weekday  = :weekday
  AND c.start_min < :end_min
  AND :start_min  < c.end_min
LIMIT 1;

-- (b) 老师同一时段被排两个班（老师维度的硬冲突）
SELECT c.id FROM classes c
WHERE c.teacher_id = :teacher_id AND c.status = 'active' AND c.id <> :class_id
  AND c.weekday = :weekday
  AND c.start_min < :end_min AND :start_min < c.end_min
LIMIT 1;

-- (c) 班级容量
SELECT COUNT(*) FROM class_enrollments
WHERE class_id = :class_id AND status = 'active';

-- (d) 余额 > 0（R6：余额 = 0 不许排课）
SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE student_id = :student_id;

INSERT INTO class_enrollments (class_id, student_id, weekday, start_min, status, enrolled_on)
VALUES (:class_id, :student_id, :weekday, :start_min, 'active', :today);

COMMIT;
```

**唯一约束兜底**：把 `weekday` 与 `start_min` 冗余进 `class_enrollments`，加 `UNIQUE KEY uq_student_slot (student_id, weekday, start_min)`。这能在数据库层挡住"同一学生同一周同一起始时间排两个班"这一最常见的重复排班（即便应用层被绕过、事务隔离被降級）。它**挡不住**部分重叠（起点不同），那部分必须由上面的事务区间查询覆盖——这是 MySQL 的能力边界，不是设计疏漏，写进 DESIGN.md 的"已知取舍"。

**为什么不用 gap lock**：8.0.x 在 RC 下范围锁不阻塞 insert，且连接池若被改成 RC 会静默失效。用 `students`/`classes` 的行锁作为**显式互斥点**，语义与隔离级别无关，行为可预测。加锁顺序固定为"先 student 后 class"，避免死锁。

**风险**：
- R1：10 admin 并发操作同一学生，行锁等待。数据量（10 admin / 1000 学生）下可忽略。
- R2：忘记 `FOR UPDATE` → 并发双排班。对策：所有写 `class_enrollments` 的路径必须走 `service.EnrollmentService.Enroll()` 单一入口（编译期约束）。
- R3：`weekday` 冗余字段与 `classes` 不同步。对策：写入时从 `classes` 读出后同一事务写入，不开放外部传参。

### D. Ledger 只增不改的落地

**验证结论：可行，且能做出"三层证据"。**

**事实依据**：MySQL 8.0.16 起 CHECK 约束才真正强制执行（8.0.16 之前**解析但静默忽略**——这是老项目的高频坑）。MySQL 支持按表/按列授予 `INSERT` 而授予 `UPDATE`/`DELETE`。

**表结构（关键：没有 `updated_at`，没有 `deleted_at`）**：

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
  created_at    DATETIME(3) NOT NULL COMMENT '由 Go 侧 Melbourne 时间显式写入',
  PRIMARY KEY (id),
  CONSTRAINT chk_delta_nonzero CHECK (delta <> 0),
  INDEX idx_ledger_student (student_id, created_at),
  INDEX idx_ledger_package (package_id),
  UNIQUE KEY uq_ledger_consume (student_id, lesson_id, reason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`uq_ledger_consume` 是**幂等闸门**：同一学生同一节课同一原因只能产生一条流水（MySQL 唯一索引允许多个 NULL，所以 `lesson_id IS NULL` 的购买/退款条目不受影响）。这直接防住"重复点击结算导致重复扣课时"。

**三层防护**：

| 层 | 措施 | 能挡住什么 |
|---|---|---|
| 数据库 | ①app 账号对 `credit_ledger` 只 `GRANT SELECT, INSERT`（迁移账号才有 DDL/UPDATE）②`CHECK(delta<>0)` ③无 `updated_at`/`deleted_at` 列 ④`uq_ledger_consume` 幂等 | 绕过应用直接连库也改不了历史流水；重复扣课时 |
| Repository | `CreditRepository` **只暴露** `Insert(ctx, tx, entry)` 与 `SumBalance(ctx, tx, studentID)`，**不存在** Update/Delete 方法 | 应用层任何人都"调不到"改流水的方法（编译期约束） |
| Service | 唯一入口 `CreditService.Apply(ctx, tx, entry)`：强制携带 `actor_user_id`、`reason` 必须在白名单、写前必先锁 `students` 行 | 业务侧无法绕过审计字段 |

**余额并发安全扣减**（出勤结算，R4 + R5 + R6）：

```sql
START TRANSACTION;
SELECT id FROM students WHERE id = :student_id FOR UPDATE;      -- 该学生账务串行化点
SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id = :student_id;

-- 业务判定：present/late/absent/leave_late => delta = -1
--           leave_approved(提前>=24h请假) => 不写流水
INSERT INTO credit_ledger (student_id, package_id, delta, reason, lesson_id,
                           attendance_id, actor_user_id, note, created_at)
VALUES (:student_id, NULL, -1, 'consume', :lesson_id, :attendance_id, :actor, NULL, :now);

UPDATE attendances SET status = :status, recorded_by_user_id = :actor, recorded_at = :now
WHERE lesson_id = :lesson_id AND student_id = :student_id;
COMMIT;
```

约定（写进规则文档）：**任何写 `credit_ledger` 的事务，第一行必须是 `SELECT id FROM students WHERE id=? FOR UPDATE`。** MySQL 无法对聚合结果加锁，只能锁一个真实存在的行——`students` 行就是该学生的账务互斥量。

**余额读取**：`SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id=?`。列表页需要按余额筛选/排序时，走一个视图 `v_student_balance`（或一次 JOIN 子查询），**不冗余 `students.credit_balance` 字段**——冗余字段必然与流水不一致，而 R5 明确要求"余额 = sum(ledger)"。

**实测确认（team-lead 已连库验证）**：`VERSION() = 8.0.46`（>= 8.0.16，CHECK 强制执行）；账号含 `CREATE USER` 权限，**三层防护全部实施**，不采用退化方案。专用 app 账号见 ADR-002 §"建库与建账号"。

**风险**：
- R1（已消除）：原担心共享实例拿不到按表授权的独立账号。实测 `SHOW GRANTS` 含 `ALL PRIVILEGES ON *.*` + `CREATE USER`，可自建 `ae_app` 并只授 `SELECT, INSERT`。**不再需要退化方案**。
- R2：余额变负。已排的课照扣（不然学生白上课），允许负余额并立刻触发"透支"红色预警；**不允许的是余额 0 时新排课**（R6 由排班事务的 (d) 步拦截）。

---

## 5. 数据模型（初版）

### 5.1 表清单

| # | 表 | 说明 | 关键字段 |
|---|---|---|---|
| 1 | `users` | 登录主体。role ∈ admin / teacher / student | `id` `role` `username`(UK) `password_hash` `display_name` `status` `created_at` `updated_at` |
| 2 | `students` | 学生档案（也是生命周期主体） | `id` `owner_admin_id`(FK users) `user_id`(FK users, 家庭账号, 可空, 非唯一) `full_name` `preferred_name` `year_level` `status`(lead/trial/active/churned) `source` `created_at` `updated_at` `deleted_at` |
| 3 | `guardians` | 家长联系人，**无凭证** | `id` `student_id` `name` `phone` `email` `relationship` `is_primary` |
| 4 | `subjects` | 科目 | `id` `name`(UK) |
| 5 | `teachers`? | 不建独立表，老师的属性挂 `users` + `teacher_profile`（`user_id`, `bio`, `active`） | — |
| 6 | `classes` | 每周固定班级 | `id` `name` `subject_id` `teacher_id` `weekday` `start_min` `end_min` `capacity` `room` `status`(active/archived) `created_at` `updated_at` |
| 7 | `class_enrollments` | 学生在班 | `id` `class_id` `student_id` `weekday` `start_min`（冗余，用于唯一约束）`status`(active/withdrawn) `enrolled_on` `withdrawn_on` |
| 8 | `lessons` | 每一次实际课（按周生成） | `id` `class_id` `teacher_id` `lesson_date` `weekday` `start_min` `end_min` `status`(scheduled/cancelled/completed) `cancel_reason` `created_at` `updated_at` |
| 9 | `attendances` | 出勤 | `id` `lesson_id` `student_id` `status`(present/late/absent/leave_approved/leave_late) `source`(prefilled/teacher_override/system) `recorded_by_user_id` `recorded_at` `note` |
| 10 | `leave_requests` | 学生端请假 | `id` `lesson_id` `student_id` `requested_by_user_id` `requested_at` `reason` `resolution`(approved_ge_24h / late_lt_24h) `created_at` |
| 11 | `credit_packages` | 课时包（一次购买） | `id` `student_id` `name` `total_credits` `price_cents` `purchased_at` `purchased_by_admin_id` `status`(active/void/refunded) |
| 12 | `credit_ledger` | **只增不改流水** | 见 §4-D |
| 13 | `trials` | 试听课（R1 唯一性落点） | `id` `student_id` `subject_id` `teacher_id` `scheduled_at` `duration_min` `outcome`(pending/converted/lost) `outcome_note` `created_at` `updated_at` |
| 14 | `follow_ups` | 跟进任务（R2 48h SLA） | `id` `student_id` `trial_id` `due_at` `status`(pending/done/overdue) `completed_at` `completed_by_user_id` `note` |
| 15 | `ai_decisions` | LLM 决策卡审计（R8） | `id` `student_id` `kind`(trial_conversion/renewal_risk) `model` `prompt_version` `input_hash` `output_json` `ai_status`(ok/invalid/unavailable) `created_at` |
| 16 | `audit_events`（P2） | 归属变更等审计 | `id` `actor_user_id` `entity` `entity_id` `action` `payload_json` `created_at` |

### 5.2 关键索引

```sql
-- students
INDEX idx_students_owner (owner_admin_id, status), INDEX idx_students_status (status), INDEX idx_students_name (full_name)
-- class_enrollments
UNIQUE KEY uq_enroll (class_id, student_id), UNIQUE KEY uq_student_slot (student_id, weekday, start_min), INDEX idx_enroll_student (student_id, status)
-- lessons
INDEX idx_lessons_date (lesson_date, teacher_id), INDEX idx_lessons_class_date (class_id, lesson_date), INDEX idx_lessons_teacher_date (teacher_id, lesson_date)
-- attendances
UNIQUE KEY uq_att (lesson_id, student_id), INDEX idx_att_student (student_id)
-- trials
UNIQUE KEY uq_trial_once (student_id, subject_id)   -- R1 的数据库层落点
-- leave_requests
UNIQUE KEY uq_leave (lesson_id, student_id)
-- credit_ledger
UNIQUE KEY uq_ledger_consume (student_id, lesson_id, reason), INDEX idx_ledger_student (student_id, created_at)
-- follow_ups
INDEX idx_followup_status (status, due_at)
```

### 5.3 ER 关系（简）

```
users(admin) 1──N students {owner_admin_id}
users(student) 1──N students {user_id}        -- 家庭账号：一个凭证可挂多个孩子
students 1──N guardians
students 1──N trials ──N follow_ups
students 1──N credit_packages 1──N credit_ledger
students 1──N credit_ledger
classes N──1 users(teacher) ; classes N──1 subjects
classes 1──N class_enrollments N──1 students
classes 1──N lessons 1──N attendances N──1 students
lessons 1──N leave_requests N──1 students
students 1──N ai_decisions
```

### 5.4 四个追问的标准答案

| 追问 | 数据模型怎么答 | 服务端规则 |
|---|---|---|
| **一个学生同时在两个班** | `class_enrollments` 天然一对多，允许。 | R3：入班事务内做半开区间相交检测（`a.start_min < b.end_min AND b.start_min < a.end_min` 且 `weekday` 相同）→ 重叠即 409 + `code=40901`。同一周同一起始时间还有 `uq_student_slot` 唯一约束兜底。 |
| **课时怎么退** | ①**退未消耗课时**：`credit_packages.status='refunded'` + append 一条 `reason='refund'`、`delta = -当前余额` 的流水（把余额归零）。②**退已扣的那节课**（补课/误扣）：append 一条 `reason='manual_adjust'`、`delta=+1`、`note` 写明原因与审批人。两条都不 UPDATE 任何历史流水。 | 只有 admin 可发起，且受 R7（只能退自己的学生）；`refund` 前必须重新读余额并锁 `students` 行；退款金额 v1 只记账不做支付网关，明文写进 DESIGN.md 的"不做"。 |
| **学生转给另一个 admin** | `UPDATE students SET owner_admin_id = :to_admin_id`（`class_enrollments` / `credit_ledger` / `attendances` **完全不动**，历史数据天然完整）。 | 权限：仅当前 owner 或 super_admin 可发起；写入 `audit_events`（P2）记 `{from, to, actor, at}`；转出后原 admin 立刻失去写权限（R7 中间件每次请求实时查 `owner_admin_id`，不缓存）。 |
| **老师请假一周** | 同一事务把该老师该周的 `lessons.status` 批量置为 `cancelled`，写 `cancel_reason`。**不生成 `attendances`、不写 `credit_ledger`** → 学生课时不受损。 | 接口 `POST /api/v1/lessons/cancel-range {teacher_id, from_date, to_date, reason}`；权限：admin 或该老师本人；已 `completed` 的课不可取消（409）；取消后给受影响学生的 admin 生成一条待办/通知（P2）。 |

---

## 6. API 端点清单

所有端点前缀 `/api/v1`，统一响应 `{code, data, message}`，分页 `{items,total,page,limit,hasMore}`。认证：`ae_token` httpOnly Cookie 或 `Authorization: Bearer`。

### 认证
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 返回 token + 写 Cookie |
| POST | `/api/v1/auth/logout` | 清 Cookie |
| GET | `/api/v1/auth/me` | 当前角色与可见范围 |

### 学生（R7：admin 可读全量、只能写自己的；household 只读自己的孩子）
| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/students` | `?status=&q=&low_credit=1&owner_admin_id=&page=&limit=`；`owner_admin_id` 接受 `me` 或数字，其它值 → **400/40000**；无匹配 `items:[]` |
| POST | `/api/v1/students` | 建档案（同时可建 guardians、可选挂家庭账号） |
| GET | `/api/v1/students/{id}` | 详情：档案 + 余额 + 在班 + 待跟进 + 最新 AI 卡；**household 读别家孩子 → 403/40301** |
| PATCH | `/api/v1/students/{id}` | **R7** |
| POST | `/api/v1/students/{id}/transfer-owner` | 转归属（追问 3） |
| GET | `/api/v1/students/{id}/credits` | 余额 + 流水（只读）；**household 读别家孩子 → 403/40301**；**无流水时 `items:[]`（不返回 null）** |
| POST | `/api/v1/students/{id}/credit-packages` | 成交开账：建包 + 首条 ledger |
| POST | `/api/v1/students/{id}/credit-adjustments` | 退款 / 补偿（追问 2） |

### 试听与跟进
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/v1/trials` | **R1**：同学生同科目唯一（`uq_trial_once`）；**R7** 写校验（非本人学生 403/40301） |
| GET | `/api/v1/trials` | `?student_id=&outcome=`；**队列按归属收敛**：admin 只见自己名下学生的试听、teacher 只见自己任课的试听（与 `GET /follow-ups` 同口径；R7 的"读全量"由 `/students` 承担） |
| POST | `/api/v1/trials/{id}/outcome` | 标记结果 → **R2** 自动生成 `due_at = now + 48h` 的 follow_up；**R7**：非本人学生 403/40301；`converted` 把 `students.status` 从 `lead`/`trial` 推进到 `active`，`lost` 不动状态 |
| GET | `/api/v1/follow-ups` | `?status=pending|overdue&owner_admin_id=`（admin 不传该参数时自动收敛到自己名下学生） |
| POST | `/api/v1/follow-ups/{id}/complete` | 完成跟进；**R7**：按 `follow_ups.student_id` 回查归属，非本人学生 403/40301 |

### 班级与排班
| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/classes` | `?teacher_id=&weekday=&subject_id=`；**household 只返回其孩子 active 报名的班级**；数字型参数非法 → **400/40000** |
| POST | `/api/v1/classes` | 建班（含老师时段冲突校验 (b)） |
| GET | `/api/v1/classes/{id}` | 含当前人数 / 容量 |
| GET | `/api/v1/classes/{id}/enrollments` | 名册；**household 只返回自己孩子在册行** |
| POST | `/api/v1/classes/{id}/enrollments` | **R3 + R6**：重叠 / 容量 / 余额 > 0 |
| DELETE | `/api/v1/classes/{id}/enrollments/{student_id}` | 退班（软：`status='withdrawn'`） |

### 课次与出勤
| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/lessons` | `?date=&from=&to=&teacher_id=&class_id=`；数字型参数非法 → **400/40000**；无匹配 `[]` |
| POST | `/api/v1/lessons/generate` | 按班级周计划批量生成 `{from_date,to_date}` |
| POST | `/api/v1/lessons/cancel-range` | 老师请假（追问 4） |
| GET | `/api/v1/lessons/{id}/roster` | 老师视角：名单 + 预填状态 + 是否新生 |
| POST | `/api/v1/lessons/{id}/attendance` | **R4 + R5**：结算并扣课时（幂等靠 `uq_ledger_consume`） |
| PATCH | `/api/v1/lessons/{id}/attendance/{student_id}` | 老师覆盖（只能 present/absent，留痕） |

### 请假（学生端）
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/v1/leave-requests` | `{lesson_id, reason}`，服务端按 `start - now >= 24h` 判 `leave_approved` / `leave_late`；**必须校验学生在该 lesson 所属班级有 `status='active'` 报名，否则 409/40907** |
| GET | `/api/v1/leave-requests` | `?student_id=&lesson_id=`；数字型参数非法 → **400/40000**；无匹配 `[]` |

### LLM 决策卡（R8）
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/v1/ai/trial-conversion/{student_id}` | 试听转化决策卡 |
| POST | `/api/v1/ai/renewal-risk/{student_id}` | 续费/流失决策卡 |
| GET | `/api/v1/students/{id}/ai-cards` | `?kind=`，含 `ai_status` |

### 看板
| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/dashboard/admin` | 待跟进 / 逾期 / 低课时 / 今日课表 |
| GET | `/api/v1/dashboard/teacher` | 今日要上的课 |

完整请求/响应 schema 见 `docs/openapi.yaml`。

### 错误码

| code | HTTP | 含义 |
|---|---|---|
| 0 | 200 | 成功 |
| **40000** | **400** | **数字型 query 参数无法解析，message 形如 `"weekday must be a number"`** |
| 40100 | 401 | 未登录 / token 失效 |
| 40300 | 403 | 角色不允许 |
| **40301** | 403 | **R7**：不是该学生的 owner；或 household 读别家孩子 |
| 40400 | 404 | 资源不存在 |
| **40901** | 409 | **R3a**：周时段重叠 |
| **40902** | 409 | **R3b**：老师时段冲突 |
| **40903** | 409 | **R3c**：班级已满 |
| **40904** | 409 | **R6**：余额为 0，不能排课 |
| **40905** | 409 | **R1**：该学生该科目已试听过 |
| **40906** | 409 | 重复结算（幂等命中） |
| **40907** | **409** | **学生不在该课次所属班级的在册名单中（`POST /leave-requests`）** |
| **42201** | 422 | **R4**：出勤状态非法（老师只能 present/absent） |
| **42202** | 422 | **R8**：LLM 输出未通过白名单校验 |
| 50000 | 500 | 未分类服务端错误（**兜底，不再使用 `-1`**） |
| 50301 | 200* | LLM 不可用（**降级成功**，响应里 `ai_status='unavailable'`，不算错误） |

**两条全局契约不变量**（客户端必须依赖，服务端必须保证）：

1. **空集合恒为 `[]`，绝不返回 `null`**。`/classes`、`/classes/{id}/enrollments`、`/lessons`、`/leave-requests` 的 `data` 与 `/students`、`/trials`、`/follow-ups`、`/students/{id}/credits` 的 `data.items` 在无匹配时一律返回空数组。其中 `/students/{id}/credits` 最要紧——新学生无流水时曾返回 `items:null`，客户端 `.map()` 会崩。分页端点的空集合有两条来路：筛选无匹配，以及**页码越界**（`page` 超过总页数），两者都必须是 `items: []` 而不是 `null`。
2. **数字型 query 参数无法解析时返回 400，不静默忽略**。此前非法值被忽略导致过滤条件失效、整个结果集被返回；`GET /students?owner_admin_id=abc` 甚至返回过 `code:-1`（与兜底 500 撞码，客户端无法区分），现统一为 `400 / 40000`。

---

## 7. 规则执行矩阵（R1–R8 在哪一层）

| 规则 | 数据库层 | 应用层 | 前端 |
|---|---|---|---|
| R1 同学生同科目只试听一次 | `UNIQUE(student_id, subject_id)` | service 预检返回 40905 | 按钮禁用（仅体验） |
| R2 试听后 48h 必须跟进 | — | 标记 outcome 时同一事务写 `follow_ups.due_at=now+48h`；列表查询按 `due_at < now` 判 overdue | 红色待办角标 |
| R3 排班三校验 | `uq_student_slot` + `CHECK(capacity>0)` | 事务内 4 步查询 + `FOR UPDATE` | 选班时提示冲突 |
| R4 按出勤扣课时 / ≥24h 请假不扣 | `uq_ledger_consume` 幂等 | service 判定状态与 24h 阈值 | — |
| R5 Ledger 只增不改、余额=sum | 无 `updated_at` 列 + `CHECK(delta<>0)` + 只授 INSERT | repository 无 Update 方法 | — |
| R6 余额≤4 预警、=0 不许排课 | — | 预警由查询实现；=0 在排班事务 (d) 步拦截 40904 | 余额 Badge |
| R7 admin 只能写自己的学生 | — | 写路径在 service 层调 `StudentService.AssertOwner`（`service/student.go:18`），每次请求重读 `students.owner_admin_id`、从不缓存；**是逐路径显式调用，不是全局中间件** | 隐藏编辑入口 |
| 读作用域（R7 的对偶） | — | admin 读全量；teacher 读自己班；**household 只读自己孩子**（`/classes`、`/classes/{id}/enrollments` 按 active 报名过滤，`/students/{id}`、`/students/{id}/credits` 越界返回 403/40301） | 只渲染自己孩子的入口 |
| 参数解析失败 | — | 数字型 query 非法 → `400/40000`，**禁止静默忽略**（否则过滤失效 = 全量泄露） | 输入前校验并禁用提交 |
| 空集合序列化 | — | handler 统一把 `nil` 切片规整为 `[]`，**禁止输出 `null`** | `.map()` 不因空集合崩溃 |
| R8 LLM 枚举白名单 + 降级 | `ai_decisions` 落库审计 | 解 JSON → 枚举校验 → 重试 1 次 → `unavailable` + 规则兜底卡 | 展示"AI 不可用，已用规则兜底" |

---

## 8. 部署

- 前端 `npm run build` → `frontend/dist`，Nginx `root` 指向它，`try_files $uri /index.html`（SPA 回退）。
- Nginx `location /api/ { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; ... }`。
- Go 编译：`CGO_ENABLED=0 go build -o /opt/ae/ae-api ./cmd/server`，systemd 托管，`Environment=JWT_SECRET=...`、`Environment=DB_DSN=...`（变量名以 `config/config.go` 为准；env 文件不进仓库）。
- 建库与账号：`CREATE DATABASE student_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`；建专用 app 账号 `ae_app`（全库 SELECT/INSERT/UPDATE/DELETE，`credit_ledger` 收回 UPDATE/DELETE）。语句见 ADR-002。
- 迁移：`migrate -path backend/migrations -database "mysql://<admin>@tcp(39.102.63.30:3306)/student_management" up`（发布前置步骤，**用管理账号**，与应用启动解耦；迁移完成后才对 `credit_ledger` 收权）。
- 开发态：Vite `server.proxy` 把 `/api` 代理到 `127.0.0.1:8080`，保证 Cookie 同源。

---

## 9. 端到端验证（收尾验收，实现阶段执行）

1. 按 ADR-002 的顺序执行一次：`CREATE DATABASE student_management` → 建 `ae_app` → `migrate up` → **对 `credit_ledger` 收权（只留 SELECT, INSERT）** → `seed`。自检三项：`SELECT VERSION()` = 8.0.46（>= 8.0.16，CHECK 生效）、`SHOW GRANTS FOR 'ae_app'@'%'`（credit_ledger 上无 UPDATE/DELETE）、`SELECT @@sql_mode`（含 STRICT_TRANS_TABLES）。
2. `seed` 后：2 个 admin 各 ~12 名学生、20 名老师、~60 节/周课。
3. **破坏测试清单（全部用 curl 绕过前端，每条都要看到对应错误码）**：
   - `curl -X POST .../classes/2/enrollments -d '{"student_id":7}'`（该生已有同周重叠班）→ `40901`
   - 把班级容量填满后再排第 N+1 人 → `40903`
   - 余额置 0 后调排班 → `40904`
   - admin B 用 admin A 的 student_id 调 `PATCH` → `40301`
   - 同一学生同一科目连发两次 `POST /trials` → `40905`
   - 同一节课连发两次 `POST /lessons/{id}/attendance` → 第二次 `40906`（幂等）
   - teacher 账号把出勤覆盖成 `leave_approved` → `42201`
   - 学生提前 23h 请假 → 仍扣课时；提前 25h 请假 → `leave_approved` 不扣
   - **学生 A 对不属于自己班级的 lesson_id 发 `POST /leave-requests` → `40907`**（防任意 lesson 被点，晚于 24h 路径会真扣课时）
   - **`GET /classes?weekday=abc` 与 `GET /lessons?teacher_id=abc` → `400 / 40000`**，且**不得**返回全量结果
   - **`GET /students?owner_admin_id=abc` → `400 / 40000`**（不得再返回 `-1`）
   - **household 账号 `GET /students/{别家孩子}` 与 `/students/{别家孩子}/credits` → `403 / 40301`**
   - **household 账号 `GET /classes` 只应看到自己孩子 active 报名的班级**；`GET /classes/{id}/enrollments` 只应看到自己孩子在册行
   - **空集合断言**：新学生 `GET /students/{id}/credits` 必须返回 `"items": []`（**不是 `null`**）；空查询的 `/classes`、`/lessons`、`/leave-requests` 必须返回 `[]`；空查询的 `/students`、`/trials`、`/follow-ups` 必须返回 `"items": []`
   - **分页断言**（`/students`、`/trials`、`/follow-ups` 同口径）：`?limit=20&page=1` 与 `page=2` 的 `items[].id` 并起来去重，行数必须**恰好等于 `total`**；`total` 必须等于「相同谓词直接查库的 `COUNT(*)`」（**含角色收口**——`total` 数的是调用者可见的那一批，不是全库）；越界页 `?page=99` 返回 `items: []` 且 `has_more: false`。第一条抓的是「`ORDER BY` 无唯一键 → 并列组跨页丢行/重行」，只比 `total` 抓不到
   - 断掉 `DEEPSEEK_API_KEY` 后请求决策卡 → HTTP 200 且 `ai_status='unavailable'`，主流程照常
4. `npm run lint`（含 emoji / hex / 图标库三条检查）通过；`go build ./...` 通过。

---

## 10. 本次不做（out-of-scope）

- 支付网关 / 发票（退款只记流水）
- 刷新令牌、找回密码、多因素认证
- 通知渠道（短信 / 邮件 / 微信），v1 只在系统内生成待办
- 老师薪酬结算、跨校区、多租户
- 学生自助注册（账号由 admin 创建）
- 数据库行级加密 / 审计合规留存
- 单元测试全量覆盖（只覆盖 R3/R4/R5/R8 四条规则的服务端用例）
