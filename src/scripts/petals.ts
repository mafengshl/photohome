// 樱花飘落特效：纯 CSS transform + opacity 动画，GPU 加速
// 桌面 90 片 / 平板 55 片 / 移动 35 片，低性能减半
// 后台标签页自动暂停，切回恢复；断点变化时重建

const PETAL_COLORS = [
  'rgba(255,183,213,0.85)',
  'rgba(255,174,201,0.82)',
  'rgba(255,201,221,0.88)',
  'rgba(255,159,192,0.80)',
  'rgba(255,210,225,0.85)',
];

const PETAL_SVG =
  '<svg viewBox="0 0 20 24" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M10 2C17 5 18 15 12 22L10 20L8 22C2 15 3 5 10 2Z" ' +
  'fill="PETAL_COLOR" stroke="rgba(255,100,140,0.18)" stroke-width="0.5"/></svg>';

type Breakpoint = 'desktop' | 'tablet' | 'mobile';

function getBreakpoint(): Breakpoint {
  const w = window.innerWidth;
  if (w >= 1024) return 'desktop';
  if (w >= 768) return 'tablet';
  return 'mobile';
}

function isLowPerf(): boolean {
  const cores = (navigator as unknown as { hardwareConcurrency?: number })
    .hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number })
    .deviceMemory ?? 4;
  return cores <= 2 || mem <= 2;
}

/** 各断点花瓣参数 */
const PETAL_PARAMS: Record<Breakpoint, { count: number; sizeMin: number; sizeMax: number; fallMin: number; fallMax: number }> = {
  desktop: { count: 90,  sizeMin: 12, sizeMax: 24, fallMin: 10, fallMax: 22 },
  tablet:  { count: 55,  sizeMin: 14, sizeMax: 26, fallMin: 12, fallMax: 24 },
  mobile:  { count: 35,  sizeMin: 16, sizeMax: 30, fallMin: 14, fallMax: 28 },
};

function buildPetals(container: HTMLElement): void {
  const bp = getBreakpoint();
  let params = PETAL_PARAMS[bp];
  if (isLowPerf()) {
    params = { ...params, count: Math.floor(params.count / 2) };
  }

  const frag = document.createDocumentFragment();

  for (let i = 0; i < params.count; i++) {
    const petal = document.createElement('div');
    petal.className = 'petal';

    const size = params.sizeMin + Math.random() * (params.sizeMax - params.sizeMin);
    const x = Math.random() * 100;
    const fallDur = params.fallMin + Math.random() * (params.fallMax - params.fallMin);
    const swayDur = 3 + Math.random() * 5;
    const swayAmp = 15 + Math.random() * 45;
    const spinDur = 5 + Math.random() * 10;
    const delay = -Math.random() * fallDur;
    const color = PETAL_COLORS[(Math.random() * PETAL_COLORS.length) | 0];
    const opacity = 0.55 + Math.random() * 0.35;

    petal.style.setProperty('--x', `${x}vw`);
    petal.style.setProperty('--size', `${size}px`);
    petal.style.setProperty('--fall-dur', `${fallDur}s`);
    petal.style.setProperty('--delay', `${delay}s`);
    petal.style.setProperty('--petal-opacity', String(opacity));

    const sway = document.createElement('div');
    sway.className = 'petal__sway';
    sway.style.setProperty('--sway-dur', `${swayDur}s`);
    sway.style.setProperty('--sway-amp', `${swayAmp}px`);

    const svgWrap = document.createElement('div');
    svgWrap.className = 'petal__svg';
    svgWrap.style.setProperty('--spin-dur', `${spinDur}s`);
    svgWrap.innerHTML = PETAL_SVG.replace('PETAL_COLOR', color);

    sway.appendChild(svgWrap);
    petal.appendChild(sway);
    frag.appendChild(petal);
  }

  container.appendChild(frag);
}

export function generatePetals(): void {
  const container = document.getElementById('petals');
  if (!container) return;

  buildPetals(container);

  // 后台暂停
  document.addEventListener('visibilitychange', () => {
    container.classList.toggle('petals--paused', document.hidden);
  });

  // 断点变化时重建（防抖）
  let lastBp = getBreakpoint();
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nextBp = getBreakpoint();
      if (nextBp !== lastBp) {
        lastBp = nextBp;
        container.innerHTML = '';
        buildPetals(container);
      }
    }, 300);
  });
}
