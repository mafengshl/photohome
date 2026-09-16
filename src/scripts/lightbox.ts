// 全屏灯箱（目标站没有的增量功能）：大图浏览 + 左右切换 + "n / total" 计数
// + ESC/方向键 + 触屏滑动 + 点击背景关闭。与飞入阅读模式并存。
import type { Message } from './types';

export interface Lightbox {
  open: (messages: Message[], startId: string) => void;
  close: () => void;
  isOpen: () => boolean;
  setMessages: (messages: Message[]) => void;
}

const SWIPE_THRESHOLD = 48;

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
  const authorEl = document.getElementById('lightbox-author');
  const dateEl = document.getElementById('lightbox-date');
  const counterEl = document.getElementById('lightbox-count') as HTMLElement;
  const prevBtn = document.getElementById('lightbox-prev') as HTMLButtonElement;
  const nextBtn = document.getElementById('lightbox-next') as HTMLButtonElement;
  const closeBtn = document.getElementById('lightbox-close') as HTMLButtonElement;

  // 全局照片顺序：与圆柱布局一致（时间倒序），仅含图片卡
  let photos: Message[] = [];
  let index = 0;
  let openState = false;
  let touchStartX: number | null = null;

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

  function open(messages: Message[], startId: string) {
    photos = photoOrder(messages);
    if (photos.length === 0) return;

    const found = photos.findIndex((m) => m.id === startId);
    index = found >= 0 ? found : 0;

    openState = true;
    document.body.classList.add('lightbox-open');
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    render(0);

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
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    imgEl.removeAttribute('src');
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

  imgEl.addEventListener('click', (e) => e.stopPropagation());

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
