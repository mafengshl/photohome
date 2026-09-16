// 3D 宇宙引擎：负责场景初始化、卡片布局、模板克隆与点击命中检测。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { initZoomControl } from '/js/zoom-control.js';

const DEBUG = window.__SPACE_DEBUG === true;
const MOBILE_DEVICE_PATTERN = /iPhone|iPad|iPod|Android/i;
const CARD_METRICS = {
    desktop: {
        text: { width: 220, height: 320, radius: 1500 },
        mini: { width: 201, height: 320, radius: 1500 },
        square: { width: 268, height: 320, radius: 1500 },
        wide: { width: 402, height: 320, radius: 1500 }
    },
    mobile: {
        text: { width: 180, height: 280, radius: 1300 }, // 与 Mini 对齐
        mini: { width: 180, height: 280, radius: 1300 }, // 统一为窄型
        square: { width: 240, height: 280, radius: 1300 },
        wide: { width: 350, height: 280, radius: 1300 }
    }
};

let scene, camera, renderer, controls;
let currentCardsInScene = [];
let cardHitMeshes = [];
let currentPage = 1;
let allMessages = [];
let computedPages = []; // dynamic pagination structure
let zoomSliderEnabled = true;
let zoomControl = null;
let updateMobileTouchOrbit = null;
let cardTemplate = null;
let rendererContainer = null;
let hitMeshResources = null;
let isAnimatingPage = false;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function debugLog(...args) {
    if (DEBUG) {
        console.log(...args);
    }
}

function isMobileDevice() {
    return MOBILE_DEVICE_PATTERN.test(navigator.userAgent) || (navigator.maxTouchPoints > 0);
}

function getCardMetrics(cardType = 'text') {
    const deviceType = isMobileDevice() ? 'mobile' : 'desktop';
    return CARD_METRICS[deviceType][cardType] || CARD_METRICS[deviceType].text;
}

function ensureCardTemplate() {
    if (cardTemplate) return cardTemplate;

    const template = document.getElementById('message-card-template');
    if (!(template instanceof HTMLTemplateElement)) {
        throw new Error('Message card template is missing.');
    }

    const root = template.content.firstElementChild;
    if (!(root instanceof HTMLElement)) {
        throw new Error('Message card template root is invalid.');
    }

    cardTemplate = root;
    return cardTemplate;
}

function createCardElement(message) {
    const element = ensureCardTemplate().cloneNode(true);
    if (!(element instanceof HTMLElement)) {
        throw new Error('Failed to clone message card template.');
    }

    const textFaceEl = element.querySelector('[data-card-text-face]');
    const imageWrapEl = element.querySelector('[data-card-image-wrap]');
    const imageEl = element.querySelector('[data-card-image]');
    const imageAuthorEl = element.querySelector('[data-card-image-author]');
    const imageDateEl = element.querySelector('[data-card-image-date]');
    const authorEl = element.querySelector('[data-card-author]');
    const contentEl = element.querySelector('[data-card-content]');
    const dateEl = element.querySelector('[data-card-date]');
    const readIndicatorEl = element.querySelector('[data-card-read-indicator]');

    // 背面元素
    const backfaceContentEl = element.querySelector('[data-card-backface-content]');
    const backfaceCopyEl = element.querySelector('[data-card-backface-copy]');

    const authorText = message.author || `user#${message.id}`;
    const dateText = message.date || '';

    if (authorEl) authorEl.textContent = authorText;
    if (imageAuthorEl) imageAuthorEl.textContent = authorText;
    if (contentEl) contentEl.textContent = message.content || '';
    if (dateEl) dateEl.textContent = dateText;
    if (imageDateEl) imageDateEl.textContent = dateText;
    if (readIndicatorEl) {
        readIndicatorEl.setAttribute('aria-label', `Open message from ${message.author || 'Anonymous'}`);
    }

    // 填充背面数据
    if (backfaceContentEl instanceof HTMLElement) {
        backfaceContentEl.setAttribute('aria-label', `Message from ${authorText}`);
    }
    if (backfaceCopyEl) backfaceCopyEl.textContent = message.content || '';

    // 设置ARIA属性
    element.setAttribute('aria-flipped', 'false');

    const setTextMode = () => {
        element.classList.remove('msg-card--image');
        element.classList.add('msg-card--text');
        element.dataset.cardType = 'text';
        if (textFaceEl instanceof HTMLElement) textFaceEl.hidden = false;
        if (imageWrapEl instanceof HTMLElement) imageWrapEl.hidden = true;
        if (imageEl instanceof HTMLImageElement) {
            imageEl.removeAttribute('src');
            imageEl.alt = '';
            imageEl.onerror = null;
        }
    };

    const setImageMode = () => {
        if (!(imageEl instanceof HTMLImageElement) || !(imageWrapEl instanceof HTMLElement)) {
            setTextMode();
            return;
        }

        element.classList.remove('msg-card--text');
        element.classList.add('msg-card--image');
        element.dataset.cardType = 'image';
        if (textFaceEl instanceof HTMLElement) textFaceEl.hidden = true;
        imageWrapEl.hidden = false;

        imageEl.alt = `${message.author || 'Anonymous'} photo card`;
        imageEl.onerror = () => {
            setTextMode();
        };
        imageEl.src = message.imageUrl;
    };

    element.dataset.messageId = message.id || '';
    const formatType = (message.format_type || 'text').toLowerCase();

    if (message.hasImage && message.imageUrl) {
        setImageMode();
        // 根据规格添加特定的 CSS 类
        if (formatType === 'square') element.classList.add('msg-card--square');
        else if (formatType === 'wide') element.classList.add('msg-card--wide');
        else element.classList.add('msg-card--mini');
    } else {
        setTextMode();
    }

    return element;
}

function getHitMeshResources(cardType = 'text') {
    if (hitMeshResources && hitMeshResources.cardType === cardType) {
        return hitMeshResources;
    }

    // 清理现有资源
    resetHitMeshResources();

    const { width, height } = getCardMetrics(cardType);
    hitMeshResources = {
        geometry: new THREE.PlaneGeometry(width, height),
        material: new THREE.MeshBasicMaterial({ visible: false }),
        cardType: cardType
    };
    return hitMeshResources;
}

function resetHitMeshResources() {
    if (!hitMeshResources) return;

    hitMeshResources.geometry.dispose();
    hitMeshResources.material.dispose();
    hitMeshResources = null;
}

export function initUniverse(messages) {
    rendererContainer = document.getElementById('canvas-container');
    if (!rendererContainer) {
        throw new Error('Canvas container is missing.');
    }

    allMessages = messages;
    ensureCardTemplate();
    const isMobile = isMobileDevice();

    if (isMobile) {
        document.body.classList.add('is-mobile');
    }

    scene = new THREE.Scene();

    const fov = isMobile ? 65 : 75;
    const near = 0.5; // 为了全景自旋效果，稍微增大近裁剪面
    const far = 10000;
    camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, near, far);

    // 核心变更：相机置于原点，用户站在中心向外看
    camera.position.set(0, 0, 100);

    renderer = new CSS3DRenderer();
    const width = window.innerWidth;
    const height = window.innerHeight;

    renderer.setSize(width, height);
    renderer.domElement.style.width = width + 'px';
    renderer.domElement.style.height = height + 'px';

    // iPad Retina 渲染降级方案：缩放整个场景坐标系
    // WebKit 有 4096px 的单层内存限制，iPad 高分辨率下 1200 radius 会超出。
    // 缩放场景会将 CSS3DRenderer 输出的 translate3d 减半，完美规避。
    if (isMobile && width >= 768) {
        scene.scale.set(0.5, 0.5, 0.5);
    }

    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.top = '0';
    renderer.domElement.style.left = '0';
    renderer.domElement.style.overflow = 'visible';
    renderer.domElement.style.transformStyle = 'preserve-3d';
    renderer.domElement.style.webkitTransformStyle = 'preserve-3d';
    renderer.domElement.style.backfaceVisibility = 'hidden';
    renderer.domElement.style.webkitBackfaceVisibility = 'hidden';
    renderer.domElement.style.touchAction = 'none';
    rendererContainer.appendChild(renderer.domElement);

    // 给父层容器也加上必要属性，保持 3D 上下文一致性
    rendererContainer.style.transformStyle = 'preserve-3d';
    rendererContainer.style.webkitTransformStyle = 'preserve-3d';
    rendererContainer.style.perspective = '1000px';
    rendererContainer.style.webkitPerspective = '1000px';

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false; // 禁用 OrbitControls 自带缩放，使用 zoom-control.js 的自定义逻辑
    controls.enablePan = false; // 禁用平移，专注于自旋
    controls.enableRotate = true;
    controls.rotateSpeed = isMobile ? -0.22 : -0.38; // 调整为第一人称转动感
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;

    // 设置旋转中心为相机原点（模拟自旋）
    controls.target.set(0, 0, 0);

    if (isMobile) {
        controls.touches = {
            ONE: THREE.TOUCH.ROTATE,
            TWO: null
        };
        controls.screenSpacePanning = false;
        controls.enabled = false;
        setupMobileTouchOrbit(renderer.domElement);
    }

    window.orbitControls = controls;
    window.refreshOrbitControls = refreshOrbitControls;

    setOrbitLimits();
    buildPageChunks(allMessages);
    renderPage(1);

    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('click', onDocumentClick);

    setTimeout(() => {
        zoomControl = initZoomControl();
        if (zoomControl && !zoomSliderEnabled) {
            zoomControl.disable();
        }
        debugLog('缩放控制器初始化:', zoomControl ? '成功' : '失败');
    }, 100);

    animate();

    return { scene, camera, renderer, controls, renderPage, zoomControl };
}

function setOrbitLimits() {
    // 全景模式通常允许 360° 旋转，但可以限制仰角防止看到“南极/北极”
    controls.minPolarAngle = Math.PI / 2 - (Math.PI * 15 / 180);
    controls.maxPolarAngle = Math.PI / 2 + (Math.PI * 15 / 180);
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
}

export function unlockOrbitLimits() {
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
}

export function restoreOrbitLimits() {
    setOrbitLimits();
}

export function refreshOrbitControls() {
    if (!controls) return;

    const wasEnabled = controls.enabled;
    setOrbitLimits();
    controls.update();

    controls.enabled = false;
    requestAnimationFrame(() => {
        controls.enabled = wasEnabled;
        controls.update();
    });
}

function buildPageChunks(messages) {
    computedPages = [];
    if (!messages || messages.length === 0) return;

    const sortedMessages = [...messages].sort((a, b) => new Date(b.timestamp || b.date || 0) - new Date(a.timestamp || a.date || 0));
    const isMobile = isMobileDevice();
    const metrics = isMobile ? CARD_METRICS.mobile : CARD_METRICS.desktop;
    const radius = metrics.mini.radius;
    const GAPS = isMobile ? 65 : 55;
    const MAX_ROWS = 3;
    const FULL_CIRCLE_THRESHOLD = Math.PI * 2 * 0.98;

    let currentPageRows = [[], [], []];
    let currentRowAngles = [0, 0, 0];
    let currentPageItems = [];

    const commitPage = () => {
        // 利用原瀑布流逻辑计算出的各项数量规格，将收集到的卡片按严格的时间顺序切分至三行中
        const counts = [
            currentPageRows[0].length,
            currentPageRows[1].length,
            currentPageRows[2].length
        ];

        const sortedPageRows = [[], [], []];
        let ptr = 0;
        for (let r = 0; r < MAX_ROWS; r++) {
            const rowCount = counts[r];
            for (let i = 0; i < rowCount; i++) {
                if (ptr < currentPageItems.length) {
                    sortedPageRows[r].push(currentPageItems[ptr]);
                    ptr++;
                }
            }
        }

        computedPages.push(sortedPageRows);
        currentPageRows = [[], [], []];
        currentRowAngles = [0, 0, 0];
        currentPageItems = [];
    };

    sortedMessages.forEach(msg => {
        const formatType = (msg.format_type || 'text').toLowerCase();
        const spec = metrics[formatType] || metrics.mini;
        const angleWidth = (spec.width + GAPS) / radius;

        let shortestRowIdx = 0;
        let minAngle = currentRowAngles[0];
        for (let i = 1; i < MAX_ROWS; i++) {
            if (currentRowAngles[i] < minAngle) {
                minAngle = currentRowAngles[i];
                shortestRowIdx = i;
            }
        }

        if (minAngle + angleWidth > FULL_CIRCLE_THRESHOLD) {
            commitPage();
            shortestRowIdx = 0; // 重置后从第一行重新排起
        }

        const item = { msg, angleWidth, spec, formatType };
        currentPageRows[shortestRowIdx].push(item);
        currentRowAngles[shortestRowIdx] += angleWidth;
        currentPageItems.push(item);
    });

    if (currentPageItems.length > 0) {
        commitPage();
    }
}

function setupMobileTouchOrbit(domElement) {
    let lastX = 0;
    let lastY = 0;
    let isDragging = false;
    let orbitRadius = 0;
    let orbitTheta = 0;
    let orbitPhi = 0;
    let velocityTheta = 0;
    let velocityPhi = 0;

    const rotateSpeed = 0.0018;
    const dragDamping = 0.72;
    const inertiaDamping = 0.9;
    const minVelocity = 0.00001;

    function syncSphericalState() {
        const offset = camera.position.clone().sub(controls.target);
        const spherical = new THREE.Spherical();
        spherical.setFromVector3(offset);
        orbitRadius = spherical.radius;
        orbitTheta = spherical.theta;
        orbitPhi = spherical.phi;
    }

    function applyOrbitPosition() {
        orbitTheta = Math.max(controls.minAzimuthAngle, Math.min(controls.maxAzimuthAngle, orbitTheta));
        orbitPhi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, orbitPhi));

        const spherical = new THREE.Spherical(orbitRadius, orbitPhi, orbitTheta);
        spherical.makeSafe();

        const nextOffset = new THREE.Vector3().setFromSpherical(spherical);
        camera.position.copy(controls.target).add(nextOffset);
        camera.lookAt(controls.target);
        controls.update();
    }

    function onTouchStart(event) {
        if (!controls || event.touches.length !== 1 || window.__zoomGestureActive || document.body.classList.contains('reading-mode')) return;

        isDragging = true;
        syncSphericalState();
        lastX = event.touches[0].clientX;
        lastY = event.touches[0].clientY;
    }

    function onTouchMove(event) {
        if (!isDragging || event.touches.length !== 1 || window.__zoomGestureActive || document.body.classList.contains('reading-mode')) return;

        const touch = event.touches[0];
        const deltaX = touch.clientX - lastX;
        const deltaY = touch.clientY - lastY;
        lastX = touch.clientX;
        lastY = touch.clientY;

        velocityTheta = (velocityTheta * 0.35) + (deltaX * rotateSpeed * 0.65);
        velocityPhi = (velocityPhi * 0.35) + (deltaY * rotateSpeed * 0.65);

        event.preventDefault();
    }

    function onTouchEnd() {
        isDragging = false;
    }

    updateMobileTouchOrbit = () => {
        if (window.__zoomGestureActive || document.body.classList.contains('reading-mode')) return;
        if (Math.abs(velocityTheta) < minVelocity && Math.abs(velocityPhi) < minVelocity) return;

        orbitTheta += velocityTheta;
        orbitPhi += velocityPhi;

        const clampedTheta = Math.max(controls.minAzimuthAngle, Math.min(controls.maxAzimuthAngle, orbitTheta));
        const clampedPhi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, orbitPhi));

        if (clampedTheta !== orbitTheta) velocityTheta = 0;
        if (clampedPhi !== orbitPhi) velocityPhi = 0;

        orbitTheta = clampedTheta;
        orbitPhi = clampedPhi;
        applyOrbitPosition();

        const damping = isDragging ? dragDamping : inertiaDamping;
        velocityTheta *= damping;
        velocityPhi *= damping;
    };

    domElement.addEventListener('touchstart', onTouchStart, { passive: true });
    domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    domElement.addEventListener('touchend', onTouchEnd, { passive: true });
    domElement.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
        updateMobileTouchOrbit = null;
        domElement.removeEventListener('touchstart', onTouchStart);
        domElement.removeEventListener('touchmove', onTouchMove);
        domElement.removeEventListener('touchend', onTouchEnd);
        domElement.removeEventListener('touchcancel', onTouchEnd);
    };
}

export function getCurrentPage() {
    return currentPage;
}

export function getTotalPages() {
    return computedPages.length || 1;
}

export function enableZoomSlider(enabled) {
    zoomSliderEnabled = enabled;

    if (zoomControl) {
        if (enabled) {
            zoomControl.enable();
        } else {
            zoomControl.disable();
        }
    }

    debugLog(`缩放控制器状态: ${enabled ? '启用' : '禁用'}`);
}

export function isZoomSliderEnabled() {
    return zoomSliderEnabled;
}

// 兼容旧版 interactions 模块在回退后仍可能发起的遗留导入，避免页面直接报错。
export function suspendInactiveCardsForReading() { }

export function restoreSuspendedCards() { }

function renderPage(page, nextMessages = null, direction = 0) {
    if (isAnimatingPage) return;

    if (Array.isArray(nextMessages)) {
        allMessages = nextMessages;
        buildPageChunks(allMessages);
    }

    const oldCards = [...currentCardsInScene];
    const oldHitMeshes = [...cardHitMeshes];

    currentCardsInScene = [];
    cardHitMeshes = [];
    currentPage = page;

    // 解析出当页需要渲染的行结构
    const pageRows = computedPages[page - 1] || [[], [], []];

    // 如果 direction 为 0，说明是初始加载或 resize，无需动画
    if (direction === 0 || oldCards.length === 0) {
        oldCards.forEach(obj => scene.remove(obj));
        oldHitMeshes.forEach(mesh => scene.remove(mesh));
        generateLayout(pageRows);
    } else {
        isAnimatingPage = true;
        // 1. 旧卡片滚出
        animateOut(oldCards, oldHitMeshes, direction);

        // 2. 生成新页布局（此时新卡片会被加入 currentCardsInScene）
        generateLayout(pageRows);
        const newCards = currentCardsInScene;
        const newHitMeshes = cardHitMeshes;

        // 3. 新卡片切入
        animateIn(newCards, newHitMeshes, direction);
    }

    const totalPages = getTotalPages();
    const pageInfo = document.getElementById('page-info');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    if (pageInfo) pageInfo.innerText = `PAGE ${page} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = (page === 1);
    if (nextBtn) nextBtn.disabled = (page === totalPages);
}

function animateOut(cards, hitMeshes, direction) {
    const offset = direction * 2000;
    const duration = 1600; // 进一步放慢，增加优雅感

    cards.forEach((card, i) => {
        const element = card.element;
        element.style.pointerEvents = 'none';

        requestAnimationFrame(() => {
            new TWEEN.Tween(card.position)
                .to({ y: card.position.y + offset }, duration)
                .easing(TWEEN.Easing.Cubic.In)
                .start();

            new TWEEN.Tween({ opacity: 1 })
                .to({ opacity: 0 }, duration * 0.7)
                .onUpdate((obj) => {
                    element.style.opacity = obj.opacity;
                })
                .onComplete(() => {
                    scene.remove(card);
                    const hitMesh = hitMeshes[i];
                    if (hitMesh) scene.remove(hitMesh);
                })
                .start();
        });
    });
}

function animateIn(cards, hitMeshes, direction) {
    const offset = direction * 2000;
    const duration = 2200; // 显著延长时间，营造星团缓缓降落的史诗感
    let completedCount = 0;

    cards.forEach((card, i) => {
        card.position.y -= offset;
        card.element.style.opacity = '0';
        card.element.style.pointerEvents = 'none';
        const hitMesh = hitMeshes[i];
        if (hitMesh) hitMesh.position.y = card.position.y;
    });

    requestAnimationFrame(() => {
        cards.forEach((card, i) => {
            const targetY = card.position.y + offset;
            const element = card.element;
            const hitMesh = hitMeshes[i];

            new TWEEN.Tween(card.position)
                .to({ y: targetY }, duration)
                .easing(TWEEN.Easing.Quartic.Out)
                .onUpdate(() => {
                    if (hitMesh) hitMesh.position.y = card.position.y;
                })
                .start();

            new TWEEN.Tween({ opacity: 0 })
                .to({ opacity: 1 }, duration * 0.75)
                .onUpdate((obj) => {
                    element.style.opacity = obj.opacity;
                })
                .onComplete(() => {
                    element.style.pointerEvents = 'auto';
                    completedCount++;
                    if (completedCount === cards.length) {
                        isAnimatingPage = false;
                    }
                })
                .start();
        });
    });
}

function generateLayout(pageRows) {
    const isMobile = isMobileDevice();
    const metrics = isMobile ? CARD_METRICS.mobile : CARD_METRICS.desktop;
    const radius = metrics.mini.radius; // 基于 Mini 的基准半径
    const ROW_HEIGHT = isMobile ? 450 : 420; // 显著拉大移动端行距

    const activeRows = pageRows.filter(r => r.length > 0);
    const ROWS = activeRows.length || 1;

    activeRows.forEach((rowItems, r) => {
        let totalRowAngle = 0;

        rowItems.forEach(item => {
            totalRowAngle += item.angleWidth;
        });

        // 2. 设置起始角度为总宽度的一半，实现居中
        let currentAngle = -totalRowAngle / 2;

        rowItems.forEach((item) => {
            const { msg, angleWidth, formatType } = item;
            const el = createCardElement(msg);
            const obj = new CSS3DObject(el);

            const theta = currentAngle + angleWidth / 2;
            const y = ((ROWS - 1) / 2 - r) * ROW_HEIGHT;

            const x = radius * Math.sin(theta);
            const z = -radius * Math.cos(theta);

            obj.position.set(x, y, z);
            obj.lookAt(0, y, 0);

            scene.add(obj);
            currentCardsInScene.push(obj);

            const { geometry, material } = getHitMeshResources(formatType);
            const hitMesh = new THREE.Mesh(geometry, material);
            hitMesh.position.copy(obj.position);
            hitMesh.rotation.copy(obj.rotation);
            hitMesh.userData.originalCard = obj;
            scene.add(hitMesh);
            cardHitMeshes.push(hitMesh);

            currentAngle += angleWidth;
        });
    });
}

function onDocumentClick(event) {
    if (document.body.classList.contains('reading-mode')) {
        return;
    }

    event.preventDefault();
    const rendererRect = renderer.domElement.getBoundingClientRect();

    let screenX = event.clientX - rendererRect.left;
    let screenY = event.clientY - rendererRect.top;

    const rendererWidth = rendererRect.width;
    const rendererHeight = rendererRect.height;
    let localX = screenX;
    let localY = screenY;

    const isLocalXInBounds = localX >= 0 && localX <= rendererWidth;
    const isLocalYInBounds = localY >= 0 && localY <= rendererHeight;
    mouse.x = (localX / rendererWidth) * 2 - 1;
    mouse.y = -(localY / rendererHeight) * 2 + 1;
    const isMouseXValid = mouse.x >= -1 && mouse.x <= 1;
    const isMouseYValid = mouse.y >= -1 && mouse.y <= 1;
    if (!isLocalXInBounds || !isLocalYInBounds || !isMouseXValid || !isMouseYValid) {
        return;
    }

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(cardHitMeshes);
    if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        const cardObj = hitMesh.userData.originalCard;
        window.dispatchEvent(new CustomEvent('card-click', {
            detail: { object: cardObj, element: cardObj.element }
        }));
    }
}

function onWindowResize() {
    const isMobile = isMobileDevice();
    const width = window.innerWidth;
    const height = window.innerHeight;

    camera.aspect = width / height;
    if (isMobile) {
        camera.fov = 60;
    } else {
        camera.fov = 75;
    }

    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
    renderer.domElement.style.width = width + 'px';
    renderer.domElement.style.height = height + 'px';

    if (isMobile && width >= 768) {
        scene.scale.set(0.5, 0.5, 0.5);
    } else {
        scene.scale.set(1.0, 1.0, 1.0);
    }

    resetHitMeshResources();

    // 重新计算分页，因为卡距和尺寸在不同设备阈值下已变
    buildPageChunks(allMessages);

    // 当屏幕尺寸变化导致总页数变动时，确保 currentPage 仍在合法范围内
    const totalPages = getTotalPages();
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    renderPage(currentPage);
}

function animate() {
    requestAnimationFrame(animate);
    if (typeof TWEEN !== 'undefined') TWEEN.update();
    if (typeof updateMobileTouchOrbit === 'function') updateMobileTouchOrbit();
    controls.update();
    renderer.render(scene, camera);
}
