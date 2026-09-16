// 3D 宇宙引擎：场景初始化、圆柱三行卡片布局、模板克隆、分页切换与射线命中检测。
// 1:1 移植自目标站 /js/universe.js（Three.js r157 → 本项目 three 0.186）
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { TWEEN, createTween } from './tween';
import { initZoomControl, type ZoomControl } from './zoom-control';
import type { CardType, Message } from './types';

export type { CardType, Message } from './types';

declare global {
  interface Window {
    orbitControls?: OrbitControls;
    refreshOrbitControls?: () => void;
    zoomControl?: ZoomControl | null;
    __zoomGestureActive?: boolean;
  }
}

interface CardSpec {
  width: number;
  height: number;
  radius: number;
}

interface LayoutItem {
  msg: Message;
  angleWidth: number;
  spec: CardSpec;
  formatType: CardType;
  /** 动态卡片宽度（px，基于图片宽高比与同行等高计算） */
  cardWidth: number;
  /** 动态卡片高度（px） */
  cardHeight: number;
}

type PageRows = LayoutItem[][];

/** 全部分页：页 → 三行 → 行内卡片 */
type PaginatedRows = PageRows[];

export type RenderPageFn = (
  page: number,
  nextMessages?: Message[] | null,
  direction?: number,
) => void;

export interface UniverseHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: CSS3DRenderer;
  controls: OrbitControls;
  renderPage: RenderPageFn;
  zoomControl: ZoomControl | null;
}

const MOBILE_DEVICE_PATTERN = /iPhone|iPad|iPod|Android/i;

type Breakpoint = 'desktop' | 'tablet' | 'mobile';

function getBreakpoint(): Breakpoint {
  const w = window.innerWidth;
  if (w >= 1024) return 'desktop';
  if (w >= 768) return 'tablet';
  return 'mobile';
}

function isMobileDevice(): boolean {
  return MOBILE_DEVICE_PATTERN.test(navigator.userAgent) || navigator.maxTouchPoints > 0;
}

const CARD_METRICS: Record<Breakpoint, Record<CardType, CardSpec>> = {
  desktop: {
    text: { width: 220, height: 320, radius: 1500 },
    mini: { width: 201, height: 320, radius: 1500 },
    square: { width: 268, height: 320, radius: 1500 },
    wide: { width: 402, height: 320, radius: 1500 },
  },
  tablet: {
    text: { width: 200, height: 300, radius: 1400 },
    mini: { width: 185, height: 300, radius: 1400 },
    square: { width: 250, height: 300, radius: 1400 },
    wide: { width: 370, height: 300, radius: 1400 },
  },
  mobile: {
    text: { width: 180, height: 280, radius: 1200 },
    mini: { width: 180, height: 280, radius: 1200 },
    square: { width: 240, height: 280, radius: 1200 },
    wide: { width: 350, height: 280, radius: 1200 },
  },
};

/** 各断点视角参数：fov、旋转速度、行间距、行高 */
const BREAKPOINT_PARAMS: Record<Breakpoint, {
  fov: number;
  rotateSpeed: number;
  touchRotateSpeed: number;
  gap: number;
  rowHeight: number;
}> = {
  desktop: { fov: 75, rotateSpeed: -0.38, touchRotateSpeed: 0.0018, gap: 55, rowHeight: 420 },
  tablet:  { fov: 70, rotateSpeed: -0.30, touchRotateSpeed: 0.0020, gap: 60, rowHeight: 440 },
  mobile:  { fov: 62, rotateSpeed: -0.22, touchRotateSpeed: 0.0022, gap: 65, rowHeight: 450 },
};

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: CSS3DRenderer;
let controls: OrbitControls;
let currentCardsInScene: CSS3DObject[] = [];
let cardHitMeshes: THREE.Mesh[] = [];
let currentPage = 1;
let allMessages: Message[] = [];
let computedPages: PaginatedRows = [];
let zoomSliderEnabled = true;
let zoomControl: ZoomControl | null = null;
let updateMobileTouchOrbit: (() => void) | null = null;
let cardTemplate: HTMLElement | null = null;
let rendererContainer: HTMLElement | null = null;
let hitMeshResources: {
  geometry: THREE.PlaneGeometry;
  material: THREE.MeshBasicMaterial;
  cardType: CardType;
} | null = null;
let isAnimatingPage = false;

/** 图片真实宽高缓存（飞书字段可能缺失，默认 1000×1000），按消息 id 持久化，重建场景时回灌 */
const realDimensions = new Map<string, { width: number; height: number }>();
let dimensionRelayoutTimer: number | null = null;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getCardMetrics(cardType: CardType = 'text'): CardSpec {
  const bp = getBreakpoint();
  return CARD_METRICS[bp][cardType] || CARD_METRICS[bp].text;
}

interface PolaroidPadding {
  top: number;
  side: number;
  bottom: number;
}

/**
 * 拍立得卡片内边距，必须与 global.css 中 .msg-card--image 的
 * --polaroid-{top,side,bottom}-padding 在各断点下的取值一致，
 * 否则布局计算出的图片区宽高比会与实际渲染错位、产生留白。
 * 注意：触摸设备 body.is-mobile 规则特异性 (0,2,1) 高于 480/320
 * 断点下的普通类规则 (0,1,0)，因此触摸 ≤1024 时 13/13/65 优先生效。
 */
function getPolaroidPadding(): PolaroidPadding {
  const w = window.innerWidth;
  if (w <= 1024 && isMobileDevice()) return { top: 13, side: 13, bottom: 65 };
  if (w <= 320) return { top: 9, side: 10, bottom: 44 };
  if (w <= 480) return { top: 10, side: 12, bottom: 50 };
  return { top: 15, side: 15, bottom: 74 };
}

function ensureCardTemplate(): HTMLElement {
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

function createCardElement(message: Message, cardWidth?: number, cardHeight?: number): HTMLElement {
  const element = ensureCardTemplate().cloneNode(true) as HTMLElement;

  // 动态卡片尺寸（inline style 覆盖 CSS class 固定值）
  if (cardWidth && cardHeight) {
    element.style.width = `${cardWidth}px`;
    element.style.height = `${cardHeight}px`;
  }

  const textFaceEl = element.querySelector<HTMLElement>('[data-card-text-face]');
  const imageWrapEl = element.querySelector<HTMLElement>('[data-card-image-wrap]');
  const imageEl = element.querySelector<HTMLImageElement>('[data-card-image]');
  const imageAuthorEl = element.querySelector<HTMLElement>('[data-card-image-author]');
  const imageDateEl = element.querySelector<HTMLElement>('[data-card-image-date]');
  const authorEl = element.querySelector<HTMLElement>('[data-card-author]');
  const contentEl = element.querySelector<HTMLElement>('[data-card-content]');
  const dateEl = element.querySelector<HTMLElement>('[data-card-date]');
  const backfaceContentEl = element.querySelector<HTMLElement>('[data-card-backface-content]');
  const backfaceCopyEl = element.querySelector<HTMLElement>('[data-card-backface-copy]');

  const authorText = message.author || `user#${message.id}`;
  const dateText = message.date || '';

  if (authorEl) authorEl.textContent = authorText;
  if (imageAuthorEl) imageAuthorEl.textContent = authorText;
  if (contentEl) contentEl.textContent = message.content || '';
  if (dateEl) dateEl.textContent = dateText;
  if (imageDateEl) imageDateEl.textContent = dateText;

  if (backfaceContentEl instanceof HTMLElement) {
    backfaceContentEl.setAttribute('aria-label', `Message from ${authorText}`);
  }
  if (backfaceCopyEl) backfaceCopyEl.textContent = message.content || '';

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

    // 内边距与 generateLayout 的尺寸计算严格对齐（inline 变量覆盖样式表）
    const pad = getPolaroidPadding();
    element.style.setProperty('--polaroid-top-padding', `${pad.top}px`);
    element.style.setProperty('--polaroid-side-padding', `${pad.side}px`);
    element.style.setProperty('--polaroid-bottom-padding', `${pad.bottom}px`);

    imageEl.alt = `${message.author || 'Anonymous'} photo card`;

    // 图片加载失败重试 1 次，仍失败则回退文字模式
    let retried = false;
    imageEl.onerror = () => {
      if (!retried && message.imageUrl) {
        retried = true;
        // 加时间戳绕缓存重试
        const sep = message.imageUrl.includes('?') ? '&' : '?';
        imageEl.src = `${message.imageUrl}${sep}_retry=1`;
      } else {
        setTextMode();
      }
    };
    imageEl.onload = () => {
      element.classList.add('msg-card--image-loaded');

      // 飞书可能不返回真实宽高（默认 1000×1000），图片加载后按真实比例修正并重排
      const nw = imageEl.naturalWidth;
      const nh = imageEl.naturalHeight;
      if (!nw || !nh || !message.id) return;

      const stored = realDimensions.get(message.id);
      const ow = stored?.width || message.width || nw;
      const oh = stored?.height || message.height || nh;
      realDimensions.set(message.id, { width: nw, height: nh });

      if (ow > 0 && oh > 0 && Math.abs(nw / nh - ow / oh) > 0.02) {
        message.width = nw;
        message.height = nh;
        scheduleDimensionRelayout();
      }
    };
    imageEl.src = message.imageUrl || '';
  };

  element.dataset.messageId = message.id || '';
  const formatType = (message.format_type || 'text').toLowerCase() as CardType;

  if (message.hasImage && message.imageUrl) {
    setImageMode();
    if (formatType === 'square') element.classList.add('msg-card--square');
    else if (formatType === 'wide') element.classList.add('msg-card--wide');
    else element.classList.add('msg-card--mini');
  } else {
    setTextMode();
  }

  return element;
}

function getHitMeshResources(cardType: CardType = 'text') {
  if (hitMeshResources && hitMeshResources.cardType === cardType) {
    return hitMeshResources;
  }

  resetHitMeshResources();

  const { width, height } = getCardMetrics(cardType);
  hitMeshResources = {
    geometry: new THREE.PlaneGeometry(width, height),
    material: new THREE.MeshBasicMaterial({ visible: false }),
    cardType,
  };
  return hitMeshResources;
}

function resetHitMeshResources() {
  if (!hitMeshResources) return;
  hitMeshResources.geometry.dispose();
  hitMeshResources.material.dispose();
  hitMeshResources = null;
}

export function initUniverse(messages: Message[]): UniverseHandle {
  rendererContainer = document.getElementById('canvas-container');
  if (!rendererContainer) {
    throw new Error('Canvas container is missing.');
  }

  allMessages = messages;
  ensureCardTemplate();
  const bp = getBreakpoint();
  const isTouch = isMobileDevice();

  document.body.classList.remove('bp-desktop', 'bp-tablet', 'bp-mobile');
  document.body.classList.add(`bp-${bp}`);
  if (isTouch) document.body.classList.add('is-mobile');

  scene = new THREE.Scene();

  const fov = BREAKPOINT_PARAMS[bp].fov;
  const near = 0.5;
  const far = 10000;
  camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, near, far);

  // 相机置于圆心附近，用户站在中心向外看
  camera.position.set(0, 0, 100);

  renderer = new CSS3DRenderer();
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setSize(width, height);
  renderer.domElement.style.width = width + 'px';
  renderer.domElement.style.height = height + 'px';

  // iPad Retina 降级：缩放整个场景坐标系，规避 WebKit 4096px 单层内存限制
  if (isTouch && width >= 768) {
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

  rendererContainer.style.transformStyle = 'preserve-3d';
  rendererContainer.style.webkitTransformStyle = 'preserve-3d';
  rendererContainer.style.perspective = '1000px';
  rendererContainer.style.webkitPerspective = '1000px';

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enablePan = false;
  // 仅 1 张图片时禁用旋转（无旋转意义）
  const isSingleImage = messages.length <= 1;
  controls.enableRotate = !isSingleImage;
  controls.rotateSpeed = BREAKPOINT_PARAMS[bp].rotateSpeed; // 负值：第一人称转动手感
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;

  controls.target.set(0, 0, 0);

  if (isTouch) {
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: null as unknown as THREE.TOUCH,
    };
    controls.screenSpacePanning = false;
    controls.enabled = false;
    if (!isSingleImage) {
      setupMobileTouchOrbit(renderer.domElement, BREAKPOINT_PARAMS[bp].touchRotateSpeed);
    }
  }

  window.orbitControls = controls;
  window.refreshOrbitControls = refreshOrbitControls;

  setOrbitLimits();
  buildPageChunks(allMessages);
  renderPage(1);

  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('click', onDocumentClick);
  renderer.domElement.addEventListener('dblclick', onDocumentDoubleClick);

  window.setTimeout(() => {
    zoomControl = initZoomControl(camera);
    window.zoomControl = zoomControl;
    if (zoomControl && !zoomSliderEnabled) {
      zoomControl.disable();
    }
  }, 100);

  animate();

  return { scene, camera, renderer, controls, renderPage, zoomControl };
}

function setOrbitLimits() {
  // 水平 ±90° 半弧旋转，仰角限制在地平线 ±15°，防止看到"南/北极"
  controls.minPolarAngle = Math.PI / 2 - (Math.PI * 15) / 180;
  controls.maxPolarAngle = Math.PI / 2 + (Math.PI * 15) / 180;
  controls.minAzimuthAngle = -Math.PI / 2; // -90°
  controls.maxAzimuthAngle = Math.PI / 2;  // +90°
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

/** 半弧分页：按 sortOrder 升序排列，按分档规则逐行填充
 *  分档：1张→居中；2~4张→单行；5~29张→每行5张；≥30张→3行×10张
 *  填充顺序：第一行从左到右 → 第二行 → 第三行，严格顺序
 */
function buildPageChunks(messages: Message[]) {
  computedPages = [];
  if (!messages || messages.length === 0) return;

  // 按 sortOrder 升序排列
  const sortedMessages = [...messages].sort((a, b) => {
    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) return sa - sb;
    return new Date(b.timestamp || b.date || 0).getTime() - new Date(a.timestamp || a.date || 0).getTime();
  });

  // 回灌此前图片加载后探测到的真实宽高（轮询刷新/resize 重建时保持相框比例）
  sortedMessages.forEach((msg) => {
    const real = realDimensions.get(msg.id);
    if (real) {
      msg.width = real.width;
      msg.height = real.height;
    }
  });

  const bp = getBreakpoint();
  const metrics = CARD_METRICS[bp];

  // 分档规则确定每行数量
  const n = sortedMessages.length;
  let perRow: number;
  if (n <= 1) perRow = 1;
  else if (n <= 4) perRow = n; // 单行
  else if (n <= 15) perRow = 5; // 5~15 张：每行 5 张，3 行正好
  else if (n <= 30) perRow = Math.ceil(n / 3); // 16~30 张：均分 3 行（6~10 张/行）
  else perRow = 10; // >30 张：满页每行 10 张，单页 30 张

  const MAX_ROWS = 3;
  const PAGE_LIMIT = 30; // 单页固定上限 30 张

  // 按页切分
  for (let i = 0; i < sortedMessages.length; i += PAGE_LIMIT) {
    const pageSlice = sortedMessages.slice(i, i + PAGE_LIMIT);
    const rows: LayoutItem[][] = [];

    for (let r = 0; r < MAX_ROWS; r++) {
      const rowSlice = pageSlice.slice(r * perRow, (r + 1) * perRow);
      if (rowSlice.length === 0) break;

      const rowItems: LayoutItem[] = rowSlice.map((msg) => {
        const formatType = (msg.format_type || 'text').toLowerCase() as CardType;
        const spec = metrics[formatType] || metrics.mini;
        // 动态宽高初始用 spec 默认值，generateLayout 会按同行等高重算
        return {
          msg,
          angleWidth: 0, // generateLayout 中按实际宽高重算
          spec,
          formatType,
          cardWidth: spec.width,
          cardHeight: spec.height,
        };
      });
      rows.push(rowItems);
    }

    computedPages.push(rows);
  }
}

/** 移动端自定义触摸轨道：单指旋转 + 低通速度 + 拖拽/惯性阻尼 + 横纵方向判定 */
function setupMobileTouchOrbit(domElement: HTMLElement, rotateSpeed: number) {
  let lastX = 0;
  let lastY = 0;
  let isDragging = false;
  let isVerticalGesture = false;
  let gestureDirDecided = false;
  let startX = 0;
  let startY = 0;
  let orbitRadius = 0;
  let orbitTheta = 0;
  let orbitPhi = 0;
  let velocityTheta = 0;
  let velocityPhi = 0;

  const dragDamping = 0.72;
  const inertiaDamping = 0.9;
  const minVelocity = 0.00001;
  const DIRECTION_THRESHOLD = 8; // px：超过此距离才判定方向

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

  function onTouchStart(event: TouchEvent) {
    if (
      !controls ||
      event.touches.length !== 1 ||
      window.__zoomGestureActive ||
      document.body.classList.contains('reading-mode')
    )
      return;

    isDragging = true;
    gestureDirDecided = false;
    isVerticalGesture = false;
    startX = lastX = event.touches[0].clientX;
    startY = lastY = event.touches[0].clientY;
    syncSphericalState();
  }

  function onTouchMove(event: TouchEvent) {
    if (
      !isDragging ||
      event.touches.length !== 1 ||
      window.__zoomGestureActive ||
      document.body.classList.contains('reading-mode')
    )
      return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - lastX;
    const deltaY = touch.clientY - lastY;

    // 方向判定：位移超过阈值且未决定时，判断横纵主轴
    if (!gestureDirDecided) {
      const totalDx = Math.abs(touch.clientX - startX);
      const totalDy = Math.abs(touch.clientY - startY);
      if (totalDx > DIRECTION_THRESHOLD || totalDy > DIRECTION_THRESHOLD) {
        // 横向位移 > 纵向 2 倍 → 旋转；否则放行纵向滚动
        isVerticalGesture = totalDy > totalDx * 2;
        gestureDirDecided = true;
      }
    }

    if (isVerticalGesture) {
      // 纵向手势：不旋转，不阻止默认滚动
      lastX = touch.clientX;
      lastY = touch.clientY;
      return;
    }

    // 横向为主：阻止默认行为，驱动旋转
    velocityTheta = velocityTheta * 0.35 + deltaX * rotateSpeed * 0.65;
    velocityPhi = velocityPhi * 0.35 + deltaY * rotateSpeed * 0.65;

    lastX = touch.clientX;
    lastY = touch.clientY;

    event.preventDefault();
  }

  function onTouchEnd() {
    isDragging = false;
    gestureDirDecided = false;
    isVerticalGesture = false;
  }

  updateMobileTouchOrbit = () => {
    if (window.__zoomGestureActive || document.body.classList.contains('reading-mode')) return;
    if (Math.abs(velocityTheta) < minVelocity && Math.abs(velocityPhi) < minVelocity) return;

    orbitTheta += velocityTheta;
    orbitPhi += velocityPhi;

    const clampedTheta = Math.max(
      controls.minAzimuthAngle,
      Math.min(controls.maxAzimuthAngle, orbitTheta),
    );
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
}

export function getCurrentPage(): number {
  return currentPage;
}

export function getTotalPages(): number {
  return computedPages.length || 1;
}

export function enableZoomSlider(enabled: boolean) {
  zoomSliderEnabled = enabled;

  if (zoomControl) {
    if (enabled) {
      zoomControl.enable();
    } else {
      zoomControl.disable();
    }
  }
}

export function isZoomSliderEnabled(): boolean {
  return zoomSliderEnabled;
}

/**
 * 图片真实尺寸陆续到位后，合并为一次无动画重排，
 * 避免每张图 onload 都重建一次场景；翻页动画进行中则顺延。
 */
function scheduleDimensionRelayout() {
  if (dimensionRelayoutTimer !== null) return;
  dimensionRelayoutTimer = window.setTimeout(() => {
    dimensionRelayoutTimer = null;
    if (isAnimatingPage || computedPages.length === 0) {
      if (isAnimatingPage) scheduleDimensionRelayout();
      return;
    }
    buildPageChunks(allMessages);
    renderPage(currentPage, null, 0);
  }, 80);
}

function renderPage(
  page: number,
  nextMessages: Message[] | null = null,
  direction = 0,
) {
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

  const pageRows = computedPages[page - 1] || [[], [], []];

  // direction === 0：初始加载或 resize，无动画
  if (direction === 0 || oldCards.length === 0) {
    oldCards.forEach((obj) => scene.remove(obj));
    oldHitMeshes.forEach((mesh) => {
      scene.remove(mesh);
      mesh.geometry.dispose();
    });
    generateLayout(pageRows);
  } else {
    isAnimatingPage = true;
    animateOut(oldCards, oldHitMeshes, direction);
    generateLayout(pageRows);
    const newCards = currentCardsInScene;
    const newHitMeshes = cardHitMeshes;
    animateIn(newCards, newHitMeshes, direction);
  }

  const totalPages = getTotalPages();
  const pageInfo = document.getElementById('page-info');
  const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('next-btn') as HTMLButtonElement | null;

  if (pageInfo) pageInfo.innerText = `PAGE ${page} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page === 1;
  if (nextBtn) nextBtn.disabled = page === totalPages;
}

function animateOut(cards: CSS3DObject[], hitMeshes: THREE.Mesh[], direction: number) {
  const offset = direction * 2000;
  const duration = 1600;

  cards.forEach((card, i) => {
    const element = card.element as HTMLElement;
    element.style.pointerEvents = 'none';

    requestAnimationFrame(() => {
      createTween(card.position)
        .to({ y: card.position.y + offset }, duration)
        .easing(TWEEN.Easing.Cubic.In)
        .start();

      createTween({ opacity: 1 })
        .to({ opacity: 0 }, duration * 0.7)
        .onUpdate((obj) => {
          element.style.opacity = String(obj.opacity);
        })
        .onComplete(() => {
          scene.remove(card);
          const hitMesh = hitMeshes[i];
          if (hitMesh) {
            scene.remove(hitMesh);
            hitMesh.geometry.dispose();
          }
        })
        .start();
    });
  });
}

function animateIn(cards: CSS3DObject[], hitMeshes: THREE.Mesh[], direction: number) {
  const offset = direction * 2000;
  const duration = 2200; // 星团缓缓降落的史诗感
  let completedCount = 0;

  cards.forEach((card, i) => {
    card.position.y -= offset;
    (card.element as HTMLElement).style.opacity = '0';
    (card.element as HTMLElement).style.pointerEvents = 'none';
    const hitMesh = hitMeshes[i];
    if (hitMesh) hitMesh.position.y = card.position.y;
  });

  requestAnimationFrame(() => {
    cards.forEach((card, i) => {
      const targetY = card.position.y + offset;
      const element = card.element as HTMLElement;
      const hitMesh = hitMeshes[i];

      createTween(card.position)
        .to({ y: targetY }, duration)
        .easing(TWEEN.Easing.Quartic.Out)
        .onUpdate(() => {
          if (hitMesh) hitMesh.position.y = card.position.y;
        })
        .start();

      createTween({ opacity: 0 })
        .to({ opacity: 1 }, duration * 0.75)
        .onUpdate((obj) => {
          element.style.opacity = String(obj.opacity);
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

/** 把当页卡片摆到三行圆柱内壁的**正前方 180° 半弧**范围内。
 *  每行内卡片同行等高（以该行最高图片为基准等比缩放），
 *  按实际卡片宽高计算 angleWidth，每行在半弧内居中分布。
 *  不做随机旋转/交错偏移，保持行列整齐。
 */
function generateLayout(pageRows: PageRows) {
  const bp = getBreakpoint();
  const metrics = CARD_METRICS[bp];
  const radius = metrics.mini.radius;
  const ROW_HEIGHT = BREAKPOINT_PARAMS[bp].rowHeight;
  const GAPS = BREAKPOINT_PARAMS[bp].gap;

  const activeRows = pageRows.filter((r) => r.length > 0);
  const ROWS = activeRows.length || 1;

  /** 创建卡片并摆放到圆柱内壁指定角度+行号，使用动态宽高 */
  function placeCard(item: LayoutItem, theta: number, r: number) {
    const { msg, formatType, cardWidth, cardHeight } = item;
    const el = createCardElement(msg, cardWidth, cardHeight);
    const obj = new CSS3DObject(el);

    const y = ((ROWS - 1) / 2 - r) * ROW_HEIGHT;
    const x = radius * Math.sin(theta);
    const z = -radius * Math.cos(theta);

    obj.position.set(x, y, z);
    obj.lookAt(0, y, 0);

    scene.add(obj);
    currentCardsInScene.push(obj);

    // HitMesh 尺寸匹配动态卡片
    const { material } = getHitMeshResources(formatType);
    const geometry = new THREE.PlaneGeometry(cardWidth, cardHeight);
    const hitMesh = new THREE.Mesh(geometry, material);
    hitMesh.position.copy(obj.position);
    hitMesh.rotation.copy(obj.rotation);
    hitMesh.userData.originalCard = obj;
    scene.add(hitMesh);
    cardHitMeshes.push(hitMesh);
  }

  const pad = getPolaroidPadding();
  const BASE_CARD_H = metrics.mini.height;
  const imageAreaH = BASE_CARD_H - pad.top - pad.bottom;
  /** 统一视觉间距（px），相邻卡片边框之间的留白基准 */
  const VISUAL_GAP = GAPS;
  /** 视觉间距对应的圆心角 */
  const gapAngle = VISUAL_GAP / radius;
  const HALF_ARC = Math.PI / 2;

  // 计算每张卡片自身角宽（不含间距）
  activeRows.forEach((rowItems) => {
    rowItems.forEach((it) => {
      if (it.formatType === 'text' || !it.msg.hasImage) {
        it.cardHeight = BASE_CARD_H;
        it.cardWidth = it.spec.width;
      } else {
        const w = it.msg.width && it.msg.width > 0 ? it.msg.width : 1;
        const h = it.msg.height && it.msg.height > 0 ? it.msg.height : 1;
        it.cardHeight = BASE_CARD_H;
        it.cardWidth = Math.round(imageAreaH * (w / h) + pad.side * 2);
      }
      it.angleWidth = it.cardWidth / radius;
    });
  });

  /** 行总角宽（含间距）超过 180° 时整行等比缩小，返回缩放后的有效间距角 */
  function fitRowToHalfArc(rowItems: LayoutItem[]): number {
    const rn = rowItems.length;
    if (rn <= 1) return gapAngle;
    const cardsAngle = rowItems.reduce((s, it) => s + it.angleWidth, 0);
    const total = cardsAngle + (rn - 1) * gapAngle;
    if (total <= Math.PI) return gapAngle;
    const scale = Math.PI / total;
    rowItems.forEach((it) => {
      it.cardWidth = Math.max(1, Math.round(it.cardWidth * scale));
      it.cardHeight = Math.max(1, Math.round(it.cardHeight * scale));
      it.angleWidth *= scale;
    });
    return gapAngle * scale;
  }

  /** 顺序排布：每张卡片中心 = 前一张右边界 + 统一间距 + 自身半宽 */
  function placeRowSequentially(rowItems: LayoutItem[], rowIdx: number) {
    const rn = rowItems.length;
    if (rn === 0) return;
    if (rn === 1) {
      placeCard(rowItems[0], 0, rowIdx);
      return;
    }
    const effGap = fitRowToHalfArc(rowItems);
    const cardsAngle = rowItems.reduce((s, it) => s + it.angleWidth, 0);
    const totalAngle = cardsAngle + (rn - 1) * effGap;
    let pos = -totalAngle / 2;
    rowItems.forEach((item) => {
      const theta = pos + item.angleWidth / 2;
      const clampedTheta = Math.max(-HALF_ARC, Math.min(HALF_ARC, theta));
      placeCard(item, clampedTheta, rowIdx);
      pos += item.angleWidth + effGap;
    });
  }

  const allItems: LayoutItem[] = activeRows.flat();
  const n = allItems.length;

  // 仅 1 张卡片时居中正面
  if (n === 1) {
    placeCard(allItems[0], 0, 0);
    return;
  }

  // 多行：每行顺序排布，行内相邻卡片边框间距统一
  activeRows.forEach((rowItems, r) => {
    placeRowSequentially(rowItems, r);
  });
}

function pickCardAt(clientX: number, clientY: number): CSS3DObject | null {
  const rendererRect = renderer.domElement.getBoundingClientRect();
  const localX = clientX - rendererRect.left;
  const localY = clientY - rendererRect.top;

  if (localX < 0 || localX > rendererRect.width || localY < 0 || localY > rendererRect.height) {
    return null;
  }

  mouse.x = (localX / rendererRect.width) * 2 - 1;
  mouse.y = -(localY / rendererRect.height) * 2 + 1;
  if (mouse.x < -1 || mouse.x > 1 || mouse.y < -1 || mouse.y > 1) return null;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(cardHitMeshes);
  if (intersects.length === 0) return null;
  return intersects[0].object.userData.originalCard as CSS3DObject;
}

function onDocumentClick(event: MouseEvent) {
  if (document.body.classList.contains('lightbox-open')) {
    return;
  }

  event.preventDefault();

  const cardObj = pickCardAt(event.clientX, event.clientY);
  if (cardObj) {
    window.dispatchEvent(
      new CustomEvent('card-click', {
        detail: { object: cardObj, element: cardObj.element },
      }),
    );
  }
}

/** 双击圆柱中的卡片：第一次 click 已触发飞入，dblclick 再在其上唤起全屏灯箱 */
function onDocumentDoubleClick(event: MouseEvent) {
  event.preventDefault();

  const cardObj = pickCardAt(event.clientX, event.clientY);
  if (cardObj) {
    window.dispatchEvent(
      new CustomEvent('card-dblclick', {
        detail: { object: cardObj, element: cardObj.element },
      }),
    );
  }
}

function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const bp = getBreakpoint();
  const isTouch = isMobileDevice();

  // 同步断点 class（CSS 响应式选择器依赖）
  document.body.classList.remove('bp-desktop', 'bp-tablet', 'bp-mobile');
  document.body.classList.add(`bp-${bp}`);

  camera.aspect = width / height;
  camera.fov = BREAKPOINT_PARAMS[bp].fov;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  renderer.domElement.style.width = width + 'px';
  renderer.domElement.style.height = height + 'px';

  controls.rotateSpeed = BREAKPOINT_PARAMS[bp].rotateSpeed;
  // 单张图片时始终保持禁用旋转
  controls.enableRotate = allMessages.length > 1;

  if (isTouch && width >= 768) {
    scene.scale.set(0.5, 0.5, 0.5);
  } else {
    scene.scale.set(1.0, 1.0, 1.0);
  }

  resetHitMeshResources();
  buildPageChunks(allMessages);

  const totalPages = getTotalPages();
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  renderPage(currentPage);
}

function animate() {
  requestAnimationFrame(animate);
  TWEEN.update();
  if (typeof updateMobileTouchOrbit === 'function') updateMobileTouchOrbit();
  controls.update();
  renderer.render(scene, camera);
}
