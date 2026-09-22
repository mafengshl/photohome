// 全屏灯箱（目标站没有的增量功能）：大图浏览 + 左右切换 + "n / total" 计数
// + ESC/方向键 + 触屏滑动 + 点击背景关闭。与飞入阅读模式并存。
// 动画采用共享元素过渡：被点击卡片 → 全屏灯箱，仅用 transform + opacity，
// 不触碰布局属性，避免重排与卡顿。
import type { Message } from './types';

export interface Lightbox {
  open: (messages: Message[], startId: string, originRect?: DOMRect) => void;
  close: () => void;
  isOpen: () => boolean;
  setMessages: (messages: Message[]) => void;
}

const SWIPE_THRESHOLD = 48;

/** 动画参数（参考 photos.inamomentweunite.com 的轻快收尾曲线） */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia('(max-width: 768px)').matches;
const flyDuration = (): number => (isMobileViewport() ? 280 : 320);
/** 背景遮罩淡入时长，与卡片放大并行 */
const MASK_DURATION = 200;
/** 控件淡入延迟（主放大动画进行到 150ms 时再淡入控件，避免争抢渲染资源） */
const CONTROL_DELAY = 150;
const CONTROL_DURATION = 150;
/** 关闭时控件淡出时长（短于打开，快速让位） */
const CONTROL_OUT_DURATION = 120;
/** 图片放大/拖拽释放后的过渡时长 */
const ZOOM_DURATION = 250;

/** 低性能设备降级：仅简单淡入淡出。优先尊重用户系统的"减少动效"偏好。 */
const PREFERS_REDUCED_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let lowPerfMode = PREFERS_REDUCED_MOTION;
/** 首次开灯箱时探测实际帧率，不足则后续动画降级为简单淡入 */
let fpsProbed = PREFERS_REDUCED_MOTION;

/** 一次性帧率探测：仅在首次开灯箱动画期间运行 320ms，平均 FPS < 30 切到降级模式 */
function probeFPS(): void {
  if (fpsProbed) return;
  fpsProbed = true;
  let frames = 0;
  const start = performance.now();
  const tick = (now: number): void => {
    frames++;
    if (now - start < 320) {
      requestAnimationFrame(tick);
      return;
    }
    const fps = (frames * 1000) / (now - start);
    if (fps < 30) lowPerfMode = true;
  };
  requestAnimationFrame(tick);
}

export function createLightbox(): Lightbox | null {
  const requiredIds = [
    'lightbox',
    'lightbox-img',
    'lightbox-count',
    'lightbox-prev',
    'lightbox-next',
    'lightbox-close',
  ];
  if (!requiredIds.every((id) => document.getElementById(id) !== null)) return null;

  const root = document.getElementById('lightbox') as HTMLElement;
  const imgEl = document.getElementById('lightbox-img') as HTMLImageElement;
  const captionEl = root.querySelector<HTMLElement>('.lightbox__caption');
  const authorEl = document.getElementById('lightbox-author');
  const dateEl = document.getElementById('lightbox-date');
  const counterEl = document.getElementById('lightbox-count') as HTMLElement;
  const prevBtn = document.getElementById('lightbox-prev') as HTMLButtonElement;
  const nextBtn = document.getElementById('lightbox-next') as HTMLButtonElement;
  const closeBtn = document.getElementById('lightbox-close') as HTMLButtonElement;

  /** 控件集合：图片之外的按钮/计数/标题，统一管理淡入淡出 */
  const controlEls: HTMLElement[] = [
    closeBtn,
    prevBtn,
    nextBtn,
    counterEl,
    captionEl,
  ].filter((el): el is HTMLElement => el instanceof HTMLElement);

  // 全局照片顺序：与圆柱布局一致（时间倒序），仅含图片卡
  let photos: Message[] = [];
  let index = 0;
  let openState = false;
  let touchStartX: number | null = null;

  // ---------- 图片放大(zoom)状态 ----------
  /** 是否处于放大态 */
  let zoomed = false;
  /** 放大倍数 */
  const ZOOM_SCALE = 2.5;
  /** 当前放大偏移(translate,px) */
  let zoomX = 0;
  let zoomY = 0;
  /** 拖拽起始坐标 */
  let dragStartX = 0;
  let dragStartY = 0;
  /** 拖拽起始偏移 */
  let dragStartZoomX = 0;
  let dragStartZoomY = 0;
  /** 关闭动画的 originRect 缓存 */
  let lastOriginRect: DOMRect | null = null;
  /** 进行中的动画计时器（用于快速切换时取消） */
  let animationTimer: number | null = null;
  let controlTimer: number | null = null;

  // ---------- 动画辅助 ----------
  /** 取消进行中的动画并清理临时计时器 */
  function cancelAnimation(): void {
    if (animationTimer !== null) {
      window.clearTimeout(animationTimer);
      animationTimer = null;
    }
    if (controlTimer !== null) {
      window.clearTimeout(controlTimer);
      controlTimer = null;
    }
  }

  /** 清除图片上的所有 inline 动画样式，回到 CSS 默认 */
  function clearImageStyles(): void {
    if (!imgEl) return;
    imgEl.style.transition = '';
    imgEl.style.transform = '';
    imgEl.style.opacity = '';
    imgEl.style.willChange = '';
  }

  /** 清除控件上的所有 inline 动画样式 */
  function clearControlStyles(): void {
    controlEls.forEach((el) => {
      el.style.transition = '';
      el.style.opacity = '';
    });
  }

  /** 控件淡入/淡出统一入口 */
  function fadeControls(targetOpacity: number, duration: number, delay = 0): void {
    controlEls.forEach((el) => {
      el.style.transition = `opacity ${duration}ms ease ${delay}ms`;
      el.style.opacity = String(targetOpacity);
    });
  }

  /**
   * 计算从 originRect 到 imgEl 当前（无 transform）位置的 fly transform。
   * 仅返回 translate + scale（GPU 友好，不触发 reflow）。
   * imgEl 已渲染到全屏目标位置后调用。
   */
  function computeFlyTransform(originRect: DOMRect): string {
    if (!imgEl) return '';
    // 临时移除 transform 测量目标位置（避免被正在进行的 transform 影响）
    const prevTransform = imgEl.style.transform;
    const prevTransition = imgEl.style.transition;
    imgEl.style.transition = 'none';
    imgEl.style.transform = 'none';
    const targetRect = imgEl.getBoundingClientRect();
    imgEl.style.transform = prevTransform;
    imgEl.style.transition = prevTransition;
    if (!targetRect.width || !targetRect.height) return '';

    // 取较小 scale 保持图片比例（img 用 object-fit:contain，自身 box = 图片可见区）
    const scaleX = originRect.width / targetRect.width;
    const scaleY = originRect.height / targetRect.height;
    const scale = Math.min(scaleX, scaleY) || 0.3;

    // origin 中心 → target 中心的偏移（transform-origin: center center 已设置）
    const originCenterX = originRect.left + originRect.width / 2;
    const originCenterY = originRect.top + originRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;
    const dx = originCenterX - targetCenterX;
    const dy = originCenterY - targetCenterY;

    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  /** 应用 zoom transform 到图片 */
  function applyZoomTransform(): void {
    if (!imgEl) return;
    if (zoomed) {
      imgEl.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${ZOOM_SCALE})`;
      imgEl.style.cursor = 'grab';
    } else {
      imgEl.style.transform = '';
      imgEl.style.cursor = '';
    }
  }

  /** 以指定点为中心放大/缩小 */
  function toggleZoomAt(centerX: number, centerY: number): void {
    if (!imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    if (!zoomed) {
      // 放大:计算点击点相对图片中心的偏移,放大后需反向平移保持点击点居中
      const imgCenterX = rect.left + rect.width / 2;
      const imgCenterY = rect.top + rect.height / 2;
      const dx = centerX - imgCenterX;
      const dy = centerY - imgCenterY;
      // 放大后平移量:让点击点在放大后仍对齐原点击位置
      zoomX = -dx * (ZOOM_SCALE - 1);
      zoomY = -dy * (ZOOM_SCALE - 1);
      zoomed = true;
    } else {
      // 缩小:重置
      zoomX = 0;
      zoomY = 0;
      zoomed = false;
    }
    imgEl.style.willChange = 'transform';
    imgEl.style.transition = `transform ${ZOOM_DURATION}ms ease-in-out`;
    applyZoomTransform();
    // 动画结束后清理 will-change
    window.setTimeout(() => {
      if (imgEl) imgEl.style.willChange = '';
    }, ZOOM_DURATION + 20);
  }

  /** 重置 zoom 状态(切换图片/关闭时调用) */
  function resetZoom(): void {
    zoomed = false;
    zoomX = 0;
    zoomY = 0;
    if (imgEl) {
      imgEl.style.transition = '';
      imgEl.style.transform = '';
      imgEl.style.cursor = '';
      imgEl.style.willChange = '';
    }
  }

  const photoOrder = (messages: Message[]): Message[] =>
    [...messages]
      .filter((m) => m.hasImage && m.imageUrl)
      .sort(
        (a, b) =>
          new Date(b.timestamp || b.date || 0).getTime() -
          new Date(a.timestamp || a.date || 0).getTime(),
      );

  function render(animateDirection: 0 | 1 | -1 = 0) {
    const msg = photos[index];
    if (!msg) return;

    // 切换图片时重置放大状态
    resetZoom();

    imgEl.src = msg.imageUrl || '';
    imgEl.alt = `${msg.author || 'Anonymous'} photo`;
    if (authorEl) authorEl.textContent = msg.author || 'Anonymous';
    if (dateEl) dateEl.textContent = msg.date || '';
    counterEl.textContent = `${index + 1} / ${photos.length}`;

    prevBtn.disabled = photos.length <= 1;
    nextBtn.disabled = photos.length <= 1;

    if (animateDirection !== 0) {
      imgEl.classList.remove('lightbox__img--enter-l', 'lightbox__img--enter-r');
      void imgEl.offsetWidth; // 重置动画
      imgEl.classList.add(
        animateDirection === 1 ? 'lightbox__img--enter-r' : 'lightbox__img--enter-l',
      );
    }
  }

  function go(delta: number) {
    if (photos.length <= 1) return;
    index = (index + delta + photos.length) % photos.length;
    // delta 1 = 下一张（内容从右侧进入），-1 = 上一张（从左侧进入）
    render(delta === 1 ? 1 : -1);
  }

  function open(messages: Message[], startId: string, originRect?: DOMRect) {
    photos = photoOrder(messages);
    if (photos.length === 0) return;

    const found = photos.findIndex((m) => m.id === startId);
    index = found >= 0 ? found : 0;

    // 快速连续点击：取消任何进行中的动画并清理 inline 样式，确保干净的起点
    cancelAnimation();
    clearImageStyles();
    clearControlStyles();

    openState = true;
    document.body.classList.add('lightbox-open');
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');

    // 控件初始隐藏，主放大动画进行 150ms 后再淡入
    controlEls.forEach((el) => {
      el.style.opacity = '0';
    });

    render(0);

    const flyMs = flyDuration();
    // 共享元素 fly：先用缓存缩略图作为起始帧，立刻开动画；不等待图片加载
    const flyTransform = originRect ? computeFlyTransform(originRect) : '';

    if (imgEl && flyTransform && !lowPerfMode) {
      lastOriginRect = originRect as DOMRect;
      // 1. 提升合成层优先级 + 禁用 transition，设置初始 transform（缩到卡片位置）
      imgEl.style.willChange = 'transform, opacity';
      imgEl.style.transition = 'none';
      imgEl.style.transform = flyTransform;
      // 图片始终可见，无闪烁（与原卡片缩略图共享视觉）
      imgEl.style.opacity = '1';
      // 2. 强制 reflow 确保初始状态生效
      void imgEl.offsetWidth;
      // 3. 下一帧启用 transition，过渡到全屏位置（transform: none）
      requestAnimationFrame(() => {
        if (!imgEl || !openState) return;
        imgEl.style.transition = `transform ${flyMs}ms ${EASE}, opacity ${flyMs}ms ${EASE}`;
        imgEl.style.transform = 'none';
        // 4. 动画结束后清理 will-change 与 inline transition，避免残留性能开销
        //    以及干扰后续 render() 的 keyframe slide 动画
        animationTimer = window.setTimeout(() => {
          if (imgEl) {
            imgEl.style.willChange = '';
            imgEl.style.transition = '';
            imgEl.style.transform = '';
          }
          animationTimer = null;
        }, flyMs + 20);
      });
      // 首次开灯箱时探测帧率，不足则后续降级为简单淡入
      probeFPS();
    } else if (imgEl) {
      // 无 originRect / 无法测得目标尺寸 / 低端设备：简单淡入
      imgEl.style.willChange = 'opacity';
      imgEl.style.opacity = '0';
      void imgEl.offsetWidth;
      requestAnimationFrame(() => {
        if (!imgEl || !openState) return;
        imgEl.style.transition = `opacity ${flyMs}ms ease-out`;
        imgEl.style.opacity = '1';
        animationTimer = window.setTimeout(() => {
          if (imgEl) {
            imgEl.style.willChange = '';
            imgEl.style.transition = '';
            imgEl.style.transform = '';
          }
          animationTimer = null;
        }, flyMs + 20);
      });
    }

    // 背景遮罩：通过 #lightbox.is-open 的 CSS transition 处理（opacity 0→1），
    // 这里覆盖时长到 MASK_DURATION，与主放大并行，互不阻塞
    root.style.transition = `opacity ${MASK_DURATION}ms ease, visibility 0s`;

    // 控件延迟淡入：主放大动画进行 150ms 后再淡入，避免争抢渲染资源
    controlTimer = window.setTimeout(() => {
      fadeControls(1, CONTROL_DURATION);
      // 淡入完成后清除 inline transition/opacity，恢复 CSS hover 等过渡
      controlTimer = window.setTimeout(() => {
        controlEls.forEach((el) => {
          el.style.transition = '';
          el.style.opacity = '';
        });
        controlTimer = null;
      }, CONTROL_DURATION + 20);
    }, CONTROL_DELAY);

    try {
      closeBtn.focus({ preventScroll: true });
    } catch {
      closeBtn.focus();
    }
  }

  function close() {
    if (!openState) return;
    openState = false;
    document.body.classList.remove('lightbox-open');
    root.setAttribute('aria-hidden', 'true');

    cancelAnimation();

    const flyMs = flyDuration();

    // 控件先快速淡出，让位给主体缩小动画
    fadeControls(0, CONTROL_OUT_DURATION);

    if (imgEl && lastOriginRect && !lowPerfMode) {
      // 逆向缩小：从全屏位置回到原卡片精确位置与尺寸
      imgEl.style.willChange = 'transform, opacity';
      imgEl.style.transition = `transform ${flyMs}ms ${EASE}, opacity ${flyMs}ms ${EASE}`;
      imgEl.style.transform = computeFlyTransform(lastOriginRect);
      // 图片保持可见直到到位（无提前淡出，避免视觉断点）

      // 背景遮罩同步淡出（与卡片缩小同步、同时长，到位即消失）
      root.style.transition = `opacity ${flyMs}ms ${EASE}, visibility 0s linear ${flyMs}ms`;
      root.classList.remove('is-open');

      animationTimer = window.setTimeout(() => {
        if (!imgEl) return;
        imgEl.style.transition = '';
        imgEl.style.transform = '';
        imgEl.style.opacity = '';
        imgEl.style.willChange = '';
        imgEl.removeAttribute('src');
        root.style.transition = '';
        clearControlStyles();
        lastOriginRect = null;
        animationTimer = null;
      }, flyMs + 20);
    } else {
      // 简单淡出
      root.style.transition = `opacity ${flyMs}ms ease, visibility 0s linear ${flyMs}ms`;
      root.classList.remove('is-open');
      animationTimer = window.setTimeout(() => {
        if (imgEl) {
          imgEl.style.transition = '';
          imgEl.style.transform = '';
          imgEl.style.opacity = '';
          imgEl.style.willChange = '';
          imgEl.removeAttribute('src');
        }
        root.style.transition = '';
        clearControlStyles();
        lastOriginRect = null;
        animationTimer = null;
      }, flyMs + 20);
    }

    resetZoom();
  }

  function isOpen() {
    return openState;
  }

  function setMessages(messages: Message[]) {
    const wasId = openState ? photos[index]?.id : null;
    photos = photoOrder(messages);
    if (openState) {
      const found = photos.findIndex((m) => m.id === wasId);
      index = found >= 0 ? found : 0;
      render(0);
    }
  }

  // ---- 事件绑定 ----
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(-1);
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(1);
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });

  // 点击图片以外的遮罩区域关闭；点击图片/控件不关闭
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  // ---------- 图片放大交互 ----------
  // 单击切换放大,双击也触发(双击的第一次 click 会放大,第二次会缩小)
  let lastClickTime = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  const DOUBLE_CLICK_THRESHOLD = 280; // ms

  imgEl.addEventListener('click', (e) => {
    e.stopPropagation();
    // 关闭时点击不响应
    if (!openState) return;
    const now = Date.now();
    const dx = Math.abs(e.clientX - lastClickX);
    const dy = Math.abs(e.clientY - lastClickY);
    // 双击:间隔短 + 位置近 → 切换放大
    if (now - lastClickTime < DOUBLE_CLICK_THRESHOLD && dx < 10 && dy < 10) {
      toggleZoomAt(e.clientX, e.clientY);
      lastClickTime = 0; // 防三击误判
    } else {
      lastClickTime = now;
      lastClickX = e.clientX;
      lastClickY = e.clientY;
      // 单击延迟检测:如果 280ms 内无第二次点击,判定为单击
      // 单击在放大态下切换回缩小,非放大态下不响应(避免与双击冲突)
      window.setTimeout(() => {
        if (lastClickTime === now && zoomed) {
          // 仍是单击 + 放大态 → 缩小
          toggleZoomAt(e.clientX, e.clientY);
        }
      }, DOUBLE_CLICK_THRESHOLD);
    }
  });

  // 放大态拖拽查看细节
  imgEl.addEventListener('pointerdown', (e) => {
    if (!zoomed || !openState) return;
    e.preventDefault();
    e.stopPropagation();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartZoomX = zoomX;
    dragStartZoomY = zoomY;
    imgEl.style.cursor = 'grabbing';
    imgEl.style.transition = 'none'; // 拖拽时禁用过渡,跟手
    try {
      imgEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (ev: PointerEvent): void => {
      zoomX = dragStartZoomX + (ev.clientX - dragStartX);
      zoomY = dragStartZoomY + (ev.clientY - dragStartY);
      applyZoomTransform();
    };
    const onUp = (ev: PointerEvent): void => {
      imgEl.style.cursor = 'grab';
      imgEl.style.transition = `transform ${ZOOM_DURATION}ms ease-in-out`;
      try {
        imgEl.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      imgEl.removeEventListener('pointermove', onMove);
      imgEl.removeEventListener('pointerup', onUp);
      imgEl.removeEventListener('pointercancel', onUp);
    };
    imgEl.addEventListener('pointermove', onMove);
    imgEl.addEventListener('pointerup', onUp);
    imgEl.addEventListener('pointercancel', onUp);
  });

  // 移动端双击放大(touchend 模拟)
  let lastTouchTime = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;
  imgEl.addEventListener(
    'touchend',
    (e) => {
      if (!openState || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const now = Date.now();
      const dx = Math.abs(t.clientX - lastTouchX);
      const dy = Math.abs(t.clientY - lastTouchY);
      if (now - lastTouchTime < DOUBLE_CLICK_THRESHOLD && dx < 30 && dy < 30) {
        e.preventDefault();
        toggleZoomAt(t.clientX, t.clientY);
        lastTouchTime = 0;
      } else {
        lastTouchTime = now;
        lastTouchX = t.clientX;
        lastTouchY = t.clientY;
      }
    },
    { passive: false },
  );

  document.addEventListener('keydown', (e) => {
    if (!openState) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
  });

  // 触屏滑动切换
  root.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    },
    { passive: true },
  );
  root.addEventListener(
    'touchend',
    (e) => {
      if (touchStartX === null || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > SWIPE_THRESHOLD) {
        go(dx < 0 ? 1 : -1);
      }
    },
    { passive: true },
  );

  return { open, close, isOpen, setMessages };
}
