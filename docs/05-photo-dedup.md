# 照片去重设计

## 目标

同一份文件字节被重复上传时，不要存第二份。重复上传在家庭场景里很常见：多人在群里
各自保存同一张照片、忘了传过隔几天又传一遍、走邀请链接传过组织者又自己传一次。

去重只处理一件事：**文件字节完全相同**。同一画面但重新编码过（截图、微信压缩、
HEIC 导出为 JPG）不算重复，这是字节级方案固有的边界，不是缺陷。

## 四条前提

| 前提 | 取值 | 理由 |
| --- | --- | --- |
| 哈希算法 | SHA-256 全文件 | 碰撞概率可忽略 |
| 计算位置 | 浏览器 Web Worker | 项目约束是照片不经过应用服务器 |
| 去重范围 | 相册内 `(album_id, content_hash)` | 跨相册需要引用计数并重建 `photos` 表，风险高、收益低 |
| 命中行为 | 显式提示，用户可选强制添加 | 静默跳过一旦误判就是"照片不见了" |

## 数据模型

```sql
ALTER TABLE photos ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN dedup_key TEXT;

-- 只约束未删除且未强制添加的行。SQLite 的 UNIQUE 允许多个 NULL，
-- 所以 dedup_key = NULL 表示"用户明确要求添加重复项"。
CREATE UNIQUE INDEX IF NOT EXISTS photos_album_dedup
  ON photos(album_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS photos_content_hash
  ON photos(content_hash) WHERE content_hash <> '';

ALTER TABLE upload_sessions ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_sessions ADD COLUMN allow_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submission_items ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
```

唯一性由数据库保证，不依赖应用层 check-then-insert。软删除的行因为
`deleted_at IS NOT NULL` 自动退出索引，所以回收站里的照片不会阻止重新上传。

## 时序

1. 浏览器在 Worker 里分块算 SHA-256（4 MiB/块，内存有界）
2. 批次内自查：hash 相同的文件只保留一个
3. `POST /uploads/check` 批量预检，拿到已有照片信息
4. 界面列出重复项，用户确认是否跳过
5. 逐个 `POST /uploads` 授权 → 直传 S3 → `POST /complete`
6. 服务端在授权时查重返回 409，在写入时靠唯一索引兜底

预检的价值是"别让我白传 1 GB"：哈希比上传快一到两个数量级。

## API

### `POST /api/v1/uploads/check`

```jsonc
// 请求，hashes 最多 200 条，每条 64 位小写 hex
{ "album_id": "uuid", "hashes": ["ab12…"] }

// 200
{
  "duplicates": {
    "ab12…": {
      "id": "photo-uuid",
      "name": "first day at the sea.jpg",
      "contributor": "Mom",
      "taken_at": "2026-08-03T10:11:12Z",
      "thumb_url": "https://…"
    }
  },
  "new": ["cd34…"],
  "legacy_photos": 16
}
```

`legacy_photos` 是该相册里没有 `content_hash` 的旧照片数量。去重上线前上传的照片
无法参与比对，界面必须如实显示这个数字。

### `POST /api/v1/uploads`

新增两个字段：

```jsonc
{ "content_hash": "ab12…", "allow_duplicate": false }
```

重复时返回 409，并带上已存在的照片：

```jsonc
{
  "error": { "code": "DUPLICATE_PHOTO", "message": "…" },
  "existing": { "id": "…", "name": "…", "thumb_url": "…" }
}
```

`content_hash` 为空时按旧行为处理（不做去重），保证旧客户端不会被破坏。

### 访客与导入

访客上传只记录哈希，**不在访客侧拦截**——访客看不到家庭图库，拦了只会让他困惑。
去重发生在导入时：命中的提交项标记为 `status='duplicate'`，响应里返回
`skipped_duplicates`。

## 边界情况

| 情况 | 行为 |
| --- | --- |
| 同一文件传两次到同一相册 | 第二次 409，可强制添加 |
| 同一文件传到不同相册 | 允许，存两份 |
| 内容相同但文件名不同 | 命中 |
| EXIF 被重写 / 转码 / 截图 | 不命中，属字节去重的固有限制 |
| 批次内 3 个相同文件 | 本地合并为 1，界面提示 |
| 客户端伪造 hash | 最坏结果是误拦一次，用户点"仍然添加"即可；服务端从不按 hash 引用对象 |
| 相册里有不带 hash 的旧照片 | 不参与比对，界面显示数量 |
| 回收站中的同内容照片 | 不拦截 |
| 内容哈希 | 不出现在任何列表响应里 |

### 被否决的做法

| 做法 | 否决理由 |
| --- | --- |
| 用 S3 ETag 当哈希 | 多段上传的 ETag 不是内容哈希，各实现不一致；且拿到时字节已传完 |
| 服务端读 S3 算哈希 | 违背"照片不经过应用服务器"，且整库多读一遍 |
| 首尾 1 MiB + 大小的弱哈希 | 省下的时间不值得承担误吞照片的风险 |
| 感知哈希 | 误判率无法归零 |
| 全局唯一索引 | 需要引用计数并重建 `photos` 表，与回收站清理强耦合 |

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEDUP_ENABLED` | `true` | 关闭后服务端忽略 `content_hash`，退化为旧行为 |
| `DEDUP_BACKFILL` | `false` | 启动时为旧照片回填 `content_hash`，需要把整个库从 S3 读一遍 |

## 测试

- `validateContentHash`：64 位小写 hex 通过，长度、大小写、非 hex、空串拒绝
- `dedupKeyFor`：强制添加返回 NULL，否则返回哈希
- `findDuplicate`：内存 SQLite，跨相册互不影响，软删除后不再命中
- 前端哈希实现与 `crypto.subtle.digest` 结果一致
- 集成：重复上传 409、强制添加 201、换相册可上传、预检结果正确
