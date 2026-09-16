# In A Moment · 事件共享相册

一个无独立后端、无数据库的事件照片共享相册。
部署在 Cloudflare Pages，使用 Pages Functions 作为安全代理层，数据源是飞书多维表格 Bitable。
视觉与交互参考 [photos.inamomentweunite.com](https://photos.inamomentweunite.com)：极简深色、Three.js 3D 圆柱相册、180° 半弧布局、拍立得翻转、极简全屏灯箱、定时轮询自动追加新照片。

## 技术栈

- **Astro** + **TailwindCSS** + **TypeScript**
- **Three.js**（CSS3DRenderer + OrbitControls + TWEEN.js）3D 圆柱相册
- **Cloudflare Pages Functions**（`functions/api/getPhotos.js` + `functions/api/photoProxy.js`）作为飞书 API 安全代理
- 数据源：**飞书多维表格 Bitable**（图片附件 / title / desc / photo_time / sort_order）
- 无数据库、无重型 UI 库，前端交互全部用原生 TS + Tailwind 实现

## 目录结构

```
photohome/
├── astro.config.mjs          # Astro 配置（静态输出）
├── tailwind.config.mjs
├── tsconfig.json
├── package.json
├── .env.example              # 环境变量示例（勿填真实密钥）
├── functions/
│   └── api/
│       ├── getPhotos.js      # 飞书代理：取 token / 列记录 / 转临时链接 / 分页 / 缓存 / CORS
│       └── photoProxy.js     # 飞书附件下载代理（授权头透传）
├── src/
│   ├── layouts/Layout.astro
│   ├── components/
│   ├── pages/index.astro     # 单页面入口（3D 容器 / 灯箱 / HUD）
│   ├── scripts/
│   │   ├── universe.ts       # Three.js 场景 / 圆柱布局 / Raycast 命中
│   │   ├── interactions.ts   # 飞入阅读模式 / 翻转 / 翻页 / 键盘
│   │   ├── lightbox.ts       # 全屏灯箱（放大 + 拍立得翻转）
│   │   ├── tween.ts          # TWEEN mainGroup 封装（createTween）
│   │   ├── zoom-control.ts   # 缩放滑块
│   │   ├── petals.ts         # 樱花飘落特效
│   │   ├── api.ts            # fetch 封装、轮询、重试
│   │   ├── types.ts
│   │   ├── test-data.ts      # MOCK_PHOTOS=1 时的占位数据
│   │   └── main.ts           # 主入口
│   └── styles/global.css
├── public/
└── README.md
```

## 架构说明

1. **前端**：Astro 静态构建。页面加载后由 `src/scripts/main.ts` 拉取 `/api/getPhotos`，
   用 Three.js `CSS3DRenderer` 渲染 180° 半弧圆柱相册，卡片按 `sort_order` 升序填充，
   行内同高、自适应原图比例，按数量分档（1 张居中 / 2-4 单行 / 5-29 最多 5 张一行 / ≥30 三行十列）。
2. **代理层**：`functions/api/getPhotos.js` 在 Cloudflare 边缘运行：
   - 获取并缓存 `tenant_access_token`；
   - 分页拉取飞书多维表格全部记录（按 `page_token` 翻页）；
   - 读取字段：图片附件、`title`、`desc`、`photo_time`、`sort_order`；
   - 调用 `batch_get_tmp_download_url` 把 `file_token` 转换为公网可访问的临时链接；
   - 全量列表短缓存（默认 30s），降低轮询压力；
   - 处理 CORS、捕获异常。
3. **图片代理**：`functions/api/photoProxy.js` 透传飞书附件下载授权头，前端 `<img>` 通过 `/api/photoProxy` 加载附件。
4. **数据源**：飞书多维表格。

> 安全约束：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BITABLE_APP_TOKEN` /
> `FEISHU_BITABLE_TABLE_ID` 全部配置在 Cloudflare Pages 环境变量，绝不进入前端代码。
> 浏览器只访问 `/api/getPhotos` 与 `/api/photoProxy`，永远不直接接触飞书开放 API。

## 缓存架构（2026-09-16 优化）

### 问题
飞书 `batch_get_tmp_download_url` 返回的临时链接有时效（通常 1 小时），无法被 Cloudflare CDN 缓存，每次刷新页面都要重新从飞书拉图片，首屏加载慢、重复请求浪费。

### 方案
引入**双代理 + 分层缓存**架构，所有飞书附件 URL 由稳定标识驱动：

| 层级 | 缓存策略 | 生效位置 | 有效期 |
|------|---------|---------|--------|
| 图片代理 | `Cache-Control: public, max-age=86400, s-maxage=604800, immutable` | 浏览器 + CF CDN | 浏览器 1 天 / CDN 7 天 |
| API 数据 | `Cache-Control: public, max-age=300, s-maxage=600, stale-while-revalidate=1800` | 浏览器 + CF CDN | 浏览器 5 分钟 / CDN 10 分钟 |
| 静态资源 | `Cache-Control: public, max-age=31536000, immutable`（通过 `public/_headers`） | 浏览器 + CF CDN | 1 年 |
| Function 内存 | 模块级变量 `listCache` / `tokenCache` | CF Worker 热实例 | token 2 小时 / list 30 秒 |

### URL 链路
```
前端 <img src="/api/photoProxy?token=<file_token>">
  ↓ Cloudflare CDN 命中? → 直接返回缓存图片 (秒级)
  ↓ 未命中 → Pages Function photoProxy.js
    ↓ 拿 tenant_access_token → 飞书 /drive/v1/medias/{file_token}/download
    ↓ 流式转发图片二进制 + 强缓存头返回
```

### 关键设计
- **file_token 作为永久标识**：飞书附件的 `file_token` 在附件不变时不会变，URL `/api/photoProxy?token=xxx` 完全稳定，可以用 `immutable` 让浏览器永不重验
- **移除 batch_get_tmp_download_url**：不再调用飞书临时链接 API（省一次网络请求），直接从 `file_token` 构造 proxy URL
- **`?refresh=1` 强制刷新**：`/api/getPhotos?refresh=1` 跳过内存缓存 + 返回 `no-store` 响应头，手动触发从飞书拉最新数据

## 一、创建飞书自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 「开发者后台」→ 创建企业自建应用。
2. 记录 **App ID** 和 **App Secret**（对应环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。
3. 进入应用「权限管理」，开通以下权限（按需，最小权限原则）：
   - `bitable:app:readonly`（查看多维表格，读取记录必需）
   - `wiki:node:read`（如表格通过知识库引用）
   - `drive:drive:readonly`（用于 `batch_get_tmp_download_url`，把附件 file_token 转成可访问链接）
4. 在「应用功能」中启用「机器人」入口并发布版本（自建应用需发布后才能被调用）。
5. 把该应用「添加到多维表格」或把多维表格分享给应用对应的群组，确保应用对目标表格有读取权限。
   若表格开启了**高级权限**，需要在高级权限设置中授予应用对应读写权限，否则记录会返回为空。

## 二、多维表格字段创建指引

新建（或复用）一个多维表格，按下表创建字段：

| 字段名（默认）   | 类型   | 说明                                  | 环境变量覆盖              |
| ------------- | ---- | ----------------------------------- | ------------------- |
| 图片            | 附件   | 每条记录的第一张附件作为展示图                      | `PHOTO_FIELD_IMAGE` |
| title         | 单行文本 | 照片标题（灯箱 alt / 无障碍）                  | `PHOTO_FIELD_TITLE` |
| desc          | 多行文本 | 照片描述（拍立得背面内容）                       | `PHOTO_FIELD_DESC`  |
| photo_time    | 日期   | 拍摄时间                                | `PHOTO_FIELD_TIME`  |
| sort_order    | 数字   | 排序字段，升序填充到 180° 半弧（左→右、上→下）         | `PHOTO_FIELD_SORT`  |

> 从多维表格 URL 获取：
>
> - `https://xxx.feishu.cn/base/<APP_TOKEN>?table=<TABLE_ID>&view=...`
> - `APP_TOKEN` → `FEISHU_BITABLE_APP_TOKEN`
> - `TABLE_ID` → `FEISHU_BITABLE_TABLE_ID`

## 三、部署操作步骤

### 部署前置说明

- 项目技术栈：Astro + TailwindCSS + Cloudflare Pages Functions
- 数据源：飞书多维表格 Bitable，通过 CF Functions 代理调用
- 部署平台：Cloudflare Pages，代码可托管在 GitHub 仓库

### 方式一：GitHub 自动部署（推荐）

1. **仓库准备**：将完整项目代码推送到 GitHub 仓库（公开或私有均可）。
2. **Cloudflare Pages 关联仓库**：
   - 进入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages → Connect to Git
   - 选择对应 GitHub 仓库并完成授权
   - 构建设置：
     - 构建命令：`npm run build`
     - 构建输出目录：`dist/`
     - 框架预设选择 `Astro`
     - Root directory：`/`（按仓库实际情况）
3. **环境变量配置**：在 Pages 项目的「Settings → Environment variables」中添加以下变量，Production 与 Preview 环境都需添加：

   | 变量名                        | 说明                          | 必填 |
   | -------------------------- | --------------------------- | -- |
   | `FEISHU_APP_ID`            | 飞书自建应用 App ID               | 是  |
   | `FEISHU_APP_SECRET`        | 飞书自建应用 App Secret           | 是  |
   | `FEISHU_BITABLE_APP_TOKEN` | 飞书多维表格 app_token            | 是  |
   | `FEISHU_BITABLE_TABLE_ID`  | 飞书多维数据表 table_id            | 是  |
   | `PHOTO_FIELD_IMAGE`        | 附件字段名（默认 `图片`）              | 否  |
   | `PHOTO_FIELD_TITLE`        | 标题字段名（默认 `title`）           | 否  |
   | `PHOTO_FIELD_DESC`         | 描述字段名（默认 `desc`）            | 否  |
   | `PHOTO_FIELD_TIME`         | 日期字段名（默认 `photo_time`）      | 否  |
   | `PHOTO_FIELD_SORT`         | 排序字段名（默认 `sort_order`）      | 否  |
   | `PHOTO_CACHE_TTL`          | 全量列表缓存秒数（默认 `30`）           | 否  |
   | `PHOTO_PAGE_SIZE`          | 默认每页条数（默认 `30`）             | 否  |

4. **触发部署**：保存设置后提交代码到 main 分支即自动触发构建部署，等待部署完成获取官方预览域名（`<project>.pages.dev`）。
5. `/api/getPhotos` 与 `/api/photoProxy` 由 Pages Functions 自动随附部署，无需额外配置。

### 方式二：本地 Wrangler 命令行部署

1. **全局安装 Wrangler CLI**：
   ```bash
   npm install -g wrangler
   ```
2. **登录 Cloudflare 账号**：
   ```bash
   wrangler login
   ```
   按指引完成浏览器授权。
3. **本地执行构建**：
   ```bash
   npm install
   npm run build
   ```
4. **执行部署命令**：
   ```bash
   npx wrangler pages deploy dist
   ```
   首次会提示输入项目名并选择分支，部署完成后返回 `<project>.pages.dev` 域名。
5. **配置环境变量**：回到 Cloudflare Pages 控制台「Settings → Environment variables」按上表添加全部环境变量（CLI 部署不携带密钥）。

## 四、本地调试（wrangler）

本地调试时，密钥放在 `.dev.vars`（已被 `.gitignore` 忽略，切勿提交）：

```bash
# 1. 复制示例
cp .env.example .dev.vars

# 2. 填入真实值（与 Cloudflare 环境变量一致）
# FEISHU_APP_ID=cli_xxx
# FEISHU_APP_SECRET=xxx
# FEISHU_BITABLE_APP_TOKEN=xxx
# FEISHU_BITABLE_TABLE_ID=tblxxx
```

启动本地开发服务（推荐方式）：

```bash
# 先构建静态产物
npm run build

# wrangler pages dev 托管 dist + functions/，注入 .dev.vars 环境变量
npx wrangler pages dev ./dist --port 8788
```

访问 `http://127.0.0.1:8788` 即可看到带飞书数据的完整站点。

> `wrangler pages dev` 会读取 `.dev.vars` 注入环境变量，`functions/api/getPhotos.js` 可正常调用飞书。
> 纯前端调试（不连飞书）可直接 `npm run dev`（仅 Astro，/api 不可用）；或设置环境变量 `MOCK_PHOTOS=1` 用 picsum.photos 占位图。

## 五、部署后线上功能验收清单

部署完成后，在线上预览域名逐项验证：

1. **数据加载**：飞书表格内的图片、标题、日期正常显示，无空白、无控制台报错。
2. **布局规则**：按分档规则排列（1 张居中 / 2-4 单行 / 5-29 最多 5 张一行 / ≥30 三行十列），卡片间距均匀，无重叠、无错位、无单侧偏移。
3. **核心交互**：
   - 拖拽旋转圆柱视角
   - 单击卡片飞入阅读模式（吸附居中）
   - 阅读模式下点击卡片或底部翻转按钮触发拍立得翻转（可来回翻）
   - 全屏灯箱开关（双击卡片或点击放大按钮）
   - 灯箱内同样支持拍立得翻转（点击卡片 / 底部按钮 / 空格键）
   - 上下翻页按钮、键盘方向键翻页
   - ESC 退出阅读模式 / 灯箱
4. **分页逻辑**：满 30 张自动分页，页码与分页栏对应准确，首尾页按钮状态正确（首张禁用上一页、末张禁用下一页）。
5. **特效层级**：樱花背景正常飘落，不遮挡卡片、不干扰点击交互。

## 六、移动端专项测试方案

### 1. 本地快速模拟测试

- 打开 Chrome 浏览器开发者工具（F12），切换到设备模拟模式（Ctrl+Shift+M）
- 分别选择 iPhone 14、小米 13 等主流机型尺寸，验证：
  - 180° 半弧布局适配正常，卡片大小适配屏幕，无横向溢出
  - 触屏拖拽旋转跟手，纵向滑动不触发旋转，页面可正常上下滚动
  - 点击卡片、灯箱翻转、翻页按钮触控正常，无点击偏移
  - 樱花特效数量自动降级，页面滑动无明显卡顿

### 2. 真机局域网测试（本地开发阶段）

- 确保手机与电脑连接同一 WiFi 网络
- 启动本地开发服务并绑定主机：
  ```bash
  npm run build
  npx wrangler pages dev ./dist --port 8788 --ip 0.0.0.0
  ```
  或使用 Astro 原生 dev：
  ```bash
  npm run dev -- --host
  ```
- 手机浏览器访问「电脑局域网 IP + 端口」（如 `http://192.168.1.100:8788`），进行真机交互验证
- 重点测试：触屏拖拽手感、滚动冲突、灯箱点击、页面加载性能

### 3. 线上真机终测

- 部署完成后，用手机浏览器访问线上 `<project>.pages.dev` 域名
- 覆盖测试：微信内置浏览器、iOS Safari、安卓 Chrome 三大环境
- 验证完整流程：首屏加载速度、布局适配、拖拽旋转、点击翻转、翻页切换、灯箱预览

## 七、自定义域名绑定（可选）

如需绑定自有域名，在 Cloudflare Pages 控制台「Custom domains」中添加域名，按照页面提示完成 DNS 解析配置即可，自动生效 HTTPS。

## 八、常见问题排查

1. **图片不显示**：
   - 检查环境变量是否填写正确（`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BITABLE_APP_TOKEN` / `FEISHU_BITABLE_TABLE_ID`）
   - 飞书自建应用是否已开通 `bitable:app:readonly` 与 `drive:drive:readonly` 权限
   - 应用是否已加入对应表格协作者（高级权限表格需额外授权）
2. **移动端卡顿**：
   - 确认已按设备分级关闭景深模糊、樱花数量已自动降级
   - 检查页面上是否有未懒加载的大图
3. **部署构建报错**：
   - 检查 Node 版本（推荐 ≥ 18）
   - 依赖是否完整安装（`npm ci` 优于 `npm install`）
   - 构建命令与输出目录是否匹配（`npm run build` / `dist`）
4. **阅读模式下点击卡片不翻转**：
   - 卡片点击走 Three.js Raycast（`pickCardAt` 命中 `cardHitMeshes`），不是 DOM 冒泡
   - `onDocumentClick` 不能在 reading-mode 下早返回（已修复，见 `src/scripts/universe.ts`）
5. **翻转后底部按钮消失**：
   - `refreshFlipHintPosition` 不能因卡片 `is-flipped` class 返回 false
   - 卡片本身不旋转，只有内部 `.msg-card__flip-container` 旋转，`getBoundingClientRect` 不变

## 九、可调参数

| 位置                           | 项                                     | 默认值                   |
| ---------------------------- | ------------------------------------- | --------------------- |
| `src/scripts/api.ts`         | `POLL_INTERVAL_MS`                    | 30s                   |
| `src/scripts/api.ts`         | `PAGE_SIZE`                           | 30                    |
| `src/styles/global.css`      | 拍立得 padding / 卡片尺寸变量                  | 桌面 15/15/74，移动按断点收敛    |
| `src/scripts/universe.ts`    | 圆柱半径 / 半弧角度 / `VISUAL_GAP`           | 180° / 动态弧长间距          |
| `functions/api/getPhotos.js` | `PHOTO_CACHE_TTL`                     | 30s                   |
| `functions/api/getPhotos.js` | 客户端 `page` / `pageSize`               | 1 / 30                |

## 十、关于 @astrojs/cloudflare 适配器（重要说明）

需求中要求同时使用「`@astrojs/cloudflare` 适配器」与「`functions/api/getPhotos.js` 作为安全代理层」，
但二者在 Cloudflare Pages 上**互斥**：

- `@astrojs/cloudflare` 适配器要求 `output: 'server'` 或 `'hybrid'`，构建时会在 `dist/` 下生成
  `_worker.js`（高级模式 Worker）。
- Cloudflare Pages **不允许** **`_worker.js`** **与** **`functions/`** **目录同时存在**（部署期会报冲突）。
- 同时适配器在 `output: 'static'` 下会直接报错，无法启用。

因此本项目采用**不冲突、且完全满足安全代理需求**的组合：

- `astro.config.mjs` 使用 `output: 'static'`，前端产物纯静态，部署到 Pages 的静态资源；
- `/api/getPhotos` 与 `/api/photoProxy` 由 `functions/api/` 下的 Pages Functions 承载，
  所有飞书调用在边缘执行、密钥只读环境变量、前端拿不到凭证 —— 安全约束完全满足；
- `@astrojs/cloudflare` 仍保留在 `package.json` 依赖中，供未来切换 SSR 使用。

**如需改为适配器模式（用 Astro 端点替代 functions/）**：

1. 把 `functions/api/getPhotos.js` 的逻辑迁移到 `src/pages/api/getPhotos.ts`，
   环境变量改用 `Astro.locals.runtime.env` 读取；
2. 删除 `functions/` 目录（避免与 `_worker.js` 冲突）；
3. 在 `astro.config.mjs` 取消适配器注释：`import cloudflare from '@astrojs/cloudflare'`，
   并设置 `output: 'hybrid'`、`adapter: cloudflare({ mode: 'directory' })`。

## 十一、限制说明

- 仅做展示，不提供访客图片上传。
- 飞书 `batch_get_tmp_download_url` 返回的临时链接有时效；本代理每次调用都会刷新，
  轮询期间会拿到最新链接，浏览器侧加载不受影响。
- 若多维表格开启了**高级权限**，下载临时链接可能需要 `extra` 参数。请按飞书文档在高级权限中
  赋予应用读取权限，否则附件无法访问。

## 许可证

MIT

<br />

## 附：本地测试占位数据

`src/scripts/main.ts` 中可开启测试数据模式（不连飞书时使用 picsum.photos 占位图）：

```typescript
const USE_TEST_DATA = false; // 改为 true 即用本地占位数据
```

或设置环境变量 `MOCK_PHOTOS=1` 启用 mock 占位图。
