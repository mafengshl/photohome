# 图片工作流：获取、加载、下载与显示

> 本文档描述一张照片从飞书多维表格到浏览器 3D 圆柱相册展示的完整链路。

---

## 架构总览

```
飞书 Bitable                Cloudflare Pages Functions           浏览器前端
┌──────────────┐           ┌─────────────────────────┐          ┌──────────────────────┐
│  多维表格     │           │  /api/getPhotos          │          │  main.ts             │
│  (图片附件)   │◀──1.token─│  → 获取 token            │◀──fetch──│  loadAllMessages()   │
│              │           │  → 拉取记录              │          │  mapPhotoToMessage() │
│  fields:     │           │  → 批量转临时下载 URL    │          │                      │
│  图片/title/ │           │  → normalizeRecord       │──JSON───▶│  universe.ts         │
│  desc/       │           │  → 客户端分页切片        │          │  buildPageChunks()   │
│  photo_time/ │           └─────────────────────────┘          │  generateLayout()    │
│  sort_order  │                      │                           │  createCardElement() │
└──────────────┘                      │                           │  <img src=...>       │
                         ┌────────────▼──────────────┐           │     onload→重排      │
                         │  /api/photoProxy          │◀──img─────│                      │
                         │  → 后端带 token 下载二进制│──binary──▶│  3D 圆柱显示         │
                         │  → 流式转发给浏览器       │           └──────────────────────┘
                         └───────────────────────────┘
```

---

## 阶段 1：数据获取（Cloudflare Pages Function）

### 1.1 获取 tenant_access_token

文件：[functions/api/getPhotos.js](file:///d:/project/photohome/functions/api/getPhotos.js#L78-L102)

```js
// 模块级缓存，复用 isolate 热实例，提前 5 分钟刷新
async function getTenantAccessToken(env) {
  if (tokenCache.value && tokenCache.expireAt - now > 5 * 60 * 1000)
    return tokenCache.value;
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    body: JSON.stringify({ app_id, app_secret }),
  });
  tokenCache = { value, expireAt: now + expire * 1000 };
}
```

- 密钥（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）仅从 Cloudflare 环境变量读取，前端永远拿不到
- token 有效期约 2 小时，模块级缓存避免重复获取

### 1.2 拉取多维表格记录

文件：[getPhotos.js](file:///d:/project/photohome/functions/api/getPhotos.js#L128-L151)

```js
async function listAllRecords(env, token) {
  do {
    const url = `${FEISHU_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`;
    // 按 page_token 自动翻页，单次最多 500 条
  } while (pageToken);
}
```

- Wiki 链接场景：先调用 `wiki/v2/spaces/get_node` 把 `wikiNodeToken` 解析为 `app_token`（[L104-L126](file:///d:/project/photohome/functions/api/getPhotos.js#L104-L126)），缓存 10 分钟

### 1.3 批量获取图片临时下载 URL

文件：[getPhotos.js](file:///d:/project/photohome/functions/api/getPhotos.js#L154-L201)

```js
async function batchGetTmpUrls(env, token, fileTokens) {
  // 每 50 个 file_token 一批，调用 batch_get_tmp_download_url
  // 成功 → 返回公网可访问的临时链接
  // 失败/缺失 → 兜底为 /api/photoProxy?token=xxx
}
```

- 临时链接有有效期（飞书默认约 8 小时）
- `batch_get_tmp_download_url` 可能因权限不足返回空数组，此时回退到代理端点

### 1.4 整理为前端照片对象

文件：[getPhotos.js](file:///d:/project/photohome/functions/api/getPhotos.js#L204-L235)

```js
function normalizeRecord(env, record, tmpMap) {
  return {
    id: record.record_id,
    title, desc, photoTime, sortOrder,
    url: tmpMap.get(file_token) || '',   // 临时链接或代理 URL
    width: first.width || 1000,          // 飞书附件元数据中的宽，缺失默认 1000
    height: first.height || 1000,
    type: first.type || 'image/jpeg',
  };
}
```

### 1.5 客户端分页与缓存

文件：[getPhotos.js](file:///d:/project/photohome/functions/api/getPhotos.js#L262-L357)

- 全量列表短缓存 30 秒（`listCache`），降低轮询对飞书的请求压力
- 客户端 `?page=1&pageSize=30` 分页切片
- `MOCK_PHOTOS=1` 时返回 picsum.photos 占位图，无需飞书密钥

---

## 阶段 2：前端数据加载

### 2.1 首次加载（带重试）

文件：[src/scripts/api.ts](file:///d:/project/photohome/src/scripts/api.ts#L76-L88)

```ts
export async function fetchFirstWithRetry(): Promise<PhotosResponse> {
  for (let i = 0; i < MAX_RETRY; i++) {
    try { return await fetchPage(1); }
    catch (e) { await delay(600 * (i + 1)); }  // 退避 600ms → 1200ms → 1800ms
  }
}
```

### 2.2 全量分页拉取

文件：[src/scripts/main.ts](file:///d:/project/photohome/src/scripts/main.ts#L78-L97)

```ts
async function loadAllMessages(): Promise<Message[]> {
  const first = await fetchFirstWithRetry();
  const photos = [...first.photos];
  while (hasMore) {
    const data = await fetchPage(page, PAGE_SIZE);
    photos.push(...data.photos);
    page += 1;
  }
  return photos.map(mapPhotoToMessage);
}
```

### 2.3 轮询新增

文件：[api.ts](file:///d:/project/photohome/src/scripts/api.ts#L36-L74)

- 每 30 秒拉取第 1 页（`PAGE_SIZE * 2` 条），按 id 去重新增照片
- 标签页隐藏时跳过，可见时立即补一次

### 2.4 Photo → Message 映射

文件：[main.ts](file:///d:/project/photohome/src/scripts/main.ts#L47-L71)

```ts
function mapPhotoToMessage(photo: Photo): Message {
  const w = photo.width || 1000;
  const h = photo.height || 1000;
  return {
    ...,
    format_type: deriveFormatType(w, h),  // ratio=h/w: ≥1.2→mini, ≤1/1.2→wide, else square
    width: w, height: h,
  };
}
```

### 2.5 测试数据模式

文件：[src/scripts/test-data.ts](file:///d:/project/photohome/src/scripts/test-data.ts)

- `USE_TEST_DATA = true` 时使用 35 张内置 picsum.photos 占位图
- 混合竖图/横图/方图比例，覆盖 mini/wide/square 三种卡片形态
- `sortOrder` 为 1~35，用于验证分页和排序

---

## 阶段 3：3D 布局与卡片创建

### 3.1 分页分档

文件：[src/scripts/universe.ts](file:///d:/project/photohome/src/scripts/universe.ts#L454-L521)

```
buildPageChunks(messages)
  → sortOrder 升序排列
  → 回灌已缓存的真实宽高（realDimensions Map）
  → 分档：1张居中 / 2~4张单行 / 5~29张每行5张 / ≥30张每行10张
  → 切页，每页最多 30 张
```

### 3.2 相框尺寸计算

文件：[universe.ts](file:///d:/project/photohome/src/scripts/universe.ts#L867-L890)

```ts
const BASE_CARD_H = metrics.mini.height;           // 同行统一卡高
const imageAreaH = BASE_CARD_H - pad.top - pad.bottom;
const cardWidth = Math.round(imageAreaH * (w / h) + pad.side * 2);
const cardHeight = BASE_CARD_H;
```

- 卡宽 = 图片区高 × 原图宽高比 + 两侧拍立得边距
- 图片区宽高比严格等于原图比例 → `object-fit: contain` 下框贴图片、无留白

### 3.3 顺序排布 + 统一视觉间距

文件：[universe.ts](file:///d:/project/photohome/src/scripts/universe.ts#L908-L926)

```ts
function placeRowSequentially(rowItems, rowIdx) {
  let pos = -totalAngle / 2;
  rowItems.forEach((item) => {
    const theta = pos + item.angleWidth / 2;  // 中心 = 前一张右边界 + 统一间距 + 自身半宽
    placeCard(item, theta, rowIdx);
    pos += item.angleWidth + effGap;          // 前一张右边界 + 统一间距
  });
}
```

- 相邻卡片边框之间的弧上间距完全一致
- 行超 180° 时整行等比缩小（卡宽、卡高、间距同缩）

### 3.4 卡片 DOM 创建与图片加载

文件：[universe.ts](file:///d:/project/photohome/src/scripts/universe.ts#L178-L293)

```ts
function createCardElement(message, cardWidth, cardHeight) {
  // 1. 克隆模板，设置 inline 宽高
  // 2. 注入拍立得 padding CSS 变量（与 generateLayout 计算严格对齐）
  // 3. 设置 imageEl.src = message.imageUrl
  // 4. onload：读 naturalWidth/Height，比例不符则更新 msg 并触发无动画重排
  // 5. onerror：加时间戳重试 1 次，仍失败回退文字模式
}
```

---

## 阶段 4：图片下载与显示

### 4.1 正常路径：临时公网 URL

```
<img src="https://open.feishu.cn/...tmp_download_url...">
  → 浏览器直接请求飞书 CDN
  → 飞书返回 302 重定向到实际存储地址
  → 浏览器跟随重定向，下载图片二进制
```

- 临时链接有效期约 8 小时，过期后 403
- 前端无需任何鉴权，直接 `<img src>`

### 4.2 兜底路径：photoProxy 代理

文件：[functions/api/photoProxy.js](file:///d:/project/photohome/functions/api/photoProxy.js)

```
<img src="/api/photoProxy?token=file_token">
  → Cloudflare Function 收到请求
  → 后端获取 tenant_access_token
  → 调用飞书 drive/v1/medias/{token}/download
  → 飞书返回 302 → 实际存储地址
  → 后端拿到二进制流，流式转发给浏览器
  → 浏览器 <img> 显示
```

- `batch_get_tmp_download_url` 返回空时自动使用此路径
- 每次请求都经过 Cloudflare Function，增加了延迟
- `tenant_access_token` 在 photoProxy 中独立缓存（不复用 getPhotos 的缓存）

### 4.3 图片显示

```css
.msg-card__image {
  width: 100%;
  height: 100%;
  object-fit: contain;  /* 保持原图比例，不裁剪 */
}
```

- 拍立得相框尺寸 = 图片区高 × 原图比例 + padding
- 图片区宽高比与原图一致 → `contain` 恰好填满，无留白

### 4.4 真实宽高修正

文件：[universe.ts](file:///d:/project/photohome/src/scripts/universe.ts#L259-L277)

```ts
imageEl.onload = () => {
  const nw = imageEl.naturalWidth;
  const nh = imageEl.naturalHeight;
  // 飞书可能不返回真实宽高（默认 1000×1000）
  // 加载后读 naturalWidth/Height，比例偏差 >2% 则更新并触发重排
  realDimensions.set(message.id, { width: nw, height: nh });
  if (Math.abs(nw / nh - ow / oh) > 0.02) scheduleDimensionRelayout();
};
```

- 80ms 防抖合并，避免每张图都重排一次
- 真实尺寸按 id 持久缓存，轮询刷新/resize 重建后回灌

---

## 完整时序图

```
浏览器                    Cloudflare Function              飞书 API
  │                              │                            │
  │── GET /api/getPhotos ───────▶│                            │
  │                              │── POST auth/v3/token ─────▶│
  │                              │◀── tenant_access_token ────│
  │                              │── GET bitable/records ─────▶│
  │                              │◀── records + page_token ───│
  │                              │  (循环翻页直到 has_more=false)│
  │                              │── GET batch_tmp_url ───────▶│
  │                              │◀── tmp_download_urls ──────│
  │                              │  (空 → 兜底 /api/photoProxy) │
  │◀── JSON { photos[] } ────────│                            │
  │                              │                            │
  │  buildPageChunks → generateLayout → createCardElement     │
  │  设置 <img src="tmp_url" 或 "/api/photoProxy?token=..."> │
  │                              │                            │
  │── GET tmp_url (或 proxy) ───▶│── GET medias/download ───▶│
  │                              │◀── 302 → binary ───────────│
  │◀── image binary ─────────────│◀── binary stream ─────────│
  │                              │                            │
  │  img.onload → naturalWidth/Height                          │
  │  → 比例修正 → 80ms 合并重排                                 │
  │  → 最终 3D 圆柱布局                                        │
```

---

## 当前存在的问题与优化方向

### 需要优化（已知问题）

| # | 问题 | 影响 | 优化方案 |
|---|------|------|----------|
| 1 | **photoProxy 独立 token 缓存** | `getPhotos.js` 和 `photoProxy.js` 各维护一份 `tokenCache`，同一 isolate 内可能获取两次 token | 抽取共享 token 模块（如 `functions/_shared/token.js`），两个 Function 共用 |
| 2 | **临时链接过期无刷新** | `tmp_download_url` 有效期约 8 小时，用户长时间停留后轮询新增照片，旧链接可能 403 | 轮询响应中只返回新增照片的 URL，旧照片 URL 不变；或缓存 URL 时记录生成时间，过期时重新批量获取 |
| 3 | **photoProxy 无浏览器缓存** | 每次刷新页面都重新走代理下载，增加延迟和 Function 调用次数 | `Cache-Control` 增加 `immutable` + 长期 `max-age`，浏览器 + Cloudflare CDN 双层缓存 |
| 4 | **宽高默认 1000×1000** | 飞书附件元数据的 `width/height` 可能缺失，首屏布局用错误比例，加载后才修正 → 闪烁 | 方案 A：`getPhotos` 中补充图片头探测（成本高）；方案 B：前端 `createCardElement` 在设 `src` 前先 `new Image()` 预加载获取尺寸（增加并行请求但避免闪烁） |
| 5 | **全量拉取后客户端分页** | 照片多时首次加载拉全量（可能数百条），等待时间长 | 服务端只返回当前页的 30 条，前端按需翻页；但需服务端先排序再切片 |
| 6 | **轮询拉第 1 页 ×2** | 30 秒轮询一次，每次拉 60 条，对飞书请求压力大 | 轮询只拉 `total` 字段对比数量，有新增才拉详情 |

### 可以优化（性能提升）

| # | 方向 | 收益 | 实现思路 |
|---|------|------|----------|
| A | **图片懒加载** | 首屏只加载正面可见的 5~6 张图片，侧面/背面延迟加载 | `loading="lazy"` 已有但 CSS3DRenderer 场景中不生效（所有卡片同时在视口）；可改为按角度距离按序设 `src` |
| B | **图片压缩/缩略图** | 飞书原图可能 5MB+，3D 场景中卡片仅 ~400px 宽，传输浪费带宽 | 飞书 `download` 支持 `?extra={"bit":1024}` 参数指定尺寸，或 Cloudflare Image Resizing |
| C | **预加载下一页** | 翻页时等待图片下载，体验卡顿 | 当前页加载完后，预取下一页 JSON + 前几张图 |
| D | **WebP/AVIF 格式转换** | 减小传输体积 30~50% | Cloudflare Polish 或 Image Resizing 自动转格式 |
| E | **token 预热** | 首次请求要等 token 获取 + 记录拉取，冷启动慢 | Cloudflare Cron Trigger 定期预热 token；或在 `onRequest` 入口提前并行获取 |
| F | **CDN 边缘缓存** | 照片 JSON 可在 Cloudflare CDN 边缘缓存，减少回源 | `Cache-Control: s-maxage=30` 让 CDN 缓存 30 秒，`stale-while-revalidate` 后台刷新 |
| G | **图片占位色/skeleton** | 图片加载前白框闪烁 | 根据图片主色设 `background-color`，或用低分辨率模糊占位图（LQIP） |
| H | **photoProxy 流式 Range 支持** | 大图断点续传 | 检查 `Range` 请求头，转发给飞书 download API |
