# 家庭相册 · 文档索引

本目录分两部分：**当前实现与运维**（04–08）与**迁移期历史档案**（01–03）。

## 当前实现与运维

1. [`../README.md`](../README.md)：当前功能、部署步骤、环境变量与边界。
2. [`08-release-workflow.md`](./08-release-workflow.md)：本地校验 → 运行时验证 → 提交 →
   tag → 出镜像 → 验证镜像 → Release 的完整 runbook。
3. 功能设计说明（写清取舍与被否决方案，改动相关区域前先读）：
   - [`04-photo-dedup.md`](./04-photo-dedup.md)：照片去重（`dedup_key` 与软删除的配合）。
   - [`05-trash.md`](./05-trash.md)：回收站、批量恢复与永久删除顺序。
   - [`06-heic.md`](./06-heic.md)：浏览器端 HEIC 解码与 CSP 约束。
   - [`07-exif-time.md`](./07-exif-time.md)：EXIF 拍摄时间的解析与校验。
   - [`09-upload-queue.md`](./09-upload-queue.md)：批量上传队列、断点续传、目录句柄与 PWA。
4. [`screenshots/`](./screenshots/)：README 使用的截图素材与规格说明。

## 历史档案（迁移前，仅供追溯）

> 01–03 写于 Garage 迁移前后。文中提到的 `app/`、`design/`、`final-design/` 与迁移交接
> 记录均已在仓库整理时删除，相关实现已演进为当前仓库本身。这些文档**不能作为当前部署
> 凭据或配置来源**。

1. [`01-product-requirements.md`](./01-product-requirements.md)：产品目标、角色、完整功能、
   边界、非功能需求与验收标准。
2. [`02-technical-design.md`](./02-technical-design.md)：迁移前的 Go、Vite/React/TypeScript/
   Tailwind、SQLite 与 COS 技术设计档案。
3. [`03-garage-implementation.md`](./03-garage-implementation.md)：从 COS 迁移到 Garage /
   通用 S3 的差异说明与联调清单。

## 当前基线

- 单家庭共享空间，无个人账号体系；共享口令与管理口令分离。
- 只读分享与照片收集是两种独立、受限的访客权限。
- 图片与 ZIP 下载不经过应用服务器向浏览器中转。
- Go 单体 API + SQLite + 内置限量 worker。
- Vite + React + TypeScript + Tailwind CSS。
- 原图不可覆盖，衍生图与下载包使用独立 S3 对象。
