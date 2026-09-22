# ADR-005: 前端 UI 用 Tailwind + 自建组件，图标库锁定 lucide-react

## Status
Accepted (Phase 1)

## Background
P0 团队规则：①禁止 emoji 作功能图标，Spec 必须锁定一套 SVG 图标库，全项目统一不混用，尺寸 16/20/24px；②禁止紫→粉渐变主视觉；③前端禁止硬编码颜色（唯一例外 `#fff` `#000`），必须走 Design Token；④禁止 AI 模板味。

候选 UI：Ant Design（最快但模板味重、token 覆盖成本高）/ shadcn-ui（现成可访问组件，多一层配置）/ Tailwind + 自建（最可控，需自写组件）。
候选图标：lucide-react / heroicons / phosphor-icons / tabler / react-icons。

## Decision

### UI
**Tailwind CSS v4.3.3（`@tailwindcss/vite`）+ 自建组件层，不引入 Ant Design，不引入 Radix。**

自建组件（每个 <= 120 行）：`Button` `Input` `Select` `Table` `Badge` `Modal`（原生 `<dialog>`）`EmptyState` `Toast` `StatCard` `Skeleton`。
不引入 Radix 的理由：桌面 Chrome 上原生 `<dialog>` / `<select>` 已足够，省下 30–45 分钟配置时间换页面完成度。

### Design Token
**唯一源是 `docs/UIUX.md` §3.2**：主色 Petrol Blue `--accent: #0F5C73`，语义色 `--success #15803D` / `--warn #B45309` / `--danger #B91C1C`，中性 `--fg #1B1C1F` / `--muted #6C6F78` / `--bg #F4F5F6` / `--surface #FFFFFF`。
ADR-005 **不另立色板**（避免与 UIUX 双源冲突）：UIUX 负责定义值，本 ADR 负责定义约束——
① 禁止紫→粉渐变，无渐变主视觉，层级靠 hairline 与 sunken 底色；
② 状态三通道冗余（颜色 + 形状/图标 + 文本），灰度化后仍可读；
③ Tailwind v4 `@theme` 把上述 CSS 变量映射为工具类，组件层只引用语义名，不写十六进制。

### 图标库（唯一锁定）
**`lucide-react@1.47.0`，ISC 许可，4270 个 SVG 组件，ESM tree-shakable，React 19 兼容。**

- 允许尺寸：**仅 16 / 20 / 24**。默认 20；表内行内 16；空状态与大按钮 24。
- `strokeWidth={1.75}` 统一（默认 2 在 16px 下偏重）。
- 颜色一律 `currentColor`，禁止写死色值。
- 禁止任何其他图标库。

### Enforcement（三条硬检查，全部挂 `npm run lint`）
1. ESLint `no-restricted-imports` 屏蔽 `@heroicons/*`、`react-icons`、`@phosphor-icons/*`、`react-feather`、`@tabler/icons-react`、`antd`。
2. `frontend/scripts/check-no-emoji.mjs`：命中 `U+1F000–U+1FAFF` / `U+2600–U+27BF` / `U+FE0F` / `U+2B00–U+2BFF` 即 `exit(1)`。
   **扫描范围（team-lead 裁定）**：
   - **零容忍**：`frontend/src/**`、`backend/**` —— 出现即构建失败。
   - **豁免**：`docs/**/*.md` —— ASCII 线框图需要 `⚠` `⬭` `⬚` `✕` `✚` 作占位符（`docs/UIUX.md` 第 220–221、406–411、491–494、589–591、606 行）。豁免的是**文档线框**，不是实现：UIUX.md 的图标列已给出 Lucide 具名（`calendar-clock` / `x` / `user-round-plus`），实现时一律换成组件。
3. `frontend/scripts/check-no-hex.mjs`：扫描 `src/**`，命中 `#` + 3/6/8 位十六进制即报错，白名单仅 `#fff` / `#000`；`src/styles/tokens.css` 本身豁免（它是 token 源）。

## Consequences

正面：
- 图标一致性由"唯一依赖 + lint"保证，不靠自觉。
- Design Token 可控性最高，硬编码颜色被脚本拦住。
- 视觉不落进"AntD 后台模板"的窠臼，符合评分表里"界面设计是否清晰合理"这一项。

负面：
- 自建 Table / Modal 要花时间（估计 60–90 分钟）。这是用时间换视觉可控性的明确取舍。
- lucide 的语义图标覆盖不了极细分的业务图形（如"课时包"）。约定：业务概念用文字 + Badge 表达，不为它发明图标。

风险：Tailwind v4 的 `@theme` 与 v3 的 `tailwind.config.js` 心智不同，AI 生成代码容易按 v3 写法产出。缓解：README 与 spawn 指令里明确写死 "Tailwind v4，CSS-first，不建 tailwind.config.js"。

## Related ADRs
ADR-004（前端数据层）
