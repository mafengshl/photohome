// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import fs from 'node:fs';
import path from 'node:path';

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
//  - 如后续要把更多页面改为 SSR，可按下方"切换到 SSR 模式"步骤启用适配器。
//
// 切换到 SSR 模式（如需 Astro 端点替代 functions/）：
//   1. 把 functions/api/getPhotos.js 迁移到 src/pages/api/getPhotos.ts，
//      用 Astro.locals.runtime.env 读取环境变量；
//   2. 删除 functions/ 目录（避免与 _worker.js 冲突）；
//   3. 在本文件中：import cloudflare from '@astrojs/cloudflare';
//      并设置 output: 'hybrid', adapter: cloudflare({ mode: 'directory' })。
// ===========================================================================

// 本地音乐自动清单生成器
// dev/build 启动时扫描 public/audio/ 目录下所有音频文件,
// 输出 public/audio/manifest.json 供前端 fetch 加载歌单。
// 用户只要往 public/audio/ 放 MP3 文件,重启 dev 即自动识别歌名,无需改代码。
function audioManifestPlugin() {
  return {
    name: 'audio-manifest-generator',
    // dev 模式:服务器启动时扫描一次
    configureServer() {
      generateAudioManifest();
    },
    // dev 和 build 都触发,确保 manifest 始终最新
    buildStart() {
      generateAudioManifest();
    },
  };
}

function generateAudioManifest() {
  const audioDir = path.resolve('./public/audio');
  const manifestPath = path.join(audioDir, 'manifest.json');
  const songs = [];
  try {
    const files = fs.readdirSync(audioDir);
    for (const file of files) {
      if (file.startsWith('.') || file === 'manifest.json') continue;
      // 支持 mp3/wav/ogg/m4a/aac/flac 等常见音频格式
      if (/\.(mp3|wav|ogg|oga|m4a|aac|flac)$/i.test(file)) {
        songs.push({
          name: path.basename(file, path.extname(file)),
          src: `/audio/${encodeURIComponent(file)}`,
        });
      }
    }
  } catch {
    // 文件夹不存在,跳过
  }
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(songs, null, 2));
  } catch {
    // 写入失败,静默
  }
}

export default defineConfig({
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    // 静态产物输出到 dist/，便于 wrangler pages 部署
    assets: 'assets',
  },
  vite: {
    plugins: [audioManifestPlugin()],
    build: {
      // Astro 生产模式默认已开启压缩与 Tree Shaking，显式声明确保跨版本一致
      minify: 'esbuild',
      cssCodeSplit: true,
      sourcemap: false,
      target: 'es2020',
      // 手动分包:three.js + TWEEN 独立 chunk,提升首屏并行加载与缓存复用
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['three'],
            tween: ['@tweenjs/tween.js'],
          },
        },
      },
    },
  },
});
