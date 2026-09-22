# ADR-003: 认证用 HS256 JWT，双通道传递，MVP 不实现 refresh

## Status
Accepted (Phase 1)

## Background
作业要求"有登录和至少一层权限（admin 可以查看所有学生，但只能修改自己的学生）"，且评分方会**绕过界面直接调服务端**验证规则。因此认证既要安全，又要让 `curl` 一行就能带上凭据。

## Decision

1. **算法 HS256**（`github.com/golang-jwt/jwt/v5` v5.3.1）。单服务单密钥，不需要多方验签，RS256 只增加配置负担。
2. **密钥**：环境变量 `APP_JWT_SECRET`，>= 32 字节随机串；启动时校验存在性，缺失直接 panic。不进仓库，`.env.example` 只放占位。
3. **Claims**：`sub`(user_id) / `role`(admin|teacher|student) / `name` / `sid`(学生账号绑定的 student_id，可空) / `iat` / `exp` / `jti`。
4. **TTL 8 小时**（一个工作日）。
5. **不实现 refresh token**。这是明确的 MVP 降级：8h 过期后重新登录。理由：refresh 要引入 token 轮换、撤销表与另一组错误分支，10h 预算里换不来对应的评分收益。
6. **双通道传递**：
   - 浏览器：httpOnly Cookie `ae_token`，`SameSite=Lax`、`Path=/`，生产环境加 `Secure`。Vite dev 用 `server.proxy` 把 `/api` 代理到 `127.0.0.1:8080` 保证同源，避免跨域 Cookie 问题。
   - `curl` / Postman：`Authorization: Bearer <token>`。中间件先读 Cookie，读不到再读 Header。
7. **中间件链**：`OriginCheck` → `Authn`（解析 JWT，注入 `domain.Actor`）→ `RequireRole(...)` → `CanWriteStudent`（R7：从路径取 `student_id`，实时查 `students.owner_admin_id` 与 `actor.ID` 比对，**不缓存**）。
8. **口令** bcrypt cost 10（`golang.org/x/crypto/bcrypt`）。
9. **CSRF**：SameSite=Lax + Origin 白名单中间件 + 写操作强制 `Content-Type: application/json`。

## Consequences

正面：
- 双通道直接服务于"绕过前端做破坏测试"这个评分环节：面试官 `curl -H "Authorization: Bearer ..."` 即可。
- httpOnly Cookie 避免 token 被 JS 读取（相对 localStorage 的 XSS 面更小）。
- R7 实时查库，学生转归属（追问 3）后原 admin 立刻失去写权限，无需等 token 过期。

负面：
- 8h 过期无 refresh，长时间演示可能需要重新登录。缓解：seed 提供一个"演示用长效 token"生成脚本（仅本地）。
- 无 token 撤销机制。缓解：`jti` 已写入 claims，将来加 Redis 黑名单即可，不改接口形状。
- Cookie + Bearer 两套入口增加一处分叉。缓解：集中在 `middleware.Authn` 一处，10 行代码。

风险：如果 Nginx 未配置 `X-Forwarded-Proto`，生产 `Secure` Cookie 会被丢弃。README 明确写出该配置行。

## Related ADRs
ADR-005（前端请求封装，需 `credentials: 'include'`）, ADR-010（中间件在分层里的位置）
