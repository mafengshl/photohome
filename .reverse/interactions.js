// 交互逻辑 - TWEEN.js 飞行动画 + 卡片聚焦 + 图片翻转 (v4.0 翻转版)
import { unlockOrbitLimits, restoreOrbitLimits, getCurrentPage, getTotalPages, enableZoomSlider } from '/js/universe.js';

const TWEEN = window.TWEEN;
const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

let isReading = false;
let savedCameraPos = null;
let savedZoom = 1.0;
let activeCardEl = null;
let flipHintEl = null;
let exitButtonEl = null;
let hintLayoutTimer = null;
let isReadingViewStable = false;
let pendingStableSignals = 0;
let stableDelayTimer = null;
let stableCheckRaf = null;
let pendingFlipRequest = false;

export function setupInteractions(camera, controls, arcContainer, exitBtn, renderPage) {
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const pagiUI = document.getElementById('pagi-ui');
    const messageCounter = document.getElementById('message-counter');
    const footer = document.getElementById('footer');
    flipHintEl = document.getElementById('flip-hint');
    exitButtonEl = exitBtn;
    if (flipHintEl) {
        flipHintEl.addEventListener('click', handleFlipHintClick);
        flipHintEl.addEventListener('keydown', handleFlipHintKeydown);
        flipHintEl.setAttribute('role', 'button');
        flipHintEl.setAttribute('tabindex', '0');
        flipHintEl.setAttribute('aria-label', 'Flip card');
    }

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            const page = getCurrentPage();
            if (page > 1) {
                renderPage(page - 1, null, 1);
                resetView();
            }
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            const page = getCurrentPage();
            if (page < getTotalPages()) {
                renderPage(page + 1, null, -1);
                resetView();
            }
        });
    }

    function resetView() {
        if (isReading) return;

        // 视角更加平滑地回正到中间 (0,0,100)
        new TWEEN.Tween(camera.position)
            .to({ x: 0, y: 0, z: 100 }, 1100) // 稍微延长时长增加丝滑度
            .easing(TWEEN.Easing.Cubic.InOut) // 改为两端缓动
            .start();

        new TWEEN.Tween(controls.target)
            .to({ x: 0, y: 0, z: 0 }, 1100)
            .easing(TWEEN.Easing.Cubic.InOut)
            .onUpdate(() => controls.update())
            .start();
    }

    window.addEventListener('card-click', (e) => {
        if (isReading) return;
        const { object: obj, element: el } = e.detail;
        flyToCard(obj, el);
    });

    // 键盘翻转支持
    document.addEventListener('keydown', handleFlipKeydown);
    window.addEventListener('resize', refreshFlipHintPosition);
    window.addEventListener('orientationchange', refreshFlipHintPosition);

    exitBtn.addEventListener('click', () => {
        returnToOrigin();
    });

    function flyToCard(cardObj, el) {
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

        if (pagiUI) pagiUI.style.opacity = '0';
        if (messageCounter) messageCounter.style.opacity = '0';
        if (footer) footer.style.opacity = '0';
        if (arcContainer) arcContainer.classList.add('hidden');

        // 保存当前相机位置
        savedCameraPos = camera.position.clone();

        const cardPos = cardObj.position.clone();
        // v3.0 适配：相机向卡片靠近，保持在圆柱中心轴到卡片的水平连线上
        // 通过剔除 Y 轴垂直偏移并在水平面上计算朝向，确保上下侧的卡片也能正对视角（零倾斜）
        const horizontalDir = cardPos.clone();
        horizontalDir.y = 0;
        horizontalDir.normalize();
        const targetPos = cardPos.clone().sub(horizontalDir.multiplyScalar(450));

        const tweenDuration = isMobileDevice ? 900 : 1200;
        const hintDelay = 120;

        new TWEEN.Tween(camera.position)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, tweenDuration)
            .easing(TWEEN.Easing.Cubic.InOut)
            .onComplete(() => markReadingViewStable(hintDelay))
            .start();

        new TWEEN.Tween(controls.target)
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
        setTimeout(() => { exitBtn.style.display = 'none'; }, 500);

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

        // v3.0 适配：返回初始全景视角中心 (0, 0, 100)
        const returnPos = savedCameraPos || { x: 0, y: 0, z: 100 };
        const tweenDuration = isMobileDevice ? 900 : 1200;

        new TWEEN.Tween(camera.position)
            .to({ x: returnPos.x, y: returnPos.y, z: returnPos.z }, tweenDuration)
            .easing(TWEEN.Easing.Cubic.InOut)
            .start();

        new TWEEN.Tween(controls.target)
            .to({ x: 0, y: 0, z: 0 }, tweenDuration)
            .easing(TWEEN.Easing.Cubic.InOut)
            .onComplete(() => {
                restoreOrbitLimits();
                controls.enabled = !isMobileDevice;
                controls.update();

                if (footer) footer.style.opacity = '1';
                if (pagiUI) pagiUI.style.opacity = '1';
                if (messageCounter) messageCounter.style.opacity = '1';
            })
            .start();

        if (arcContainer) arcContainer.classList.remove('hidden');
    }
}

/**
 * 处理翻转点击
 * 仅在阅读模式下，点击聚焦的图片卡片时触发翻转
 */
function handleFlipClick(event) {
    if (!isReading || !activeCardEl) return;
    if (event.target.closest('#exit-btn')) return;
    if (event.currentTarget !== activeCardEl) return;

    event.preventDefault();
    event.stopPropagation();

    if (!isReadingViewStable) {
        pendingFlipRequest = true;
        return;
    }

    toggleCardFlip(activeCardEl);
}

/**
 * 键盘翻转支持
 */
function handleFlipKeydown(event) {
    if (!isReading || !activeCardEl) return;

    // 空格键或回车键翻转
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

/**
 * 切换卡片翻转状态
 */
function toggleCardFlip(cardEl) {
    const flipContainer = cardEl.querySelector('[data-flip-container]');
    if (!flipContainer) return;

    // 翻转前先预热合成层，降低首次翻面时的边框闪现概率
    flipContainer.getBoundingClientRect();
    void flipContainer.offsetWidth;

    // 触发红色光影减弱动画
    cardEl.classList.remove('flip-dim');
    void cardEl.offsetWidth; // 触发重绘以重新开始动画
    cardEl.classList.add('flip-dim');

    const isFlipped = flipContainer.classList.toggle('is-flipped');
    cardEl.classList.toggle('is-flipped', isFlipped);

    // 更新ARIA属性
    cardEl.setAttribute('aria-flipped', isFlipped);

    syncFlipHint(isFlipped);

    // 触发自定义事件
    window.dispatchEvent(new CustomEvent('card-flip', {
        detail: {
            cardEl,
            isFlipped,
            messageId: cardEl.dataset.messageId
        }
    }));
}

/**
 * 重置卡片翻转状态
 */
function resetCardFlip(cardEl) {
    if (!cardEl) return;

    const flipContainer = cardEl.querySelector('[data-flip-container]');
    if (flipContainer) {
        flipContainer.classList.remove('is-flipped');
    }
    cardEl.classList.remove('is-flipped');
    cardEl.setAttribute('aria-flipped', 'false');
    syncFlipHint(false);
}

function attachFlipHandlers(cardEl) {
    if (!cardEl || !cardEl.classList.contains('msg-card--image')) {
        syncFlipHint(false);
        return;
    }

    cardEl.addEventListener('click', handleFlipClick);
    cardEl.setAttribute('tabindex', '0');
    cardEl.setAttribute('role', 'button');
    if (typeof cardEl.focus === 'function') {
        try {
            cardEl.focus({ preventScroll: true });
        } catch (error) {
            cardEl.focus();
        }
    }
    syncFlipHint(false);
    scheduleFlipHintRefresh();
}

function detachFlipHandlers(cardEl) {
    if (!cardEl) return;

    cardEl.removeEventListener('click', handleFlipClick);
    cardEl.removeAttribute('tabindex');
    cardEl.removeAttribute('role');
    if (typeof cardEl.blur === 'function') {
        cardEl.blur();
    }
    syncFlipHint(false);
}

function syncFlipHint(isFlipped) {
    if (!flipHintEl) return;

    const shouldShow = Boolean(
        isReading &&
        isReadingViewStable &&
        activeCardEl &&
        activeCardEl.classList.contains('msg-card--image') &&
        !isFlipped
    );

    if (shouldShow) {
        const positioned = refreshFlipHintPosition();
        if (positioned) {
            if (!flipHintEl.classList.contains('is-visible')) {
                requestAnimationFrame(() => {
                    flipHintEl.classList.add('is-visible');
                });
            }
        } else {
            // exit 按钮还没显示/布局未稳定时，不要让提示先出现在默认位置
            flipHintEl.classList.remove('is-visible');
            scheduleFlipHintRefresh(60);
        }
    } else {
        flipHintEl.classList.remove('is-visible');
        flipHintEl.style.removeProperty('top');
        flipHintEl.style.removeProperty('left');
    }
}

function handleFlipHintClick(event) {
    if (!isReading || !activeCardEl) return;
    if (!isReadingViewStable) return;
    if (!activeCardEl.classList.contains('msg-card--image')) return;
    if (activeCardEl.classList.contains('is-flipped')) return;

    toggleCardFlip(activeCardEl);
    event.preventDefault();
    event.stopPropagation();
}

function handleFlipHintKeydown(event) {
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

function waitForReadingViewStable() {
    if (!isReading || !activeCardEl) return;

    const maxFrames = 120;
    const requiredStableFrames = 4;
    const epsilon = 0.6;
    let frame = 0;
    let stableFrames = 0;
    let last = null;

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
        } else if (last) {
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

        last = exitReady && cardReady ? { card: cardRect, exit: exitRect } : null;
        frame += 1;

        if (stableFrames >= requiredStableFrames || frame >= maxFrames) {
            if (!isReading || !activeCardEl) return;
            isReadingViewStable = true;
            primeFlipCard(activeCardEl);
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

function primeFlipCard(cardEl) {
    if (!cardEl || !cardEl.classList.contains('msg-card--image')) return;

    const flipContainer = cardEl.querySelector('[data-flip-container]');
    const frontFace = cardEl.querySelector('.msg-card__front-face');
    const backFace = cardEl.querySelector('[data-card-backface]');

    cardEl.getBoundingClientRect();
    void cardEl.offsetWidth;

    if (flipContainer instanceof HTMLElement) {
        flipContainer.getBoundingClientRect();
        void flipContainer.offsetWidth;
    }

    if (frontFace instanceof HTMLElement) {
        frontFace.getBoundingClientRect();
    }

    if (backFace instanceof HTMLElement) {
        backFace.getBoundingClientRect();
    }
}

function refreshFlipHintPosition() {
    if (
        !flipHintEl ||
        !exitButtonEl ||
        !isReading ||
        !activeCardEl ||
        !activeCardEl.classList.contains('msg-card--image') ||
        activeCardEl.classList.contains('is-flipped')
    ) {
        return false;
    }

    const cardRect = activeCardEl.getBoundingClientRect();
    const exitRect = exitButtonEl.getBoundingClientRect();
    if (!cardRect.width || !cardRect.height || !exitRect.width || !exitRect.height) {
        return false;
    }

    const midpointY = cardRect.bottom + ((exitRect.top - cardRect.bottom) / 2);
    const hintHeight = flipHintEl.offsetHeight || 28;
    const clampedTop = Math.min(
        window.innerHeight - (hintHeight / 2) - 20,
        Math.max((hintHeight / 2) + 20, midpointY)
    );

    flipHintEl.style.left = '50%';
    flipHintEl.style.top = `${clampedTop - (hintHeight / 2)}px`;
    return true;
}
