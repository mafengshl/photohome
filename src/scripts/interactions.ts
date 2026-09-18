// 交互逻辑：TWEEN.js 飞行动画 + 卡片聚焦（阅读模式）+ 图片翻转 + 翻页回正
// 1:1 移植自目标站 /js/interactions.js
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { TWEEN, createTween } from './tween';
import {
  unlockOrbitLimits,
  restoreOrbitLimits,
  getCurrentPage,
  getTotalPages,
  enableZoomSlider,
  type RenderPageFn,
} from './universe';

const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

let isReading = false;
let savedCameraPos: THREE.Vector3 | null = null;
let savedZoom = 1.0;
let activeCardEl: HTMLElement | null = null;
let flipHintEl: HTMLElement | null = null;
let exitButtonEl: HTMLButtonElement | null = null;
let magnifyBtn: HTMLButtonElement | null = null;
let hintLayoutTimer: ReturnType<typeof setTimeout> | null = null;
let isReadingViewStable = false;
let pendingStableSignals = 0;
let stableDelayTimer: ReturnType<typeof setTimeout> | null = null;
let stableCheckRaf: number | null = null;
let pendingFlipRequest = false;

export function setupInteractions(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  arcContainer: HTMLElement | null,
  exitBtn: HTMLButtonElement,
  renderPage: RenderPageFn,
) {
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const pagiUI = document.getElementById('pagi-ui');
  const messageCounter = document.getElementById('message-counter');
  flipHintEl = document.getElementById('flip-hint');
  exitButtonEl = exitBtn;

  if (flipHintEl) {
    flipHintEl.addEventListener('click', handleFlipHintClick);
    flipHintEl.addEventListener('keydown', handleFlipHintKeydown);
    flipHintEl.setAttribute('role', 'button');
    flipHintEl.setAttribute('tabindex', '0');
    flipHintEl.setAttribute('aria-label', 'Flip card');
  }

  const goPrevPage = () => {
    const page = getCurrentPage();
    if (page > 1) {
      renderPage(page - 1, null, 1);
      resetView();
    }
  };

  const goNextPage = () => {
    const page = getCurrentPage();
    if (page < getTotalPages()) {
      renderPage(page + 1, null, -1);
      resetView();
    }
  };

  prevBtn?.addEventListener('click', goPrevPage);

  nextBtn?.addEventListener('click', goNextPage);

  // 键盘方向键翻页（仅非阅读模式；灯箱打开时让位给灯箱方向键）
  document.addEventListener('keydown', (event) => {
    if (isReading) return;
    if (document.body.classList.contains('lightbox-open')) return;
    if (event.code === 'ArrowLeft') goPrevPage();
    if (event.code === 'ArrowRight') goNextPage();
  });

  function resetView() {
    if (isReading) return;

    // 视角平滑回正到圆心 (0,0,100)
    createTween(camera.position)
      .to({ x: 0, y: 0, z: 100 }, 1100)
      .easing(TWEEN.Easing.Cubic.InOut)
      .start();

    createTween(controls.target)
      .to({ x: 0, y: 0, z: 0 }, 1100)
      .easing(TWEEN.Easing.Cubic.InOut)
      .onUpdate(() => controls.update())
      .start();
  }

  window.addEventListener('card-click', ((e: Event) => {
    const detail = (e as CustomEvent).detail as { object: CSS3DObject; element: HTMLElement };
    if (isReading) {
      // 阅读模式下:只有点击当前聚焦的图片卡才触发翻转。
      // CSS3DRenderer 卡片的 DOM click 不会冒泡到 activeCardel(矩阵变换导致 hit-test 区域
      // 不匹配视觉投影),所以走 raycast 路径——pickCardAt 命中后在这里判定。
      if (
        activeCardEl &&
        detail.element === activeCardEl &&
        activeCardEl.classList.contains('msg-card--image')
      ) {
        if (!isReadingViewStable) {
          pendingFlipRequest = true;
          return;
        }
        toggleCardFlip(activeCardEl);
      }
      return;
    }
    // 移动端点击缩放反馈（CSS @media(hover:none) 下生效）
    detail.element.classList.add('tapped');
    setTimeout(() => detail.element.classList.remove('tapped'), 200);
    flyToCard(detail.object, detail.element);
  }) as EventListener);

  document.addEventListener('keydown', handleFlipKeydown);
  window.addEventListener('resize', () => {
    refreshFlipHintPosition();
    // 视口/横竖屏变化时,卡片可用高度变化,重新检测背面是否需要滑动
    if (activeCardEl) updateBackfaceScrollState(activeCardEl);
  });
  window.addEventListener('orientationchange', () => {
    refreshFlipHintPosition();
    if (activeCardEl) updateBackfaceScrollState(activeCardEl);
  });

  exitBtn.addEventListener('click', () => {
    returnToOrigin();
  });

  magnifyBtn = document.getElementById('magnify-btn') as HTMLButtonElement | null;
  magnifyBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isReading || !activeCardEl) return;
    const messageId = activeCardEl.dataset.messageId;
    if (!messageId) return;
    window.dispatchEvent(
      new CustomEvent('open-lightbox', {
        detail: { messageId },
      }),
    );
  });

  function flyToCard(cardObj: CSS3DObject, el: HTMLElement) {
    isReading = true;
    isReadingViewStable = false;
    pendingStableSignals = 0;
    pendingFlipRequest = false;
    unlockOrbitLimits();
    controls.enabled = false;

    if (window.zoomControl) {
      savedZoom = window.zoomControl.getZoom();
      window.zoomControl.setZoom(1.0);
    }

    enableZoomSlider(false);
    document.body.classList.add('reading-mode');

    if (activeCardEl && activeCardEl !== el) {
      detachFlipHandlers(activeCardEl);
      activeCardEl.classList.remove('focused');
      resetCardFlip(activeCardEl);
    }
    activeCardEl = el;
    activeCardEl.classList.add('focused');
    attachFlipHandlers(activeCardEl);
    primeFlipCard(activeCardEl);

    // 图片卡才显示"全屏放大"按钮
    if (magnifyBtn) {
      magnifyBtn.classList.toggle(
        'is-available',
        activeCardEl.classList.contains('msg-card--image'),
      );
    }

    if (pagiUI) pagiUI.style.opacity = '0';
    if (messageCounter) messageCounter.style.opacity = '0';
    if (arcContainer) arcContainer.classList.add('hidden');

    savedCameraPos = camera.position.clone();

    const cardPos = cardObj.position.clone();
    // 沿圆心→卡片的水平连线靠近 450 单位，保证上下行卡片也正对视角（零倾斜）
    const horizontalDir = cardPos.clone();
    horizontalDir.y = 0;
    horizontalDir.normalize();
    const targetPos = cardPos.clone().sub(horizontalDir.multiplyScalar(450));

    const tweenDuration = isMobileDevice ? 900 : 1200;
    const hintDelay = 120;

    createTween(camera.position)
      .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, tweenDuration)
      .easing(TWEEN.Easing.Cubic.InOut)
      .onComplete(() => markReadingViewStable(hintDelay))
      .start();

    createTween(controls.target)
      .to({ x: cardPos.x, y: cardPos.y, z: cardPos.z }, tweenDuration)
      .easing(TWEEN.Easing.Cubic.InOut)
      .onComplete(() => markReadingViewStable(hintDelay))
      .start();

    setTimeout(() => {
      exitBtn.style.display = 'block';
      exitBtn.style.opacity = '1';
    }, isMobileDevice ? 420 : 550);
  }

  function returnToOrigin() {
    isReading = false;
    isReadingViewStable = false;
    pendingStableSignals = 0;
    pendingFlipRequest = false;
    cancelReadingStabilityCheck();
    exitBtn.style.opacity = '0';
    magnifyBtn?.classList.remove('is-available');
    setTimeout(() => {
      exitBtn.style.display = 'none';
    }, 500);

    enableZoomSlider(true);
    document.body.classList.remove('reading-mode');

    if (window.zoomControl && savedZoom) {
      window.zoomControl.setZoom(savedZoom);
    }

    if (activeCardEl) {
      detachFlipHandlers(activeCardEl);
      resetCardFlip(activeCardEl);
      activeCardEl.classList.remove('focused');
      activeCardEl = null;
    }

    const returnPos = savedCameraPos || { x: 0, y: 0, z: 100 };
    const tweenDuration = isMobileDevice ? 900 : 1200;

    createTween(camera.position)
      .to({ x: returnPos.x, y: returnPos.y, z: returnPos.z }, tweenDuration)
      .easing(TWEEN.Easing.Cubic.InOut)
      .start();

    createTween(controls.target)
      .to({ x: 0, y: 0, z: 0 }, tweenDuration)
      .easing(TWEEN.Easing.Cubic.InOut)
      .onComplete(() => {
        restoreOrbitLimits();
        controls.enabled = !isMobileDevice;
        controls.update();

        if (pagiUI) pagiUI.style.opacity = '1';
        if (messageCounter) messageCounter.style.opacity = '1';
      })
      .start();

    if (arcContainer) arcContainer.classList.remove('hidden');
  }
}

/** 仅在阅读模式下，点击聚焦的图片卡时触发翻转 */
function handleFlipClick(event: Event) {
  if (!isReading || !activeCardEl) return;
  const target = event.target as HTMLElement;
  if (target.closest('#exit-btn')) return;
  if (event.currentTarget !== activeCardEl) return;

  event.preventDefault();
  event.stopPropagation();

  if (!isReadingViewStable) {
    pendingFlipRequest = true;
    return;
  }

  toggleCardFlip(activeCardEl);
}

/** 空格键或回车键翻转（灯箱打开时由灯箱接管键盘） */
function handleFlipKeydown(event: KeyboardEvent) {
  if (!isReading || !activeCardEl) return;
  if (document.body.classList.contains('lightbox-open')) return;

  if (event.code === 'Space' || event.code === 'Enter') {
    if (activeCardEl.classList.contains('msg-card--image')) {
      if (!isReadingViewStable) {
        pendingFlipRequest = true;
        event.preventDefault();
        return;
      }
      toggleCardFlip(activeCardEl);
      event.preventDefault();
    }
  }
}

function toggleCardFlip(cardEl: HTMLElement) {
  const flipContainer = cardEl.querySelector<HTMLElement>('[data-flip-container]');
  if (!flipContainer) return;

  // 翻转前预热合成层，降低首次翻面时边框闪现概率
  flipContainer.getBoundingClientRect();
  void flipContainer.offsetWidth;

  // 红色光影减弱动画
  cardEl.classList.remove('flip-dim');
  void cardEl.offsetWidth;
  cardEl.classList.add('flip-dim');

  const isFlipped = flipContainer.classList.toggle('is-flipped');
  cardEl.classList.toggle('is-flipped', isFlipped);
  cardEl.setAttribute('aria-flipped', String(isFlipped));

  // 翻到背面:重置滚动到顶,并检测是否需要滑动查看(用于 CSS 渐隐遮罩)
  const backfaceContent = cardEl.querySelector<HTMLElement>('[data-card-backface-content]');
  if (backfaceContent) {
    backfaceContent.scrollTop = 0;
    updateBackfaceScrollState(cardEl);
  }

  syncFlipHint(isFlipped);

  window.dispatchEvent(
    new CustomEvent('card-flip', {
      detail: {
        cardEl,
        isFlipped,
        messageId: cardEl.dataset.messageId,
      },
    }),
  );
}

function resetCardFlip(cardEl: HTMLElement | null) {
  if (!cardEl) return;

  const flipContainer = cardEl.querySelector<HTMLElement>('[data-flip-container]');
  if (flipContainer) {
    flipContainer.classList.remove('is-flipped');
  }
  cardEl.classList.remove('is-flipped');
  cardEl.setAttribute('aria-flipped', 'false');
  syncFlipHint(false);
}

function attachFlipHandlers(cardEl: HTMLElement) {
  if (!cardEl.classList.contains('msg-card--image')) {
    syncFlipHint(false);
    return;
  }

  cardEl.addEventListener('click', handleFlipClick);
  cardEl.setAttribute('tabindex', '0');
  cardEl.setAttribute('role', 'button');
  try {
    cardEl.focus({ preventScroll: true });
  } catch {
    cardEl.focus();
  }
  syncFlipHint(false);
  scheduleFlipHintRefresh();
}

function detachFlipHandlers(cardEl: HTMLElement) {
  cardEl.removeEventListener('click', handleFlipClick);
  cardEl.removeAttribute('tabindex');
  cardEl.removeAttribute('role');
  if (typeof cardEl.blur === 'function') {
    cardEl.blur();
  }
  syncFlipHint(false);
}

function syncFlipHint(isFlipped: boolean) {
  if (!flipHintEl) return;

  // 翻转按钮翻转后仍然可见，让用户可以点回正面
  const shouldShow = Boolean(
    isReading &&
      isReadingViewStable &&
      activeCardEl &&
      activeCardEl.classList.contains('msg-card--image'),
  );

  flipHintEl.classList.toggle('is-flipped', isFlipped);

  if (shouldShow) {
    const positioned = refreshFlipHintPosition();
    if (positioned) {
      if (!flipHintEl.classList.contains('is-visible')) {
        requestAnimationFrame(() => {
          flipHintEl?.classList.add('is-visible');
        });
      }
    } else {
      flipHintEl.classList.remove('is-visible');
      scheduleFlipHintRefresh(60);
    }
  } else {
    flipHintEl.classList.remove('is-visible');
    flipHintEl.style.removeProperty('top');
    flipHintEl.style.removeProperty('left');
  }
}

function handleFlipHintClick(event: Event) {
  if (!isReading || !activeCardEl) return;
  if (!isReadingViewStable) return;
  if (!activeCardEl.classList.contains('msg-card--image')) return;

  toggleCardFlip(activeCardEl);
  event.preventDefault();
  event.stopPropagation();
}

function handleFlipHintKeydown(event: KeyboardEvent) {
  if (event.code !== 'Space' && event.code !== 'Enter') return;
  handleFlipHintClick(event);
}

function scheduleFlipHintRefresh(delay = 0) {
  if (hintLayoutTimer) {
    clearTimeout(hintLayoutTimer);
  }

  hintLayoutTimer = setTimeout(() => {
    hintLayoutTimer = null;
    refreshFlipHintPosition();
  }, delay);
}

function markReadingViewStable(delay = 0) {
  if (!isReading) return;

  pendingStableSignals += 1;
  if (pendingStableSignals < 2) return;

  cancelReadingStabilityCheck();
  if (stableDelayTimer) {
    clearTimeout(stableDelayTimer);
    stableDelayTimer = null;
  }

  stableDelayTimer = setTimeout(() => {
    stableDelayTimer = null;
    waitForReadingViewStable();
  }, delay);
}

function cancelReadingStabilityCheck() {
  if (stableDelayTimer) {
    clearTimeout(stableDelayTimer);
    stableDelayTimer = null;
  }
  if (stableCheckRaf) {
    cancelAnimationFrame(stableCheckRaf);
    stableCheckRaf = null;
  }
}

/** 等待卡片与退出按钮布局连续 4 帧位移 < 0.6px，再开放翻转 */
function waitForReadingViewStable() {
  if (!isReading || !activeCardEl) return;

  const maxFrames = 120;
  const requiredStableFrames = 4;
  const epsilon = 0.6;
  let frame = 0;
  let stableFrames = 0;
  let last: { card: DOMRect; exit: DOMRect } | null = null;

  const step = () => {
    stableCheckRaf = null;
    if (!isReading || !activeCardEl) return;

    const cardRect = activeCardEl.getBoundingClientRect();
    const exitRect = exitButtonEl ? exitButtonEl.getBoundingClientRect() : null;
    const exitReady = Boolean(exitRect && exitRect.width > 0 && exitRect.height > 0);
    const cardReady = Boolean(cardRect.width > 0 && cardRect.height > 0);

    if (!exitReady || !cardReady) {
      stableFrames = 0;
      last = null;
    } else if (last && exitRect) {
      const delta =
        Math.abs(cardRect.top - last.card.top) +
        Math.abs(cardRect.left - last.card.left) +
        Math.abs(cardRect.width - last.card.width) +
        Math.abs(cardRect.height - last.card.height) +
        Math.abs(exitRect.top - last.exit.top) +
        Math.abs(exitRect.left - last.exit.left) +
        Math.abs(exitRect.width - last.exit.width) +
        Math.abs(exitRect.height - last.exit.height);

      if (delta <= epsilon) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
    }

    last = exitReady && cardReady && exitRect ? { card: cardRect, exit: exitRect } : null;
    frame += 1;

    if (stableFrames >= requiredStableFrames || frame >= maxFrames) {
      if (!isReading || !activeCardEl) return;
      isReadingViewStable = true;
      primeFlipCard(activeCardEl);
      // 聚焦稳定后检测背面文字是否需要滑动查看(适配不同卡片尺寸/比例)
      updateBackfaceScrollState(activeCardEl);
      const isFlipped = activeCardEl.classList.contains('is-flipped');
      if (pendingFlipRequest && !isFlipped) {
        pendingFlipRequest = false;
        toggleCardFlip(activeCardEl);
      } else {
        syncFlipHint(isFlipped);
      }
      scheduleFlipHintRefresh();
      return;
    }

    stableCheckRaf = requestAnimationFrame(step);
  };

  stableCheckRaf = requestAnimationFrame(step);
}

function primeFlipCard(cardEl: HTMLElement) {
  if (!cardEl || !cardEl.classList.contains('msg-card--image')) return;

  const flipContainer = cardEl.querySelector<HTMLElement>('[data-flip-container]');
  const frontFace = cardEl.querySelector<HTMLElement>('.msg-card__front-face');
  const backFace = cardEl.querySelector<HTMLElement>('[data-card-backface]');

  cardEl.getBoundingClientRect();
  void cardEl.offsetWidth;

  flipContainer?.getBoundingClientRect();
  frontFace?.getBoundingClientRect();
  backFace?.getBoundingClientRect();
}

function refreshFlipHintPosition(): boolean {
  if (
    !flipHintEl ||
    !exitButtonEl ||
    !isReading ||
    !activeCardEl ||
    !activeCardEl.classList.contains('msg-card--image')
  ) {
    return false;
  }
  // 卡片自身不参与翻转(只有内部 .msg-card__flip-container 旋转),cardRect 翻转前后不变,
  // 这里不再因 is-flipped 返回 false,否则 syncFlipHint(true) 后会立即被 hide 导致按钮消失。

  const cardRect = activeCardEl.getBoundingClientRect();
  const exitRect = exitButtonEl.getBoundingClientRect();
  if (!cardRect.width || !cardRect.height || !exitRect.width || !exitRect.height) {
    return false;
  }

  const midpointY = cardRect.bottom + (exitRect.top - cardRect.bottom) / 2;
  const hintHeight = flipHintEl.offsetHeight || 28;
  const clampedTop = Math.min(
    window.innerHeight - hintHeight / 2 - 20,
    Math.max(hintHeight / 2 + 20, midpointY),
  );

  flipHintEl.style.left = '50%';
  flipHintEl.style.top = `${clampedTop - hintHeight / 2}px`;
  return true;
}

/**
 * 检测卡片背面文字是否超出容器高度,加 is-scrollable class
 * 用于触发 CSS 上下边缘渐隐遮罩(只在内容溢出时显示)。
 * 仅做 class 切换,实际滚动由 CSS overflow-y:auto + 浏览器原生处理。
 */
function updateBackfaceScrollState(cardEl: HTMLElement | null) {
  if (!cardEl) return;
  const content = cardEl.querySelector<HTMLElement>('[data-card-backface-content]');
  if (!content) return;
  // 翻转过程中 getBoundingClientRect 可能有透视变换误差,但 scrollHeight/clientHeight
  // 是 layout 值,不受 3D 变换影响,可放心比较。
  const isScrollable = content.scrollHeight > content.clientHeight + 2;
  content.classList.toggle('is-scrollable', isScrollable);
}
