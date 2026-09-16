// 垂直缩放控制器 v3.1 - 与 Three.js Camera Zoom 深度同步
const DEBUG_ZOOM = window.__SPACE_DEBUG === true;

function debugLog(...args) {
    if (DEBUG_ZOOM) console.log(...args);
}

export function initZoomControl() {
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomThumb = document.querySelector('.zoom-slider-thumb');
    const zoomValueDisplay = document.querySelector('.zoom-value-display');
    const universeContainer = document.querySelector('.universe-container');

    if (!zoomSlider || !universeContainer) return null;

    let currentZoom = parseFloat(zoomSlider.value);
    let targetZoom = currentZoom;
    let renderedZoom = currentZoom;
    let isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    let isInteractingWithSlider = false;
    let animationFrameId = null;

    function updateSliderUI(value) {
        const min = parseFloat(zoomSlider.min);
        const max = parseFloat(zoomSlider.max);
        const percentage = ((value - min) / (max - min)) * 100;

        if (zoomThumb) {
            const trackHeight = isMobile && window.innerWidth <= 768 ? 160 : 200;
            zoomThumb.style.top = `${(percentage / 100) * trackHeight}px`;
        }

        if (zoomValueDisplay) zoomValueDisplay.textContent = `${value.toFixed(1)}x`;
        currentZoom = value;
    }

    // v3.1 核心：应用缩放到 Camera Zoom
    function applyZoom(scale) {
        if (window.camera) {
            window.camera.zoom = scale;
            window.camera.updateProjectionMatrix();
        } else {
            // 降级使用 CSS Scale (防错)
            universeContainer.style.transformOrigin = 'center center';
            universeContainer.style.transform = `scale(${scale})`;
        }
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

    function syncZoom(value, options = {}) {
        const minVal = parseFloat(zoomSlider.min) || 1.0;
        const maxVal = parseFloat(zoomSlider.max) || 2.5;
        const clampedValue = Math.max(minVal, Math.min(maxVal, value));
        
        targetZoom = clampedValue;
        zoomSlider.value = clampedValue.toString();
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

    // 设置输入事件
    zoomSlider.addEventListener('input', (e) => syncZoom(parseFloat(e.target.value)));

    // 桌面端滚轮支持
    universeContainer.addEventListener('wheel', (e) => {
        if (zoomSlider.disabled) return;
        e.preventDefault();
        // 调整方向：e.deltaY > 0 是向下滚动，通常对应缩小
        const delta = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? window.innerHeight : 1));
        syncZoom(targetZoom - (delta * 0.0012));
    }, { passive: false });

    // 移动端双指手势 (Pinch)
    let initialDist = 0, zoomAtStart = 0;
    universeContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            isInteractingWithSlider = true;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            initialDist = Math.sqrt(dx*dx + dy*dy);
            zoomAtStart = targetZoom; // 使用 targetZoom 避免动画延迟导致的不一致
            e.preventDefault();
        }
    }, { passive: false });

    universeContainer.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && isInteractingWithSlider) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (initialDist > 10) {
                syncZoom(zoomAtStart * (dist / initialDist));
            }
            e.preventDefault();
        }
    }, { passive: false });

    universeContainer.addEventListener('touchend', () => {
        if (isInteractingWithSlider) {
            isInteractingWithSlider = false;
        }
    });

    // 初始化
    updateSliderUI(currentZoom);
    syncZoom(currentZoom, { immediate: true });

    return {
        setZoom: (v) => syncZoom(v, { immediate: true }),
        getZoom: () => targetZoom,
        reset: () => syncZoom(1.0, { immediate: true }),
        disable: () => { zoomSlider.disabled = true; document.getElementById('zoom-slider-container').style.opacity = '0.3'; },
        enable: () => { zoomSlider.disabled = false; document.getElementById('zoom-slider-container').style.opacity = '1'; }
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.zoomControl = initZoomControl());
} else {
    window.zoomControl = initZoomControl();
}
