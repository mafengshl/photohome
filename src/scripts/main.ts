// 客户端主入口：星空生成 → 拉全量 /api/getPhotos → Photo 映射为 Message
// → 初始化 3D 宇宙与交互 → 30s 轮询，有新增时重新布局
import { initUniverse, type RenderPageFn } from './universe';
import { setupInteractions } from './interactions';
import { createLightbox, type Lightbox } from './lightbox';
import { generatePetals } from './petals';
import { getTestPhotos } from './test-data';
import { fetchFirstWithRetry, fetchPage, startPolling, PAGE_SIZE } from './api';
import type { Photo, Message, CardType } from './types';

/** ============ 数据模式开关 ============
 *  true  → 使用内置测试图片集（35 张，调试翻页/边界场景，不调接口）
 *  false → 使用飞书接口数据（正式部署模式）
 *  切换后重新 build 即可生效，不影响 Cloudflare Functions 与接口调用
 */
const USE_TEST_DATA = false;

/** 生成 150 颗随机闪烁的星星（与目标站一致） */
function generateStarfield(): void {
  const starfield = document.getElementById('starfield');
  if (!starfield) return;

  for (let i = 0; i < 150; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    const size = Math.random() * 3 + 1;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.animationDuration = `${Math.random() * 3 + 2}s`;
    star.style.animationDelay = `${Math.random() * 5}s`;
    starfield.appendChild(star);
  }
}

/** 依据宽高比推导卡片形态：竖图 mini / 方图 square / 横图 wide */
function deriveFormatType(width: number, height: number): Exclude<CardType, 'text'> {
  if (width > 0 && height > 0) {
    const ratio = height / width;
    if (ratio >= 1.2) return 'mini';
    if (ratio <= 1 / 1.2) return 'wide';
  }
  return 'square';
}

/** 飞书 Photo → 3D 宇宙 Message */
function mapPhotoToMessage(photo: Photo): Message {
  const hasImage = Boolean(photo.url);
  const timestamp =
    photo.photoTime && photo.photoTime > 0 ? new Date(photo.photoTime).toISOString() : undefined;

  // 宽高缺失时默认 square（飞书附件字段可能不返回 width/height）
  const w = photo.width || 1000;
  const h = photo.height || 1000;

  return {
    id: photo.id,
    author: photo.title?.trim() || 'Anonymous',
    content: photo.desc?.trim() || '',
    date: timestamp ? timestamp.slice(0, 10) : '',
    timestamp,
    sortOrder: photo.sortOrder ?? 0,
    image_url: hasImage ? photo.url : undefined,
    imageUrl: hasImage ? photo.url : undefined,
    hasImage,
    format_type: hasImage ? deriveFormatType(w, h) : 'text',
    width: w,
    height: h,
  };
}

function updateMessageCounter(count: number): void {
  const counter = document.getElementById('total-count');
  if (counter) counter.textContent = String(count);
}

/** 分页拉取全部照片（测试模式下直接返回内置数据） */
async function loadAllMessages(): Promise<Message[]> {
  if (USE_TEST_DATA) {
    return getTestPhotos().map(mapPhotoToMessage);
  }

  const first = await fetchFirstWithRetry();
  const photos: Photo[] = [...(first.photos ?? [])];

  let page = 2;
  let hasMore = first.hasMore;
  while (hasMore) {
    const data = await fetchPage(page, PAGE_SIZE);
    photos.push(...(data.photos ?? []));
    hasMore = data.hasMore;
    page += 1;
  }

  return photos.map(mapPhotoToMessage);
}

function signatureOf(ids: string[]): string {
  return ids.join(',');
}

export function initApp(): void {
  generateStarfield();
  generatePetals();
  updateMessageCounter(0);

  const arcContainer = document.getElementById('planet-arc');
  const exitBtn = document.getElementById('exit-btn');

  if (!(exitBtn instanceof HTMLButtonElement)) {
    return;
  }

  let renderPage: RenderPageFn | null = null;
  let lastSignature = '';
  let currentMessages: Message[] = [];
  let lightbox: Lightbox | null = null;

  const openLightboxById = (messageId: string) => {
    if (!lightbox) return;
    lightbox.open(currentMessages, messageId);
  };

  // 双击圆柱中的图片卡直接开全屏灯箱
  window.addEventListener('card-dblclick', ((e: Event) => {
    const detail = (e as CustomEvent).detail as { element?: HTMLElement };
    const id = detail.element?.dataset.messageId;
    if (id) openLightboxById(id);
  }) as EventListener);

  // 阅读模式下点放大按钮开全屏灯箱
  window.addEventListener('open-lightbox', ((e: Event) => {
    const detail = (e as CustomEvent).detail as { messageId?: string };
    if (detail.messageId) openLightboxById(detail.messageId);
  }) as EventListener);

  (async () => {
    let messages: Message[] = [];
    try {
      messages = await loadAllMessages();
    } catch {
      // 接口失败时仍渲染空宇宙（星空/山丘照常展示）
      messages = [];
    }

    updateMessageCounter(messages.length);
    lastSignature = signatureOf(messages.map((m) => m.id));
    currentMessages = messages;

    const universe = initUniverse(messages);
    renderPage = universe.renderPage;

    setupInteractions(
      universe.camera,
      universe.controls,
      arcContainer,
      exitBtn,
      universe.renderPage,
    );

    lightbox = createLightbox();
  })();

  // 30s 轮询：首页快照变化（有新增）时重新拉全量并回到第 1 页
  // 测试数据模式下跳过轮询（无接口调用）
  if (!USE_TEST_DATA) startPolling((fresh: Photo[]) => {
    if (!renderPage) return;

    const nextSig = signatureOf(fresh.map((p) => p.id));
    if (nextSig === lastSignature) return;
    lastSignature = nextSig;

    loadAllMessages()
      .then((nextMessages) => {
        if (!renderPage) return;
        lastSignature = signatureOf(nextMessages.map((m) => m.id));
        updateMessageCounter(nextMessages.length);
        currentMessages = nextMessages;
        renderPage(1, nextMessages);
        lightbox?.setMessages(nextMessages);
      })
      .catch(() => {
        // 静默失败，等下一轮
      });
  });
}
