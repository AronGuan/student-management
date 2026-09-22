# 部署手册 —— Austin Education 学生管理系统（ECS）

> **命令里凡是用 `<尖括号>` 括起来的都是占位符**，部署时替换成你的实际值。
> 这份文件刻意不写任何真实主机名、域名、IP 或凭据 —— 它随仓库一起走，所以只能写占位符。
> 真正的凭据在 `.env` 里，而 `.env` 是 gitignore 的（`.gitignore:2`）。

---

## 0. 一分钟速览

```bash
# 在 ECS 上，仓库根目录
cp .env.example .env && vi .env      # 填 DB_DSN / JWT_SECRET / CORS_ORIGINS
bash scripts/start-all.sh            # 编译后端 + 构建前端 + 后台起两个服务
# → UI  http://<ecs-ip>:19073
# → API http://127.0.0.1:19080        （只走前端代理，不对公网开放）
```

首次部署还需要多两步（建表、灌演示数据），见 §3。日常发布只要 `git pull` + 重启，见 §4。

---

## 1. 部署形态与端口

两个进程，前端把 `/api` 反向代理到后端。浏览器**只**访问前端那一个端口。

```
                        公网
                         │  安全组只放行 19073
                         ▼
        ┌────────────────────────────────────┐
        │  Vite preview  :19073  (node)      │
        │   ├── 静态资源  frontend/dist/     │
        │   └── /api/*  ──代理──┐            │
        └───────────────────────┼────────────┘
                                ▼
        ┌────────────────────────────────────┐
        │  Go API        :19080  (ae-api)    │  ← 不对公网开
        └───────────────────┬────────────────┘
                            ▼
                     MySQL 8.0.16+
```

| 服务 | 端口 | 绑定 | 谁访问 | 进程名 |
|---|---|---|---|---|
| 前端（Vite preview） | **19073** | `0.0.0.0` | 浏览器，公网可达 | `vite preview` |
| 后端（Go API） | **19080** | `0.0.0.0` | 仅前端代理 + 服务器本机 curl | `.run/ae-api` |

**为什么是 19080 / 19073**：把原来的 8080 / 5173 整个搬进 `19xxx` 段，尾数不变。这样避开 ECS 上
几乎一定会被占用的 80 / 443 / 3000 / 3306 / 6379 / 8080 / 9000 / 9090，也避开本地验证用的
1808x / 519x 备用口，而且都 > 1024，不需要 root 或 `CAP_NET_BIND_SERVICE`。

**为什么后端不对公网开**：Go 里监听的是 `:19080`，也就是 `0.0.0.0:19080` —— **它的第一道防线是安全组，
不是监听地址**。所以安全组里**不要**放行 19080。想要进程级隔离见 §8 末尾的一行改法。

### 1.1 端口是可以改的，但要两个地方一起改

```bash
BACKEND_PORT=20080 FRONTEND_PORT=20073 bash scripts/start-all.sh
```

`scripts/lib.sh:15-16` 把这两个变量 `export` 出去，`frontend/vite.config.ts` 读的是同两个变量，
所以**监听端口和代理目标永远同源**，不会出现「前端指向一个没人监听的端口」。

`.env` 里的 `PORT` 必须与 `BACKEND_PORT` 一致，否则 `.env` 会覆盖掉导出值（`config.go:44`）。

---

## 2. 前置依赖

| 东西 | 版本 | 缺了会怎样 |
|---|---|---|
| Go | **1.26+**（本机实测 `go1.26.4`） | `scripts/start-backend.sh` 编不出来。没有 Go 的机器见 §4.3 |
| Node | **20.19+**（本机实测 `v22.22.2`） | `npm ci` / `vite build` 直接拒绝启动；`package.json:7` 有 `engines` 声明 |
| MySQL | **8.0.16+** | schema 用了 `CHECK` 约束，8.0.16 起才真正强制。启动时会打印版本号 |
| git / curl | 任意 | `curl` 缺失时脚本会跳过就绪探测并明确打印一行，不会静默当成成功 |

**不需要装 tzdata。** 业务时区是 `Australia/Melbourne`，但 IANA 时区库已经通过
`backend/internal/clock/clock.go:18` 的 `_ "time/tzdata"` **编译进二进制**了。ECS 的系统时区是
什么都不影响业务时间 —— SQL 里从不出现 `NOW()` / `CURDATE()`，所有业务时间都由 Go 侧下发
（ADR-007）。这是有意的：MySQL 实例跑在 `CST`，混用会因夏令时静默挪走 2 或 4 小时。

**不需要手工建库、不需要跑任何 SQL。** 服务端会自行创建缺失的库并应用自己的迁移。

### 2.1 装 Go（`dnf` 系 / 阿里云 Linux）

```bash
GO_VERSION=1.26.4                    # 与本机 `go version` 保持一致
curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf /tmp/go.tgz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
export PATH=$PATH:/usr/local/go/bin
go version                            # 期望 go1.26.x
```

> Ubuntu 用 `apt-get` 装 `git curl`；Go / Node 两条装法一样。

### 2.2 装 Node（NodeSource 22.x）

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -   # Ubuntu 改成 setup_22.x 的 deb 脚本
sudo dnf install -y nodejs
node -v                               # 期望 v22.x（≥ v20.19）
```

> 也可以改用 nvm。注意脚本在**非交互 shell** 里跑，nvm 靠 `.bashrc` 注入的 `PATH` 不生效，
> 得把 `node` 放进系统路径，或者显式 `export PATH="$HOME/.nvm/versions/node/v22.x/bin:$PATH"`。

### 2.3 MySQL

**推荐直接复用现有的那台实例**（数据已经在上面，不必迁移）。此时 ECS 上什么都不用装，
只要 `.env` 的 `DB_DSN` 指向它、且**那台 MySQL 的安全组放行 ECS 的出口 IP**。

若要在这台 ECS 上另起一个：

```bash
sudo dnf install -y mysql-server
sudo systemctl enable --now mysqld

sudo mysql -e "CREATE DATABASE IF NOT EXISTS student_management
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  CREATE USER IF NOT EXISTS 'ae'@'%' IDENTIFIED BY '<db-password>';
  GRANT ALL PRIVILEGES ON student_management.* TO 'ae'@'%';
  FLUSH PRIVILEGES;"
mysql --version                       # 期望 8.0.16+
```

`utf8mb4` 是必需的 —— 演示数据里全是中文姓名。

---

## 3. 首次部署（七步）

### 3.1 拉代码

```bash
sudo mkdir -p /opt && sudo chown "$USER" /opt
cd /opt
git clone https://github.com/AronGuan/student-management.git ae
cd ae
```

> 仓库是 **public**，用 https 克隆不需要在 ECS 上配 SSH key。只有你要**从服务器往回推**才需要。

### 3.2 写 `.env`

`.env` 被 `.gitignore:2` 排除，所以 `git clone` / `git pull` **永远不会把它带上来**。
最省事的做法是从本机拷：

```bash
# 在【本机】执行
scp E:/project/take-home/.env root@<ecs-ip>:/opt/ae/.env
```

> 注意 `.env` 放在**仓库根目录**，不是 `backend/`。`config.go:40-41` 先试 `godotenv.Load()`，
> 再试 `../.env`；`start-backend.sh` 会 `cd` 进 `backend/` 再启动，所以根目录的 `../.env` 正好命中。
> 放错位置的表现是「服务起来了但连不上库」，而且没有任何一行日志说它没找到 `.env`。

服务器上手写的话，至少要改这四个值：

```dotenv
PORT=19080
DB_DSN="<user>:<password>@tcp(<db-host>:3306)/student_management?charset=utf8mb4&parseTime=true&loc=Australia%2FMelbourne"
JWT_SECRET=<随机字符串，不要用默认值>
CORS_ORIGINS=http://<ecs-ip>:19073
DEEPSEEK_API_KEY=sk-...        # 可选；没有它 AI 卡会降级成规则卡，其余功能不受影响
```

三处细节：

- **`DB_DSN` 必须整体加引号**：值里有 `%2F`，不加引号在 dotenv 解析里会被当成转义。
- **`loc=Australia%2FMelbourne` 是承重的**，不是装饰。少了它，`DATETIME` 的解析时区就错了。
- **`CORS_ORIGINS` 不是「只给直连调用方用的」，它走的是必经之路**。浏览器请求 `/api` 时，
  代理（`vite.config.ts:20-25`）只改写了 `Host` —— `changeOrigin: true`（`vite.config.ts:23`）
  把 `Host: <ecs-ip>:19073` 换成后端目标地址，而**浏览器的 `Origin` 是原样透传的**。
  于是 `gin-contrib/cors` 里那条「`Origin` 等于 `Host` 就当作同源、直接放行」的捷径
  （该模块自己的 `config.go:77-88`，不是本仓的 `config/config.go`）**在「浏览器 → 代理 → 后端」
  这条路上永远不成立**，白名单成了唯一出口：
  `Origin` 不在列表里就直接 `AbortWithStatus(403)`，**响应体是空的**。
  ⇒ 部署到 ECS **必须**把前端地址填进去。注意 `.env.example:11-20` 里这一项是**注释状态**的，
  照抄着写 `.env` 会把它漏掉（这正是线上那次登录 403 的成因）。表现很隐蔽但可辨认：
  请求 **403 且响应体为空**，而服务端日志里其实**有**一行 —— `| 403 | ... POST "/api/v1/auth/login"`
  （`cmd/server/main.go:70` 的 `gin.Logger()` 注册在 `router.go:41` 的 cors 之前，所以它照打不误）。
  所以 `config/config.go:80` 把它做成了可配置项，而不是硬编码。

### 3.3 权限与换行符

```bash
chmod +x scripts/*.sh
git config core.autocrlf false       # 可选；.gitattributes 已经兜住了
```

`*.sh` 已由 `.gitattributes:6` 强制为 `LF`。如果你绕过 git 直接把脚本拷到服务器
（比如走剪贴板、走 FTP），CRLF 会让它在 shebang 处死于
`bad interpreter: /usr/bin/env bash^M` —— **错误信息指向 bash，而不是行尾**，很费时间。
遇到这个报错，第一反应就是 `sed -i 's/\r$//' scripts/*.sh`。

### 3.4 依赖

```bash
cd /opt/ae/backend && go mod download && cd ..
cd /opt/ae/frontend && npm ci && cd ..
```

`npm ci`（而不是 `npm install`）依据仓库里已有的 `package-lock.json` 装**锁定版本**，
这是可复现的前提。首次 `npm ci` 大约几百 MB，1C2G 的机器上会慢几分钟。

### 3.5 建表

```bash
cd /opt/ae/backend
CGO_ENABLED=0 go build -o /opt/ae/.run/ae-api ./cmd/server
/opt/ae/.run/ae-api -migrate
```

期望输出 `applied 4 migration(s): [000001_schema 000002_balance_view 000003_followup_parent_note 000004_followup_source]`
（已是最新则是 `schema already up to date`）。

> **必须用本仓自带的 runner，不要用 `golang-migrate` CLI。**
> 两者建出来的 `schema_migrations` 表**同名不同构**：本仓是
> `(version VARCHAR(64), applied_at DATETIME(3))`，golang-migrate 是 `(version BIGINT, dirty BOOL)`。
> 换用其一会在读版本号时炸掉。详见 `docs/ARCHITECTURE.md` §8。

### 3.6 灌演示数据

```bash
cd /opt/ae/backend && /opt/ae/.run/ae-api -seed
```

⚠️ **`-seed` 是破坏性的**：它会清空业务表再重建。**只在首次部署或想重置演示数据时跑**，
日常发布**不要**跑它。

它会打印它保证生成的状态（行数随运行日期变化）：

```
正在写入演示数据 ...
演示数据写入完成
  admin：3，演示登录 mei.lin / demo1234
  ...
  演示状态：17 条跟进已逾期，16 场试听待进行，4 条试听已结束待记录，5 名学生课时不足，11 条线索待跟进，今日 1 节课
```

三个演示队列（已逾期跟进 / 待进行试听 / 课时不足）为空时，seed 会**以非 0 退出**而不是报告成功 ——
空的看板和一个坏掉的查询在演示时无法区分，所以它选择大声失败。老师备注少于 30 条同理。
若 seed 失败，看它最后那几行打印的计数，不要忽略退出码。

### 3.7 起服务

```bash
cd /opt/ae && bash scripts/start-all.sh
```

后端先起（起不来就不必起一个每个请求都会失败的 UI），脚本会**总是重新编译后端**，
然后构建前端并用 `vite preview` 提供 `frontend/dist`。

期望输出：

```
=== 2026-09-22 02:10:11 starting backend on :19080 ===
[backend] up on :19080 (pid 41327)
[frontend] building (tsc -b && vite build)...
[frontend] up on :19073 (pid 41402)

API  http://127.0.0.1:19080
UI   http://127.0.0.1:19073
日志 /opt/ae/.run/*.log
```

然后从本机浏览器打开 `http://<ecs-ip>:19073`，用 `mei.lin / demo1234` 登录。

---

## 4. 日常发布

### 4.1 正常流程

```bash
cd /opt/ae
bash scripts/stop-all.sh
git pull
bash scripts/start-all.sh
```

前端的 `npm ci` 会在检测到 `node_modules` 缺失时才跑，所以日常 `git pull` 之后这一步是跳过或很快的。
**`package-lock.json` 变了的时候要手动 `npm ci` 一次**（脚本只在 `node_modules` 不存在时才装）。

**不要跑 `-seed`。** 它会清掉演示数据。除非你本来就想重置。

如果 `git pull` 带回了**新的迁移文件**，发布流程要多一步：

```bash
bash scripts/stop-all.sh
git pull
cd backend && go build -o ../.run/ae-api ./cmd/server && ../.run/ae-api -migrate
cd .. && bash scripts/start-all.sh
```

判据是 `git log --name-only --oneline HEAD@{1}..HEAD -- backend/migrations/` 有没有输出。

### 4.2 只重启其中一个

```bash
bash scripts/start-backend.sh     # 只重编并重启后端；已在跑则直接退出（不会重启）
bash scripts/restart-backend.sh   # 不存在，用 stop + start
bash scripts/start-frontend.sh    # 只重新构建并重启前端
```

⚠️ `start-*.sh` 在服务**已经在跑**时是幂等的：它打印 `already running` 然后 `exit 0`，**不会重启**。
想让它真的重启，先 `stop`。

### 4.3 ECS 上没有 Go 的情况

在**本机**交叉编译，把二进制传上去：

```bash
# 本机
cd backend
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ae-api ./cmd/server
scp ae-api root@<ecs-ip>:/opt/ae/.run/ae-api
ssh root@<ecs-ip> "chmod +x /opt/ae/.run/ae-api"

# ECS
cd /opt/ae
bash scripts/stop-backend.sh
SKIP_BUILD=1 bash scripts/start-backend.sh
```

`SKIP_BUILD=1` 会跳过 `go build`，直接启动 `.run/ae-api`；二进制缺失时它会明确报
`is missing or not executable` 并退出，而不是让你对着一个没有 Go 的机器猜为什么编译失败。

前端同理有 `SKIP_BUILD=1`：

```bash
SKIP_BUILD=1 bash scripts/start-frontend.sh    # 直接用现有的 frontend/dist，不重新构建
```

**这两条路径的代价是一样的**：跳过构建意味着你在服务器上跑的产物**不是当前代码**。
只有当你知道 dist / 二进制是自己刚在本机为这台机器编出来的时候才用它。

---

## 5. 启停脚本速查

全部在 `scripts/`，全部可重复执行，全部**自定位**（`REPO_ROOT` 由脚本自身路径推出，
所以仓库里没有任何写死的服务器路径）。

| 脚本 | 作用 | 产物 |
|---|---|---|
| `bash scripts/start-all.sh` | 后端 → 前端，按序启动 | 见下 |
| `bash scripts/stop-all.sh` | 前端 → 后端，按序停止 | 清空 pidfile |
| `bash scripts/start-backend.sh` | 编译 + 后台起 API | `.run/ae-api`、`.run/backend.pid`、`.run/backend.log` |
| `bash scripts/stop-backend.sh` | 停 API | — |
| `bash scripts/start-frontend.sh` | 构建 + `vite preview` | `.run/frontend.pid`、`.run/frontend.log` |
| `bash scripts/stop-frontend.sh` | 停前端 | — |
| `scripts/lib.sh` | 共享函数，**被 source，不单独执行** | — |

**起停的先后顺序是有理由的**：启动时后端先起（后端起不来就没必要起一个每个请求都会失败的 UI，
而且这样报错报的是它自己）；停止时前端先停（UI 先停止接请求，后面的 API 才消失）。

### 5.1 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `BACKEND_PORT` | `19080` | API 监听端口；同时决定前端代理目标 |
| `FRONTEND_PORT` | `19073` | UI 监听端口 |
| `SKIP_BUILD` | `0` | `1` = 跳过编译/构建，直接用现有产物 |

### 5.2 `.run/` 里有什么

```
.run/
  ae-api          后端二进制（每次 start-backend 重新编译覆盖）
  backend.pid     后端的 pid
  backend.log     后端的 stdout+stderr，追加写
  frontend.pid    前端的 pid
  frontend.log    前端的 stdout+stderr，追加写
```

`.run/` 在 `.gitignore:10`，不会被提交。

### 5.3 三个刻意的设计，出问题时先想到它们

**① 端口被占用时脚本会拒绝启动，不会自己换一个。**

```
[backend] port 19080 is already in use - refusing to start.
```

这不是 bug。Vite 默认会静默漂到下一个空闲端口，**而漂掉的端口安全组和代理都不知道** ——
服务看起来起来了，但没有任何东西监听在你声称的地址上。所以 `vite.config.ts` 里
`strictPort: true`，`lib.sh:52` 的 `refuse_if_taken` 也做同一件事。
先查占用者：`ss -ltnp | grep :19080`。

**② 停止是 SIGTERM → 等 15 秒 → SIGKILL。** 那段等待是有意义的：Go 服务收到 SIGTERM 会关闭
数据库连接池，Vite 需要释放端口。立刻 KILL 再立刻重启，可能把新进程塞给一个旧进程还没放手的端口。
（`stop_one` 里 `while kill -0` 的轮询也是据此写的。）

**③ 前端记的 pid 是 vite 自己的，不是 npm 的。** `start-frontend.sh:61` 直接调
`node_modules/.bin/vite`，而不是 `npm run preview` —— 因为 `npm run` 会 fork 子进程，
`$!` 拿到的是 npm 的 pid，`stop` 会杀掉 npm 而把真正的 vite 留成孤儿继续占着端口。
那个脚本是带 shebang 的，内核用同一个 pid `exec` node，所以没有包装进程可以泄漏。

---

## 6. 日志与排障

### 6.1 日志在哪

```bash
tail -f /opt/ae/.run/backend.log     # API：gin 的访问日志 + MySQL 版本/时区自检
tail -f /opt/ae/.run/frontend.log    # 前端：vite preview 的启动行 + 代理转发
```

`start-*.sh` 探测就绪失败时，会自己把**最后 20 行**日志打到 stderr 再 `exit 1`，
所以一次失败的启动不需要你去翻文件就知道大概原因。

### 6.2 常见症状 → 病因

| 症状 | 病因 | 怎么办 |
|---|---|---|
| 日志里出现 `DB_DSN has no database name` | **`DB_DSN` 是空的**（`.env` 没读到或没解析成功）—— 与网络无关。见 §6.4 | 按 §6.4 查非法字节（BOM 只是其中一种）；核对键名 |
| `did NOT answer /healthz within 15s`，且日志里 Go 一行都没打、进程还活着 | 卡在连库上（端口被 DROP 会让连接挂住而不是报错）。见 §6.4 末段 | 先跑 §6.4 的可达性检查 |
| 同上，但日志里有 `db:` / `database bootstrap:` 的其它内容 | 后端起来了又立刻死了 | 看 `.run/backend.log` 最后 20 行 |
| 打印 `schema is not loaded` 后退出 | 迁移没跑 | `cd backend && ../.run/ae-api -migrate` |
| 页面能打开但每个接口都 404 或返回 HTML | 前端的 `preview.proxy` 没生效，`/api` 落到了 SPA 回退上（**返回 200 + `index.html`**，看起来像「接口返回了 HTML」而不是「没有代理」） | 确认 `vite.config.ts` 里 `preview` 段有 `proxy`；`frontend.log` 里重启后应能看到代理相关的行 |
| 登录（或任何 POST）返回 **403 且响应体为空**，服务端日志里只有一行 `\| 403 \|` | **`Origin` 不在 `CORS_ORIGINS` 里**。**走代理也会中招**：代理把 `Host` 改写成后端地址，`gin-contrib/cors` 的「`Origin` 等于 `Host` 就放行」分支永远不成立（见 §3.2） | 把浏览器地址栏里的 origin（含端口、**不要尾斜杠**）加进 `CORS_ORIGINS`，重启后端 |
| 403，但响应体是 `{"code":40300,...}` 这样的 JSON envelope | 角色 / 账号问题（无权限、凭据错、账号停用），**不是** CORS | 按 `code` / `message` 排查 |
| 登录成功但立刻掉线 | Cookie 跨源了 —— `ae_token` 是 httpOnly Cookie，前端必须与 API 同源 | 不要改成让前端直连 19080；走代理（或 Nginx 反代） |
| `bad interpreter: /usr/bin/env bash^M` | 脚本是 CRLF | `sed -i 's/\r$//' scripts/*.sh` |
| 端口被占用，脚本拒绝启动 | 上一次没停干净，或别的服务占了 | `ss -ltnp \| grep :19080`；`bash scripts/stop-all.sh` |
| `npm ci` 报 `EBADENGINE` 或 vite 起不来 | Node < 20.19 | 升 Node；`node -v` 先确认 |
| `vite build` 被 OOM kill | 1C1G 机器构建内存不足 | 加 swap，或 `NODE_OPTIONS=--max-old-space-size=1536 npm run build`，或在本机构建后传 `dist/` |
| 时间显示差 2 或 4 小时 | 有人往 SQL 里加了 `NOW()` | 业务时间必须走 `internal/clock`；见 ADR-007 |

**一秒区分 403 的两种来源：看响应体是否为空。**
`backend/` 里所有业务 403 都走 `respond.go` 的 `Fail` / `FailWith` 或 `middleware/auth.go:106`
的 `AbortWithStatusJSON`，**响应体一定是 `{code,data,message}`**；而 cors 中间件拒绝时用的是
`AbortWithStatus(403)`，**响应体一定是空的**。所以「**403 且响应体为空**」是全仓唯一的 CORS 拒绝指纹 ——
只要 403 的 body 里能解析出 `code`，就跟 `CORS_ORIGINS` 无关。

### 6.3 存活检查

```bash
curl -fsS http://127.0.0.1:19080/healthz          # 后端
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19073/   # 前端
curl -fsS -X POST http://127.0.0.1:19080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"mei.lin","password":"demo1234"}'                   # 端到端
```

端口是否真的在听：

```bash
ss -ltnp | grep -E ':(19073|19080)\b'
```

### 6.4 `DB_DSN has no database name` —— 它真的意思是「DB_DSN 是空的」

这句话的字面意思在骗人。它来自 `repo.EnsureDatabase` 里 `cfg.DBName == ""` 的分支，而
**空字符串也会走到这里**：`go-sql-driver` 的 `ParseDSN("")` 返回 `err == nil` 且 `DBName == ""`
（`dsn.go:472` 的守卫是 `if !foundSlash && len(dsn) > 0`，空串连循环都进不去）。
⇒ **看到这句话不要去查 DSN 拼写，先查 `DB_DSN` 有没有被读到。**

**为什么文件在、值却是空的**：`godotenv` 只要有**任何一行**解析失败，就**丢弃整份 map**，
一个变量都不设。而 `PORT` 的代码默认值恰好就是 19080 ⇒「PORT 也没读到」你根本看不出来，
症状于是表现得像「只有 DB_DSN 坏了」。实测（`godotenv` v1.5.1）：

| `.env` 的形态 | `Load` 返回 | 结果 |
|---|---|---|
| 正常（首行注释、CRLF 行尾） | `nil` | 正确 ✓ |
| 首行开头有 **UTF-8 BOM** | 首行的第一个字符非法（报错里 `%q` 括起的**就是**那个非法字节） | **所有变量都没设** |
| **有一行没有 `=`** | `unexpected character "\n" in variable name` | **所有变量都没设** |
| **混进一个不可见的 C1 控制字节**（如 U+008E） | `unexpected character "\u008e" in variable name` | **所有变量都没设** |
| 某行引号没闭合 | `nil` | 那一行之后被吞进同一个值，`DB_DSN` 为空 |

> 上表是 `godotenv` 自身的行为。本仓 `config/config.go:59-62` 现在会在 `Load` 报错时直接把错误抛出来，
> `cmd/server/main.go:28` 的 `log.Fatalf("config: %v", err)` 会让进程当场退出 —— 所以你更可能看到的是
> `config: cannot parse ../.env: unexpected character ...`，而不是那句「DB_DSN has no database name」。
> 两者指向同一个根因：**`.env` 里有非法字节**。

报错里被 `%q` 括起来的那个字符**就是文件里那个非法字节本身**，所以第一件事是认出它是什么：

- 渲染成 `\ufeff` ⇒ BOM（U+FEFF）。
- 渲染成 `\u008e` 这种 `\u00XX` ⇒ 一个**C1 控制字符**（`\u008e` 在 UTF-8 里是字节 `C2 8E`），
  和 BOM 不是一回事。`.env.example` 里带大量**中文注释**，复制 / 传输 / 编辑器「另存为」
  最容易把其中几个字节改坏。

定位**所有**非 ASCII 字节（BOM 只是其中一种形态）：

```bash
LC_ALL=C grep -nP '[^\x09\x0A\x0D\x20-\x7E]' /opt/ae/.env   # 列出含非 ASCII 字节的行
od -c /opt/ae/.env | sed -n '1,5p'                          # 直接看前几行的原始字节
```

`.env` 应该是**纯 ASCII**。而**一处损坏会让整份文件失效**（godotenv 全有或全无，见上表）
⇒ **服务器上的 `.env` 只留 `键=值`，把中文注释删掉**，不要连 `.env.example` 的注释一起带上去。

BOM 只是其中一种形态：它在任何编辑器里都不可见，而 Windows PowerShell 5.1 的
`Set-Content -Encoding utf8` 默认就会写入它。确认与去掉：

```bash
file /opt/ae/.env
head -c 3 /opt/ae/.env | od -An -tx1     # ef bb bf = 有 BOM
```

`file` 回 `UTF-8 Unicode (with BOM) text` 就是它。去掉：

```bash
sed -i '1s/^\xEF\xBB\xBF//' /opt/ae/.env
```

传文件时就要留意来源：`scp` 原文件不会加 BOM，「另存为 UTF-8 with BOM」或 PowerShell 重写会。

**另一种（少见得多）的形态**：日志里 Go 一行都没打、而且**进程还活着**。那才是卡在连接上 ——
`DB_DSN` 没有 `timeout=` 时连接超时取操作系统默认（TCP SYN 重传，约 127 秒），
而目标端口若被**丢弃**（DROP）而不是**拒绝**（REJECT），连接就一直挂着。

```bash
timeout 5 bash -c '</dev/tcp/<db-host>/3306' && echo "3306 reachable" || echo "3306 BLOCKED"
```

`BLOCKED` ⇒ 去数据库那侧的安全组/白名单加上**这台 ECS 的出口 IP**（`curl -s ifconfig.me` 拿）；
同 VPC 则改用**内网地址**。授权层面通常不是瓶颈 —— `geo@%` 这种账号在 MySQL 侧本来就连得通。

**想让它以后失败得干脆**，在 `DB_DSN` 里补连接超时：

```dotenv
DB_DSN="…?charset=utf8mb4&parseTime=true&loc=Australia%2FMelbourne&timeout=5s&readTimeout=30s&writeTimeout=30s"
```

这样 127 秒的静默挂起会变成 5 秒的明确报错。**`-migrate` 与 `-seed` 走的是同一条连接。**

---

## 7. 安全组与网络

| 方向 | 端口 | 源 | 说明 |
|---|---|---|---|
| 入站 | **19073/TCP** | `0.0.0.0/0`（或演示时的本机 IP） | 唯一需要公网可达的端口 |
| 入站 | 19080/TCP | **不要放行** | 后端只通过前端代理被访问 |
| 入站 | 22/TCP | 你的 IP | SSH |
| 出站 | 3306/TCP | MySQL 主机 | 若数据库在别的实例上 |

- 演示阶段建议把 19073 的入站源限制成你自己的公网 IP，而不是 `0.0.0.0/0`。
- **HTTPS 目前没有。** 现在是 `http://<ecs-ip>:19073` 直接访问。走 HTTP 时 Cookie 不带
  `Secure` 属性（符合预期）。要上 HTTPS，按 §8 的 Nginx 形态加证书；那时应同时把
  `ae_token` 改成 `Secure`，并把 `CORS_ORIGINS` 换成 `https://<域名>`。
- **没有任何东西依赖 IP 或域名**，所以换 IP、加域名都不需要改代码，只改 `CORS_ORIGINS`。

---

## 8. 可选加固：Nginx + systemd

> 先明确一件事：**§5 的脚本和这一节是两条互斥的路。**
> 两套都启就会同时抢 19073 / 19080，而 `refuse_if_taken` 会让第二套直接失败
> （好在它是失败，不是静默漂端口）。选一条走完。

### 8.1 为什么有人需要这一套

| | 脚本（§5） | Nginx + systemd（§8） |
|---|---|---|
| 前端托管 | `vite preview`（Node 常驻） | Nginx 直接发 `dist/` 静态文件 |
| 开机自启 | 无（要手动或加 cron `@reboot`） | `systemctl enable` |
| 崩溃自愈 | 无 | `Restart=on-failure` |
| HTTPS | 无 | Nginx 终止 TLS |
| 依赖 | Node + Go 都要在机器上 | 只要 Nginx + 一个编译好的二进制 |
| 适合 | 演示、快速验收 | 长期跑 |

### 8.2 `/etc/systemd/system/ae-api.service`

```ini
[Unit]
Description=Austin Education API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ae
WorkingDirectory=/opt/ae/backend
EnvironmentFile=/opt/ae/.env
ExecStart=/opt/ae/.run/ae-api
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ae-api
sudo systemctl status ae-api
sudo journalctl -u ae-api -f
```

两处要注意：

- `EnvironmentFile` 会剥掉值两侧的引号，所以 `DB_DSN="..."` 里的引号不会进到变量里 —— 这是对的。
  但那个值里有 `%`：systemd 对 `EnvironmentFile` 的内容**不做** specifier 展开，所以
  `Australia%2FMelbourne` 原样传入。若发现 `%` 被吞掉，改用 `Environment=` 写法并写成 `%%`。
- 改用 systemd 后**不要再跑 `scripts/start-backend.sh`**。

### 8.3 `/etc/nginx/conf.d/ae.conf`

```nginx
server {
    listen 80;
    server_name <域名或 _>;

    root /opt/ae/frontend/dist;
    index index.html;

    # 反代必须保留完整路径：后端路由是 /api/v1/...
    # proxy_pass 后面不要带斜杠，带了会把 /api 前缀吃掉。
    location /api/ {
        proxy_pass http://127.0.0.1:19080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SPA 回退：深链接（/students/:id 之类）刷新时找不到实体文件
    location / {
        try_files $uri /index.html;
    }
}
```

```bash
sudo dnf install -y nginx          # 或 apt-get install -y nginx
sudo nginx -t && sudo systemctl enable --now nginx
```

前端此时不再需要 Node 常驻，但**首次构建仍然需要**（或者把本机构建好的 `frontend/dist` 传上来）。

### 8.4 让后端只听 127.0.0.1（可选）

现在 `main.go:83` 是 `addr := ":" + cfg.Port`，等于绑所有网卡，安全性靠安全组。
想加一层进程级隔离，改成：

```go
addr := "127.0.0.1:" + cfg.Port
```

此时前端代理目标（已经是 `http://127.0.0.1:19080`）仍然成立，容器/同机反代都不受影响，
但**从别的机器直连 19080 会立刻失败**。改了之后 `curl http://<ecs-ip>:19080/healthz` 连不上是
预期行为，不是故障。

---

## 9. 上线前 checklist

部署：

- [ ] `go version` ≥ 1.26，`node -v` ≥ v20.19，`mysql --version` ≥ 8.0.16
- [ ] 代码在 `/opt/ae`（或你选的路径），且 `git log -1` 是你想发布的那个 commit
- [ ] `.env` 存在且**在仓库根目录**（不在 `backend/`）
- [ ] `.env` 里 `JWT_SECRET` 已换成随机串（不是 `dev-only-secret-change-me`）
- [ ] `.env` 里 `DB_DSN` 整体带引号，含 `loc=Australia%2FMelbourne`
- [ ] `.env` 里 `PORT=19080` 与脚本的 `BACKEND_PORT` 一致
- [ ] `CORS_ORIGINS` 含 `http://<ecs-ip>:19073`，**并且这一行在 `.env` 里没有被注释掉**
      （`.env.example` 里它是注释状态，最容易照抄着漏掉；漏掉的表现是登录 403 且响应体为空）
- [ ] `chmod +x scripts/*.sh`
- [ ] `-migrate` 跑过，且输出里包含全部 4 个迁移
- [ ] `-seed` 跑过且退出码为 0（仅首次 / 需要重置时）
- [ ] 安全组放行 **19073**，**未**放行 19080
- [ ] 若数据库在别的实例：那台放行了这台 ECS 的出口 IP

功能（在浏览器里过一遍）：

- [ ] `http://<ecs-ip>:19073` 打得开，`mei.lin / demo1234` 能登录
- [ ] 工作台的「已逾期跟进 / 待进行试听 / 课时不足」三个计数非零
- [ ] `/leads` 的「待记录结果」里有「已结束 N 天」标记的行
- [ ] `/teach/today` 点名页能点名，且能看到「课堂记录」列
- [ ] `/me`（`parent.zhao / demo1234`）能看到余额、流水与「老师评价」
- [ ] 关掉 `DEEPSEEK_API_KEY` 后重启，AI 卡仍可用（`source: rule`）—— 降级路径没坏

---

## 10. 已知边界

| 项 | 现状 | 影响 |
|---|---|---|
| 无 HTTPS / 域名 | 直接 `http://<ip>:19073` | 演示可接受；生产要按 §8 加证书 |
| 前端无自动化测试 | 靠人工过一遍 §9 | 改前端后必须重新构建 + 手动验证 |
| 排课页单窗口 `limit=100` | 学生超过 100 时静默只覆盖前 100 | 演示规模（47 名学生）不受影响，已记在 README §5 |
| `-seed` 破坏性 | 清空业务表 | 发布流程里绝不能顺手跑 |
| 脚本无开机自启 | 需要手动或 `@reboot` cron | 长期跑请走 §8 |
| `schema_migrations` 与 golang-migrate 不同构 | 见 §3.5 | **不要混用两套迁移工具** |
| `docs/ARCHITECTURE.md:229` 提到 `deploy/{nginx.conf,ae-api.service}` | 仓库里**没有这个目录** | §8 的配置按需自己落地，仓库暂不提供 |
