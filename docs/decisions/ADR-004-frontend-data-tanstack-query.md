# ADR-004: 前端服务端状态用 TanStack Query，不引入全局状态库

## Status
Accepted (Phase 1)

## Background
前端约 5 个页面（登录、admin 看板、学生详情、班级/排班、老师今日课、学生端请假），每个都要 loading / 空 / 错误三态，且写操作后需要刷新列表。10h 预算内要"状态一眼能区分"而不是把时间花在手搓请求层。

候选：TanStack Query v5 / SWR / 裸 fetch + useEffect。

## Decision
**`@tanstack/react-query` 5.103.2 + 一个薄 `apiClient` 封装。**

- `apiClient`：统一 `fetch` 包装，`credentials: 'include'`；解包 `{code, data, message}`；`code != 0` 抛 `ApiError{code, message, httpStatus}`；`40100` 清 `AuthContext` 并跳登录。
- 每个资源一个 `useXxxQuery` / `useXxxMutation` hook，写操作 `onSuccess` 里 `queryClient.invalidateQueries({queryKey: [...]})`。
- 类型来自 `docs/openapi.yaml` 经 `openapi-typescript` 生成的 `src/api/types.ts`，**不手写 DTO**。
- **不引入 Redux / Zustand**。唯一的全局客户端状态是"当前登录者"，用 `AuthContext` 承载。

## Consequences

正面：
- loading / error / refetch / 缓存失效全部内建，省下的时间直接换成页面完成度。
- mutation + invalidate 让"排班成功后余额与名册同时刷新"变成一行代码。
- devtools 在演示时能直观展示缓存与失效，是加分项。

负面：
- 多一个依赖与一层心智模型（queryKey 设计）。缓解：queryKey 统一在 `src/api/keys.ts` 里定义为常量，禁止散落字符串。
- 生成的 TS 类型依赖 `openapi.yaml` 与实现同步（活规格维护）。

风险：`openapi.yaml` 变更后忘记重新生成类型 → 类型与后端不一致。缓解：`npm run gen:types` 挂进 `prebuild`。

## Related ADRs
ADR-005（UI 层）, ADR-010（openapi.yaml 作为前后端唯一契约）
