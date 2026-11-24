# Garage S3 实现与迁移说明

日期：2026-11-22

> **归档说明**：本文记录迁移时的实现状态。当时可运行的代码在独立目录 `app/`，该目录
> 已在仓库整理时删除；其实现已演进为本仓库（`family-gallery/`）本身。

## 当前决定

项目已从原腾讯云 COS 方案迁移到**家庭服务器上的 Garage / 通用 S3**。迁移完成时，可运行的实现在 `app/`，不再是纯技术设计。

- Go 使用 **AWS SDK for Go v2**，不依赖腾讯云 SDK。
- Garage 本地测试版本为 `dxflrs/garage:v2.5.0`。
- Path-style S3 URL，支持对象级预签名 GET、PUT、分片上传、HEAD、CopyObject、DeleteObject。
- 分离 `S3_ENDPOINT`（服务端内部读写）与 `S3_PUBLIC_ENDPOINT`（浏览器预签名）。
- 原图、缩略图、预览图、收集对象、ZIP 都直接存储于 S3，不作为 Go 响应转发。

历史迁移交接记录与 [`02-technical-design.md`](./02-technical-design.md) 中的腾讯云资源、CAM、域名与数据万象内容属于迁移前档案，不能作为当前部署凭据或配置来源。

## 与当前实现的差异

- 当前 API 进程内含单 worker 循环处理 ZIP，未来可拆成独立 worker。
- 首发格式为 JPEG、PNG、WebP、GIF；HEIC 和视频转码尚未实现。
- 管理端相册修改接口存在，回收站与删除 UI 尚未开放。
- 只读分享和收集邀请使用**不可预测的公开资源 ID**，管理端可重复展示邀请链接。访客会话 Cookie 仍使用随机令牌，数据库只存 SHA-256 哈希。
- 收集上传与家庭上传使用独立对象前缀、独立会话和独立权限检查。
- ZIP 使用有界临时文件，不把整个相册载入内存；实际 ZIP 文件大小上传 S3，过期任务先清理分卷再删除任务。

## 本地实测

| 验证项 | 结果 |
| --- | --- |
| Garage 节点与匿名访问 | 健康；匿名访问返回 403 |
| 家庭上传 | 浏览器真实上传原图、缩略图、预览图成功 |
| 大文件 | 约 9 MiB，2 个分片，ETag 与 CompleteMultipartUpload 成功 |
| 收集参与者 | 独立会话上传成功，不能读取家庭相册或他人提交 |
| 收集管理 | 贡献者、待整理、收入相册、真实计数更新 |
| 只读分享 | 匿名浏览指定相册成功，跨相册访问返回 403 |
| ZIP | 从 S3 下载成功，5 张原图，CRC 校验通过 |
| 浏览器路由 | 侧栏、详情、收集、分享页面切换正常 |
| 移动布局 | 390px 无横向溢出，纯图标玻璃底栏与 44px 触控区 |
| 构建测试 | Go 单测通过；TypeScript 严格检查与 Vite 生产构建通过 |

## 家庭服务器联调清单

1. 使用本仓库独立的 `.env`，不复用历史混合云配置（旧项目里的 `app/.env` 已随目录删除）。
2. 配置 Garage 的私有 Bucket、专用 Access Key、Region 和 Path-style Endpoint。
3. 使用 HTTPS 公网 S3 Endpoint，确认证书与签名 Host 一致。
4. 通过 `APP_PUBLIC_URL` 设置应用 HTTPS Origin，再调用管理员 `PUT /api/v1/storage/cors` 配置 Garage CORS。
5. 使用同一张小图片验证浏览器上传、网格读取、收集提交和分享浏览。
6. 使用大于 8 MiB 的图片验证分片上传与 ETag。
7. 创建 ZIP，确认下载直接指向 Garage，不经过应用 `/download` 转发。
8. 验证匿名拒绝、撤销分享、结束收集、过期链接、跨相册与跨收集访问。
9. 配置 SQLite 与 Garage 数据备份；单节点 Garage 没有副本，必须另行备份。

具体启动、配置和目录说明见仓库根目录的 [`README.md`](../README.md)。
