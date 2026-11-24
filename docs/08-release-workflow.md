# 开发到发布：完整流程

面向后续接手这个仓库的 Agent 与人。目标是把「改代码 → 验证 → 提交 → 打标签 → 出镜像 →
写 Release」这一套变成可照抄的步骤，并把踩过的坑提前写下来。

**先读 [`AGENTS.md`](../AGENTS.md) 的硬性约束**，那是每次改动都适用的；本文是发布流程。

---

## 0. 本机环境的三个前提

| 事实 | 影响 |
| --- | --- |
| **宿主机没有 `go`，也没有 `pnpm`** | 一切 Go / 前端命令都要走容器 |
| 有 `docker`、`node` 22、`npm` | 可以用来构建与验证 |
| `gh` 装在 `~/.local/bin/gh`（用户级） | 每次新终端要 `export PATH="$HOME/.local/bin:$PATH"` |

`web/node_modules` 是旧的、残缺的（`@rollup/rollup-linux-x64-gnu` 缺失）。**本机直接跑
`pnpm build` 会失败**，这不是代码问题。前端校验一律在临时目录里做。

---

## 1. 改完代码后的本地校验

### 1.1 后端

```bash
cd family-gallery
docker run --rm -v "$PWD":/src -w /src golang:1.27-alpine \
  sh -c 'gofmt -w cmd internal && go vet ./... && go test ./...'
```

- **`gofmt` 必须真的跑一遍**，不要只跑 `-l`。用 `sed` 批量改 import 路径后，字符串长度变化
  会改变对齐，CI 的格式检查会红（`v0.2.0` 之前就是这样翻车的）。
- Go 版本跟 `go.mod` 里的 `go` 指令一致（当前 `1.26`），容器用 `golang:1.27-alpine`。

### 1.2 前端

不要在本仓库目录里跑，复制到 `/tmp` 再跑：

```bash
docker run --rm -v /tmp:/mnt alpine rm -rf /mnt/webtest        # 上一次可能是 root 权限
mkdir -p /tmp/webtest
cd family-gallery/web
tar -c --exclude=node_modules --exclude=dist --exclude=tsconfig.tsbuildinfo . | tar -x -C /tmp/webtest

docker run --rm -e CI=true -v /tmp/webtest:/src -w /src node:22-alpine \
  sh -c 'corepack enable >/dev/null && corepack prepare pnpm@10.28.2 --activate >/dev/null 2>&1 \
         && pnpm install --frozen-lockfile --silent && pnpm build && pnpm test'
```

- **`pnpm test` 要自己跑**：CI 只跑 `pnpm build`，vitest 不在流水线里。见第 7 节的待改进项。
- `pnpm build` = `tsc -b && vite build`，`tsconfig` 开了 `strict` / `noUnusedLocals` /
  `noUnusedParameters`，未使用的 import 也会让构建失败。
- `--frozen-lockfile` 会校验 lockfile 与 `package.json` 是否一致。加依赖时要在容器里
  `pnpm add`，然后把 `package.json` 和 `pnpm-lock.yaml` 一起拷回仓库。

### 1.3 构建镜像

```bash
docker build -t family-gallery:local .
```

多阶段构建，产物是 `/app/web/dist`（前端）+ `/usr/local/bin/gallery`（后端）。

---

## 2. 运行时验证（别跳过）

**构建通过 ≠ 功能可用。** `v0.3.0` 的 HEIC 就是典型：`go test`、`tsc`、Docker 构建全绿，
但浏览器里因为 CSP 直接拒绝编译 WebAssembly，功能完全不可用。只有真的跑起来点一次才发现。

### 2.1 启动

```bash
docker stop family-gallery-local >/dev/null 2>&1; docker rm family-gallery-local >/dev/null 2>&1
docker run -d --name family-gallery-local \
  --network app_default \                                 # 必须与 chenguang-garage 同网络
  --env-file .env \
  -e S3_ENDPOINT=http://chenguang-garage:3900 \
  -e S3_PUBLIC_ENDPOINT=http://localhost:3900 \
  -p 127.0.0.1:8090:8080 -v family-gallery-local-data:/app/data \
  family-gallery:local
sleep 4 && curl -fsS -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:8090/healthz
```

- `.env` 里是**真实凭据**，已在 `.gitignore` 中，绝不提交。
- 开发模式口令：家庭 `family`，管理员 `admin`。
- 端口 `8090`：`8080` 被同机的 `app` 项目占用。

### 2.2 接口冒烟

```bash
curl -s -c /tmp/g.cookies -H 'Content-Type: application/json' \
  -d '{"password":"admin"}' http://127.0.0.1:8090/api/v1/auth/login
curl -s -b /tmp/g.cookies http://127.0.0.1:8090/api/v1/albums
```

### 2.3 浏览器验证

内置浏览器打开 `http://localhost:8090`。**两个已知限制**：

- 需要 `localhost` origin。IP 形式（`127.0.0.1`）会被重写成另一个 origin，导致
  非 GET 请求触发 `ORIGIN_REJECTED`(403)。
- 内置浏览器不支持 `context().addCookies`，HttpOnly 会话只能靠页面登录获得。
- 内置浏览器拿不到宿主机 `/tmp` 的文件，`setInputFiles` 会 `ENOENT`。需要上传时，用宿主机
  的 Playwright（见下）或页面内用 canvas 造 `File`。

宿主机 Playwright（复用 npx 缓存，无需 `pnpm add`）：

```bash
NODE_PATH=$(npm root -g) node your-script.cjs   # 或指向你自己的 npx 缓存目录
```

### 2.4 验证完要清场

临时相册、回收站里的测试照片**必须删干净**，否则会污染演示数据：

```bash
docker stop family-gallery-local >/dev/null
docker run --rm -v family-gallery-local-data:/app/data python:3-alpine python -c "
import sqlite3
db = sqlite3.connect('/app/data/gallery.db'); c = db.cursor()
c.execute(\"SELECT id FROM albums WHERE name='Probe'\")
for (aid,) in c.fetchall():
    for t in ('photos', 'shares', 'collections'):
        c.execute(f'DELETE FROM {t} WHERE album_id=?', (aid,))
    c.execute('DELETE FROM albums WHERE id=?', (aid,))
db.commit(); db.close(); print('cleaned')"
docker rm family-gallery-local >/dev/null
```

S3 上的对象不会随数据库行删除，验证用的小文件可以留着，但别在生产库上这么做。

---

## 3. 提交

### 3.1 提交信息

Conventional Commits，**说明「为什么」而不是「改了什么」**，因为这些提交会直接出现在
Release notes 与仓库历史里：

```
feat(upload): sort photos by when they were taken, not uploaded
fix(ui): the status pill had no styles on the collections page
chore(deps): move to the Go 1.27 toolchain and refresh dependencies
```

正文写清：原来的行为哪里不对、为什么这么修、有什么边界没覆盖。本项目历史里的好例子可以
`git log` 看 `feat(trash)`、`feat(upload): open HEIC` 两个提交。

### 3.2 提交前自检

```bash
git status --short          # 确认没有 .env / *.db / node_modules / tsbuildinfo
git --no-pager diff --stat
```

`.gitignore` 已经覆盖了这些，但**新增的敏感文件类型要手动确认**一次。

---

## 4. 推送与 CI

```bash
git push origin main
export PATH="$HOME/.local/bin:$PATH"
sleep 170 && gh run list --workflow ci.yml --limit 1 \
  --json status,conclusion,headSha --jq '.[] | "\(.status)/\(.conclusion//"-") \(.headSha[0:7])"'
```

CI 三个 job（`.github/workflows/ci.yml`）：

| job | 内容 |
| --- | --- |
| `Go (vet + test)` | `gofmt -l` 检查、`go vet`、`go test -race` |
| `Frontend` | `pnpm install --frozen-lockfile` + `pnpm build` |
| `Docker image builds` | buildx 构建（不推送） |

约 3–5 分钟。**必须等绿再打标签**，否则会把坏代码发成镜像。

---

## 5. 打标签发布镜像

### 5.1 版本号怎么定

仓库当前处于 `0.x`，按 SemVer 的 `0.x` 约定：

| 改动性质 | 版本 |
| --- | --- |
| 修 bug、无行为变化 | patch（`0.3.0` → `0.3.1`） |
| 新功能 / 有 schema 迁移 | minor（`0.3.0` → `0.4.0`） |
| 破坏性变更 | 等 1.0 再谈 |

本次历史：`0.1.0` 首个公开版 → `0.2.0` 去重 → `0.2.1` 回收站 → `0.3.0` HEIC →
`0.4.0` EXIF 排序。

### 5.2 打标签

```bash
git tag -a v0.4.0 -m "v0.4.0 — 一句话标题" -m "正文：改了什么、为什么、升级注意"
git push origin v0.4.0
```

`-m` 写两段：第一段是标题，第二段是正文。正文里**必须写清**：

- 有没有 schema 迁移、旧库能否直接升级
- 用户需要做什么（改配置、跑一次回填之类）
- 已知限制

### 5.3 等发布流水线

`publish.yml` 由 `v*` 标签触发，构建 `linux/amd64` + `linux/arm64`，**约 6–7 分钟**：

```bash
sleep 280 && gh run list --workflow publish.yml --limit 1 \
  --json status,conclusion,databaseId --jq '.[] | "\(.status)/\(.conclusion//"-") id=\(.databaseId)"'
```

超时就继续 `sleep` + 查询，不要 `kill`。完成后再 `gh run view <id>` 确认 `publish` job 是 ✓。

产出的标签（`docker/metadata-action`）：

| 源代码 | 镜像标签 |
| --- | --- |
| `v0.4.0` | `0.4.0`、`0.4`、`0`、`v0.4.0`、`latest` |

> 注意：`type=semver` 的模式会**剥掉 `v` 前缀**，所以必须保留
> `type=raw,value=${{ github.ref_name }}` 那一行，否则用户从 Release 页复制 `v0.4.0`
> 去 pull 会 404。

---

## 6. 验证发布出来的镜像

**不要只信标签名。** 三步实证：

### 6.1 匿名可拉取

```bash
for t in latest 0.4.0 0.4 v0.4.0; do
  docker rmi -f ghcr.io/rainsunme/family-gallery:$t >/dev/null 2>&1
  printf "%-8s " "$t"
  docker pull -q ghcr.io/rainsunme/family-gallery:$t >/dev/null 2>&1 && echo OK || echo "not found"
done
```

先 `rmi -f` 清本地缓存，否则会假阳性（本地有旧缓存时 pull 会「成功」）。

GHCR 新建的包**默认私有**，匿名拉取会 not found。需要手动改：
`https://github.com/users/<user>/packages/container/family-gallery/settings` → Change
visibility → Public（API 要 `write:packages` scope，默认 token 只有 `repo`）。

### 6.2 内容抽查

```bash
docker run --rm --entrypoint sh ghcr.io/rainsunme/family-gallery:0.4.0 -c '
  strings /usr/local/bin/gallery | grep -c "<本次新增的路由或字段>"
  grep -c "<本次新增的前端字符串>" /app/web/dist/assets/app-*.js
  ls /app/web/dist/assets/ | head'
```

前端资源在 `/app/web/dist/assets/`，后端二进制在 `/usr/local/bin/gallery`。
代码分割出来的懒加载 chunk（如 HEIC 解码器 `chunk-*.js`）是独立文件，主包里只有文件名引用
——搜不到内容不代表没打包，要确认主包里有 chunk 名。

### 6.3 真的跑起来

```bash
docker run -d --name fg-verify --network app_default --env-file .env \
  -e APP_PUBLIC_URL=http://localhost:8090 \      # 见下方坑
  -e S3_ENDPOINT=http://chenguang-garage:3900 -e S3_PUBLIC_ENDPOINT=http://localhost:3900 \
  -p 127.0.0.1:8090:8080 -v family-gallery-local-data:/app/data \
  ghcr.io/rainsunme/family-gallery:0.4.0
```

**两个会让验证假失败的坑，必须同时满足：**

1. **`APP_PUBLIC_URL` 必须等于你访问用的 origin**。`securityHeaders` 对非 GET 请求校验
   `Origin == APP_PUBLIC_URL`，换端口会 403 `ORIGIN_REJECTED`（表现是「登录失败」）。
2. **Garage 的 CORS 规则是按 origin 写入的**。用别的 origin 访问，S3 PUT 会
   `Failed to fetch`（表现是「上传失败」）。

所以验证容器**占用原端口 8090**，并显式传 `-e APP_PUBLIC_URL=http://localhost:8090`，
（验证前先停掉 `family-gallery-local`）。

### 6.4 有 schema 变更时的升级验证

必做，不改代码也要跑：

1. 用**旧版镜像**建一个库，建相册、传一张照片
2. 停掉，换**新版镜像**挂同一 volume 启动
3. 确认：健康检查 200、旧数据完整、新旧接口都能用

`v0.2.0 → v0.2.1`（新增 `deleted_by`/`trash_batch`）就是这样验的。

### 6.5 清场

```bash
docker rm -f fg-verify
# 重新启动日常用的本地实例
docker run -d --name family-gallery-local ... family-gallery:local
```

验证过程建立的临时相册要按 2.4 的方式删掉。

---

## 7. 写 Release

```bash
gh release create v0.4.0 --title "v0.4.0 — 一句话标题" --notes-file /tmp/release.md
```

Release notes 的结构（照抄最近几个 Release 即可）：

```markdown
一句话说明这版解决了什么。

## 改了什么           ← 按功能分小节，说清楚用户能感知到的变化
## 修复                ← 有 bug 修复时写
## 升级                ← 有无 schema 迁移、是否 drop-in、要不要跑一次 backfill
                      ← 给出 docker pull <image>:<version> 和架构说明
## 已知限制 / 设计说明  ← 链接 docs/
```

写给人看不写给机器看：**说明为什么**，不要复述 diff。

---

## 8. 已知的流程缺口（可以顺手改进）

| 缺口 | 说明 |
| --- | --- |
| CI 不跑 `pnpm test` | `web` job 只有 `pnpm build`。`vitest` 用例存在（`src/lib/*.test.ts`）但流水线不执行，回归只能靠人手动跑。加一行 `pnpm test` 即可。 |
| 无 `gofmt` 自动修复 | CI 只检查不修复，本地忘了跑就会红。用第 1.1 节的命令即可避免。 |
| 发布不可重跑同一版本 | 覆盖已发布的 tag 会让人拿到不确定的镜像。宁可发新 patch。 |
| 无 CHANGELOG.md | Release notes 目前是唯一变更记录。`gh release list` 可查。 |

---

## 9. 一页速查

```bash
# 后端校验
docker run --rm -v "$PWD":/src -w /src golang:1.27-alpine \
  sh -c 'gofmt -w cmd internal && go vet ./... && go test ./...'

# 前端校验（必须复制到 /tmp）
docker run --rm -e CI=true -v /tmp/webtest:/src -w /src node:22-alpine \
  sh -c 'corepack enable && corepack prepare pnpm@10.28.2 --activate && \
         pnpm install --frozen-lockfile && pnpm build && pnpm test'

# 镜像
docker build -t family-gallery:local .

# 推送 + 等 CI
git push origin main && sleep 170 && gh run list --workflow ci.yml --limit 1

# 发布
git tag -a vX.Y.Z -m "标题" -m "正文" && git push origin vX.Y.Z
sleep 280 && gh run list --workflow publish.yml --limit 1

# 验证 + Release
docker pull ghcr.io/rainsunme/family-gallery:X.Y.Z
gh release create vX.Y.Z --title "..." --notes-file /tmp/release.md
```
