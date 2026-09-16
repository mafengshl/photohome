// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// ===========================================================================
// Astro 配置
// ===========================================================================
// 部署形态：静态站点 (output: 'static') + Cloudflare Pages Functions (functions/)
//
// 为什么不在 integrations 里启用 @astrojs/cloudflare 适配器？
//  - 适配器要求 output: 'server' | 'hybrid'，会在 dist/ 下生成 _worker.js（高级模式）。
//  - Cloudflare Pages 不允许 _worker.js 与 functions/ 目录同时存在（部署期冲突）。
//  - 本项目把 /api/getPhotos 作为 functions/api/getPhotos.js（Pages Function）承载，
//    这正是需求里指定的安全代理层形态；静态站点 + functions/ 是 Cloudflare 官方推荐组合。
//
// @astrojs/cloudflare 仍作为依赖保留在 package.json 中：
//  - 如后续要把更多页面改为 SSR，可按下方“切换到 SSR 模式”步骤启用适配器。
//
// 切换到 SSR 模式（如需 Astro 端点替代 functions/）：
//   1. 把 functions/api/getPhotos.js 迁移到 src/pages/api/getPhotos.ts，
//      用 Astro.locals.runtime.env 读取环境变量；
//   2. 删除 functions/ 目录（避免与 _worker.js 冲突）；
//   3. 在本文件中：import cloudflare from '@astrojs/cloudflare';
//      并设置 output: 'hybrid', adapter: cloudflare({ mode: 'directory' })。
// ===========================================================================
export default defineConfig({
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    // 静态产物输出到 dist/，便于 wrangler pages 部署
    assets: 'assets',
  },
});
