# HEIC 支持

## 问题

iPhone 默认拍 HEIC。改动之前这个项目对 HEIC 是「假支持」：

| 位置 | 行为 |
| --- | --- |
| 后端白名单 | 允许 `image/heic` / `image/heif` |
| 文件选择器 `accept` | 只有 JPEG/PNG/WebP/GIF，选不到 |
| 前端 MIME 白名单 | 只有 4 种，拖进来直接报「格式不支持」 |
| `imageDimensions` | 见 HEIC 直接 `return {0,0}`，报「读不到尺寸」 |

iPhone 用户一张都传不进来，而后端其实一直收。

## 关键事实

**Chrome 与 Firefox 无法解码 HEIC。** Safari 可以——macOS Ventura 之后、iOS 17 之后系统原生支持。所以：

- 在 iPhone 的 Safari 上传，浏览器自己就能解码；
- 在 Windows / Linux 的 Chrome 上传，必须自带解码器。

## 方案

```
File
 └─ createImageBitmap(file)         ← 平台解码器（Safari 成功即结束）
     └─ 失败且是 HEIC
         └─ libheif-js (WASM)        ← 懒加载 2 MB chunk
             └─ ImageData → canvas
 ├─ resizeToWebp(480)   → thumb
 └─ resizeToWebp(1600)  → preview
```

**不猜 User-Agent，直接试。** 能解码的浏览器永远不下载 WASM，代码路径只有一条。

### 一次解码，两种尺寸

原实现按尺寸各解码一次（`derivative` 调两遍），HEIC 下等于解码两次 WASM。改成
`decodeImage()` 一次，`resizeToWebp()` 从同一个 source 生成两个尺寸。

### 为什么用 `libheif-bundle.mjs`

`libheif-js` 有多个变体：

| 变体 | 大小 | 说明 |
| --- | --- | --- |
| `libheif/libheif.js` | 3.1 MB | 纯 JS 实现，慢 |
| `libheif-wasm/libheif.js` + `.wasm` | 89 KB + 1.4 MB | 需要打包器特殊处理 wasm 路径 |
| **`libheif-wasm/libheif-bundle.mjs`** | **2.0 MB** | wasm 内联，ESM，Vite 直接 code-split |

选第三个：零配置、`import()` 天然懒加载、不需要在容器里额外服务静态 wasm。

## CSP：必须放开 `wasm-unsafe-eval`

**这是最容易漏掉的一步。** 项目原本的 CSP 是 `script-src 'self'`，浏览器会直接拒绝
`WebAssembly.instantiate`：

```
CompileError: ... violates the following Content Security policy directive because
'unsafe-eval' is not an allowed source of script
```

构建通过、类型检查通过、worker 也下载了，但功能在浏览器里完全不可用——只有真的在浏览器
点一次才会发现。

改成 `script-src 'self' 'wasm-unsafe-eval'`：

- `'wasm-unsafe-eval'` 只允许编译 WebAssembly，**不允许** `eval()` JavaScript 源码
- 因此不会像 `'unsafe-eval'` 那样扩大 XSS 攻击面

## 查看器

HEIC 原图在 Chrome 里是坏图。所以 `PhotoViewer` 对 `image/heic|heif` 用 **preview**
而不是 original：

```ts
const heic = /hei[cf]/i.test(photo.mime);
const original = useSignedURL(photo.id, heic ? 'preview' : 'original', guestToken);
```

**原图仍然原样保存**，下载按钮拿到的还是原始 HEIC 字节（实测 718114 bytes，
`ftypmif1` 魔数未变）。这也是项目的原则：不转码、不改写用户的文件。

## 文件选择器

`accept` 同时列 MIME 和扩展名：

```
image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif,.jpg,...
```

原因：macOS 与 Windows 对 `.heic` 的 MIME 报告不一致，常常是空字符串。只用 MIME 会让
选择器把真实照片置灰——比多显示几个类型糟糕得多。

## 失败时的表现

分成两种，因为处理方式不同：

| 文案 | 场景 |
| --- | --- |
| `This HEIC file could not be decoded. Try exporting it as JPEG.` | 文件本身损坏或用了不支持的编码 |
| `This browser cannot open HEIC photos yet…` | 解码器加载失败（网络、CSP 等） |

不要笼统说「格式不支持」——用户会以为是文件问题，实际上是浏览器限制。

## 测试

- `decode.test.ts`：MIME 推断、扩展名兜底、accept 清单
- 端到端（真实 Chromium + 真实 HEIC）：
  - 首次进入不下载解码器
  - 选 HEIC 后解码器加载 **1 次**并成功
  - 存储的 `mime`、宽高正确（1280×854）
  - 缩略图可渲染（`naturalWidth = 480`）
  - 查看器显示 preview，不出现坏图
  - 下载原图字节数与原文件一致
  - 上传 JPEG 时解码器下载次数为 **0**（懒加载未失效）

## 未做

- **服务端转码兜底**：老 Android WebView 之类仍可能失败。代价是镜像 +15–25 MB，且要引入
  CGO 或外挂二进制。当前方案覆盖 iPhone/macOS（能解码）与桌面 Chrome/Firefox（WASM），
  已覆盖真实场景。
- **HEIC 序列图 / Live Photo 视频轨**：只取第一帧。
- **EXIF 拍摄时间**：`taken_at` 仍是上传时间。libheif 能拿到 EXIF，可以顺带修好「按拍摄
  日期分组」，但那是独立改动。
