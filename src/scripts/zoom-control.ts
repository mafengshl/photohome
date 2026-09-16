// 垂直缩放控制器 v3.1 — 与 Three.js Camera Zoom 深度同步
// 移植自目标站 /js/zoom-control.js（单例由 universe 初始化，避免原站重复绑定）
import type * as THREE from 'three';

export interface ZoomControl {
  setZoom: (v: number) => void;
  getZoom: () => number;
  reset: () => void;
  disable: () => void;
  enable: () => void;
}

export function initZoomControl(camera: THREE.PerspectiveCamera): ZoomControl | null {
  const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement | null;
  const zoomThumb = document.querySelector<HTMLElement>('.zoom-slider-thumb');
  const zoomValueDisplay = document.querySelector<HTMLElement>('.zoom-value-display');
  const universeContainer = document.querySelector<HTMLElement>('.universe-container');

  if (!zoomSlider || !universeContainer) return null;

  const isMobileUA = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  let currentZoom = parseFloat(zoomSlider.value);
  let targetZoom = currentZoom;
  let renderedZoom = currentZoom;
  let isInteractingWithSlider = false;
  let animationFrameId: number | null = null;

  function updateSliderUI(value: number) {
    const min = parseFloat(zoomSlider!.min);
    const max = parseFloat(zoomSlider!.max);
    const percentage = ((value - min) / (max - min)) * 100;

    if (zoomThumb) {
      const trackHeight = isMobileUA && window.innerWidth <= 768 ? 160 : 200;
      zoomThumb.style.top = `${(percentage / 100) * trackHeight}px`;
    }

    if (zoomValueDisplay) zoomValueDisplay.textContent = `${value.toFixed(1)}x`;
    currentZoom = value;
  }

  // 核心：应用缩放到 Camera Zoom；缺失时降级 CSS Scale
  function applyZoom(scale: number) {
    camera.zoom = scale;
    camera.updateProjectionMatrix();
  }

  function animateZoom() {
    const delta = targetZoom - renderedZoom;
    if (Math.abs(delta) < 0.001) {
      renderedZoom = targetZoom;
      applyZoom(renderedZoom);
      animationFrameId = null;
      return;
    }

    renderedZoom += delta * 0.18;
    applyZoom(renderedZoom);
    animationFrameId = requestAnimationFrame(animateZoom);
  }

  function syncZoom(value: number, options: { immediate?: boolean } = {}) {
    const minVal = parseFloat(zoomSlider!.min) || 1.0;
    const maxVal = parseFloat(zoomSlider!.max) || 2.5;
    const clampedValue = Math.max(minVal, Math.min(maxVal, value));

    targetZoom = clampedValue;
    zoomSlider!.value = clampedValue.toString();
    updateSliderUI(clampedValue);

    if (options.immediate) {
      renderedZoom = clampedValue;
      applyZoom(renderedZoom);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    } else if (!animationFrameId) {
      animationFrameId = requestAnimationFrame(animateZoom);
    }
  }

  zoomSlider.addEventListener('input', (e) => {
    syncZoom(parseFloat((e.target as HTMLInputElement).value));
  });

  // 桌面端滚轮：deltaY > 0（向下滚动）对应缩小
  universeContainer.addEventListener(
    'wheel',
    (e) => {
      if (zoomSlider.disabled) return;
      e.preventDefault();
      const delta =
        (e as WheelEvent).deltaY *
        ((e as WheelEvent).deltaMode === 1
          ? 16
          : (e as WheelEvent).deltaMode === 2
            ? window.innerHeight
            : 1);
      syncZoom(targetZoom - delta * 0.0012);
    },
    { passive: false },
  );

  // 移动端双指 Pinch
  let initialDist = 0;
  let zoomAtStart = 0;
  universeContainer.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        isInteractingWithSlider = true;
        window.__zoomGestureActive = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialDist = Math.sqrt(dx * dx + dy * dy);
        zoomAtStart = targetZoom;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  universeContainer.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2 && isInteractingWithSlider) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (initialDist > 10) {
          syncZoom(zoomAtStart * (dist / initialDist));
        }
        e.preventDefault();
      }
    },
    { passive: false },
  );

  universeContainer.addEventListener('touchend', () => {
    if (isInteractingWithSlider) {
      isInteractingWithSlider = false;
      window.__zoomGestureActive = false;
    }
  });

  universeContainer.addEventListener('touchcancel', () => {
    if (isInteractingWithSlider) {
      isInteractingWithSlider = false;
      window.__zoomGestureActive = false;
    }
  });

  updateSliderUI(currentZoom);
  syncZoom(currentZoom, { immediate: true });

  return {
    setZoom: (v: number) => syncZoom(v, { immediate: true }),
    getZoom: () => targetZoom,
    reset: () => syncZoom(1.0, { immediate: true }),
    disable: () => {
      zoomSlider.disabled = true;
      document.getElementById('zoom-slider-container')!.style.opacity = '0.3';
    },
    enable: () => {
      zoomSlider.disabled = false;
      document.getElementById('zoom-slider-container')!.style.opacity = '1';
    },
  };
}
