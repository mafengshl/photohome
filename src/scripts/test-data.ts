// 内置测试图片集：35 张占位图，字段结构与 /api/getPhotos 返回完全一致
// 用于调试翻页、分页边界、不满一页等场景
// 切换方式：在 main.ts 中设置 USE_TEST_DATA = true

import type { Photo } from './types';

// 混合比例：portrait/landscape/square 交替，验证 mini/wide/square 三种卡片格式
const SPECS = [
  { w: 1200, h: 1600 }, // portrait → mini
  { w: 1600, h: 900 },  // landscape → wide
  { w: 1200, h: 1200 }, // square
  { w: 800, h: 1200 },  // portrait → mini
  { w: 1920, h: 1080 }, // landscape → wide
  { w: 1000, h: 1000 }, // square
  { w: 1080, h: 1620 }, // portrait → mini
  { w: 1440, h: 960 },  // landscape → wide
  { w: 900, h: 900 },   // square
  { w: 600, h: 900 },   // portrait → mini
  { w: 1280, h: 720 },  // landscape → wide
  { w: 750, h: 750 },   // square
  { w: 1400, h: 1867 }, // portrait → mini
  { w: 2000, h: 1125 }, // landscape → wide
  { w: 500, h: 500 },   // square
  { w: 900, h: 1350 },  // portrait → mini
  { w: 1600, h: 1067 }, // landscape → wide
  { w: 800, h: 800 },   // square
  { w: 1100, h: 1650 }, // portrait → mini
  { w: 1920, h: 1280 }, // landscape → wide
  { w: 1200, h: 1200 }, // square
  { w: 700, h: 1050 },  // portrait → mini
  { w: 1440, h: 1080 }, // landscape → wide
  { w: 960, h: 960 },   // square
  { w: 1300, h: 1733 }, // portrait → mini
  { w: 1680, h: 1050 }, // landscape → wide
  { w: 600, h: 600 },   // square
  { w: 1000, h: 1500 }, // portrait → mini
  { w: 1280, h: 853 },  // landscape → wide
  { w: 450, h: 450 },   // square
  { w: 1080, h: 1440 }, // portrait → mini
  { w: 1600, h: 900 },  // landscape → wide
  { w: 840, h: 840 },   // square
  { w: 900, h: 1200 },  // portrait → mini
  { w: 1920, h: 1080 }, // landscape → wide
];

export function getTestPhotos(): Photo[] {
  const now = Date.parse('2026-09-11T12:00:00');
  return SPECS.map((s, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      id: `test-${num}`,
      title: `Test ${num}`,
      desc: `测试图片 ${num} 的描述`,
      photoTime: now - i * 86_400_000, // 每张间隔 1 天，倒序
      sortOrder: i + 1, // 1~35，越小越靠前
      url: `https://picsum.photos/seed/test-${num}/${s.w}/${s.h}`,
      width: s.w,
      height: s.h,
      type: 'image/jpeg',
    } satisfies Photo;
  });
}

/** 仅返回前 N 张，用于调试不满一页边界场景 */
export function getTestPhotosLimited(n: number): Photo[] {
  return getTestPhotos().slice(0, n);
}
