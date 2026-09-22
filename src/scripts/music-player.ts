/**
 * 全局悬浮音乐播放器
 * - 横向腰形容器:歌名跑马灯 + 上/下一首 + 唱片(图片背景+中央图标)
 * - 唱片背景图随机取自飞书相册照片(/api/getPhotos)
 * - 静音自动播放 + 首次点击解除静音
 * - 歌单配置(本地数组,统一管理 src + name)
 * - 切歌带 100ms 淡入淡出 + 随机换封面(150ms 淡入淡出)
 * - 列表循环(默认) / 单曲循环
 * - 拖拽主体为整个容器,按下按钮不启动拖拽
 * - localStorage 记忆:播放/暂停、音量、当前位置、当前曲目索引、播放进度、封面索引
 */
import { fetchPage } from './api';

const STORAGE_KEY = 'music-player-state-v3';

interface MusicState {
  /** 是否在播放 */
  playing: boolean;
  /** 是否已解除静音 */
  unmuted: boolean;
  /** 音量 0..1 */
  volume: number;
  /** 当前曲目索引 */
  currentIndex: number;
  /** 当前曲目播放进度(秒) */
  currentTime: number;
  /** 循环模式:list=列表循环 / single=单曲循环 */
  loopMode: 'list' | 'single';
  /** 自由态下的左上角位置(px);null 表示未拖拽过 */
  x: number | null;
  y: number | null;
  /** 当前封面在 coverPool 中的索引;初始 -1 表示尚未选定 */
  coverIndex: number;
  /** 是否处于右侧贴边态;false 表示自由拖拽常显 */
  docked: boolean;
  /** 贴边态下的垂直位置(元素左上角 Y,px);null 表示默认垂直居中 */
  dockedY: number | null;
}

const DEFAULT_STATE: MusicState = {
  playing: true,
  unmuted: false,
  volume: 0.5,
  currentIndex: 0,
  currentTime: 0,
  loopMode: 'list',
  x: null,
  y: null,
  coverIndex: -1,
  docked: true,
  dockedY: null,
};

/** ============ 本地音乐歌单(自动识别) ============
 *  本地音乐文件夹:public/audio/
 *  使用方式:把 MP3 文件放入 public/audio/,启动 dev/build 即自动识别,无需改代码。
 *  vite plugin(astro.config.mjs)会扫描该文件夹生成 manifest.json,
 *  前端 fetch /audio/manifest.json 加载歌单;文件名(去扩展名)作为歌名。
 *  注意:
 *    - 文件名建议用英文/数字/中文,避免特殊字符(如 ? & % # 会被 encodeURIComponent 处理)
 *    - 单曲歌单会自动单曲循环;多首默认列表循环
 *    - 部署到 Cloudflare Pages:public/audio/ 下 MP3 作为静态资源部署,访问 /audio/xxx.mp3 直接生效
 */

/** 拖拽位移阈值(px),超过判定为拖拽而非点击 */
const DRAG_THRESHOLD = 6;

/** 切歌音频淡入淡出时长(ms) */
const FADE_DURATION = 100;

/** 封面切换淡入淡出时长(ms) */
const COVER_FADE_DURATION = 150;

/** 播放进度节流保存间隔(ms) */
const PROGRESS_SAVE_INTERVAL = 2000;

/** 吸附判定:播放器右边缘距屏幕右边界 ≤ 此值时松手吸附贴边(px) */
const EDGE_SNAP_THRESHOLD = 20;

/** 贴边动画完成后,PC 端隐藏倒计时(ms) */
const PC_HIDE_DELAY = 2000;

/** 贴边动画完成后,移动端隐藏倒计时(ms) */
const MOBILE_HIDE_DELAY = 5000;

/** transform 过渡时长(ms,与 CSS transition 对齐,用于兜底等待) */
const TRANSITION_DURATION = 320;

/** 判断是否为 PC 端(有 hover 能力且指针精细) */
function isDesktopDevice(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function initMusicPlayer(): void {
  const audioEl = document.getElementById('bgm-audio') as HTMLAudioElement | null;
  const playerEl = document.getElementById('music-player') as HTMLElement | null;
  if (!audioEl || !playerEl) return;

  const audio: HTMLAudioElement = audioEl;
  const player: HTMLElement = playerEl;

  // 子元素引用
  const vinylBtnQ = player.querySelector<HTMLButtonElement>('.music-player__vinyl-btn');
  const prevBtnQ = player.querySelector<HTMLButtonElement>('.music-player__btn--prev');
  const nextBtnQ = player.querySelector<HTMLButtonElement>('.music-player__btn--next');
  const trackInfoQ = player.querySelector<HTMLElement>('[data-track-info]');
  const trackWrapperQ = player.querySelector<HTMLElement>('[data-track-name-wrapper]');
  const trackNameQ = player.querySelector<HTMLElement>('[data-track-name]');
  const vinylImageQ = player.querySelector<HTMLElement>('[data-vinyl-image]');
  const vinylCenterQ = player.querySelector<HTMLElement>('[data-vinyl-center]');
  if (!vinylBtnQ || !prevBtnQ || !nextBtnQ || !trackInfoQ || !trackWrapperQ || !trackNameQ || !vinylImageQ || !vinylCenterQ) return;
  // 非 null 别名
  const vinylBtn: HTMLButtonElement = vinylBtnQ;
  const prevBtn: HTMLButtonElement = prevBtnQ;
  const nextBtn: HTMLButtonElement = nextBtnQ;
  const trackInfoEl: HTMLElement = trackInfoQ;
  const trackWrapperEl: HTMLElement = trackWrapperQ;
  const trackNameEl: HTMLElement = trackNameQ;
  const vinylImageEl: HTMLElement = vinylImageQ;
  const vinylCenterEl: HTMLElement = vinylCenterQ;
  const vinylIconElQ = player.querySelector<HTMLElement>('[data-vinyl-icon]');
  if (!vinylIconElQ) return;
  const vinylIconEl: HTMLElement = vinylIconElQ;

  // ---------- 飞书封面图池(异步填充) ----------
  /** 封面 URL 池(来自飞书照片 url 字段,已是 /api/photoProxy?token=xxx 格式) */
  let coverPool: string[] = [];

  // ---------- 运行时歌单(由 /audio/manifest.json 自动加载) ----------
  /** 运行时实际使用的歌单;初始为空,manifest 加载成功后填充 */
  let runtimePlaylist: ReadonlyArray<{ name: string; src: string }> = [];

  /** 取当前生效歌单 */
  function getPlaylist(): ReadonlyArray<{ name: string; src: string }> {
    return runtimePlaylist;
  }

  /** 异步加载 /audio/manifest.json(由 vite plugin 在 dev/build 时生成) */
  async function loadPlaylistFromManifest(): Promise<void> {
    try {
      const res = await fetch('/audio/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const list = (await res.json()) as Array<{ name: string; src: string }>;
      if (Array.isArray(list) && list.length > 0) {
        runtimePlaylist = list;
        // 边界保护:currentIndex 超出新歌单范围时重置到 0
        if (state.currentIndex >= runtimePlaylist.length) {
          state.currentIndex = 0;
          state.currentTime = 0;
        }
        // 重新加载当前曲目(让 src/name 同步到 manifest 版本)
        loadTrack(state.currentIndex, false);
        // 单曲/列表循环模式根据新歌单长度调整
        audio.loop = state.loopMode === 'single' || runtimePlaylist.length <= 1;
        saveState();
      }
    } catch {
      // manifest 拉取失败:runtimePlaylist 保持空,播放器显示但无歌可播
    }
  }

  async function loadCoverPool(): Promise<void> {
    try {
      const data = await fetchPage(1, 60);
      const urls = (data.photos ?? [])
        .map((p) => p.url)
        .filter((u): u is string => !!u && typeof u === 'string');
      if (urls.length > 0) {
        coverPool = urls;
        // 若尚未设置封面,立即随机选一张
        if (state.coverIndex < 0) {
          state.coverIndex = Math.floor(Math.random() * coverPool.length);
          applyCover(coverPool[state.coverIndex]);
        }
      }
    } catch {
      // 拉取失败:保持兜底纹理(已在 CSS 中设置)
    }
  }

  /** 应用封面 URL 到唱片图片层 */
  function applyCover(url: string): void {
    if (!url) return;
    // 预加载,避免淡入时白屏
    const img = new Image();
    img.onload = (): void => {
      vinylImageEl.style.backgroundImage = `url("${url}")`;
    };
    img.onerror = (): void => {
      // 加载失败:保持当前封面或兜底
    };
    img.src = url;
  }

  /** 随机切换封面(150ms 淡入淡出),避开当前索引 */
  function changeCoverRandom(): void {
    if (coverPool.length === 0) return;
    if (coverPool.length === 1) {
      state.coverIndex = 0;
      applyCover(coverPool[0]);
      return;
    }
    let next: number;
    do {
      next = Math.floor(Math.random() * coverPool.length);
    } while (next === state.coverIndex);
    state.coverIndex = next;
    // 淡出 → 换图 → 淡入
    vinylImageEl.style.opacity = '0';
    window.setTimeout(() => {
      applyCover(coverPool[next]);
      vinylImageEl.style.opacity = '1';
    }, COVER_FADE_DURATION);
  }

  // ---------- 状态加载 ----------
  const state: MusicState = { ...DEFAULT_STATE, ...loadState() };
  // 边界保护:运行时歌单可能为空(等 manifest 加载),currentIndex 留待 manifest 加载后重新检查
  if (state.currentIndex < 0) state.currentIndex = 0;
  if (state.coverIndex < -1) state.coverIndex = -1;
  audio.volume = state.volume;
  audio.muted = true;
  // 单曲/列表循环模式:manifest 加载后再根据歌单长度重新判定
  audio.loop = state.loopMode === 'single';

  // ---------- 贴边 / 自由 模式状态机 ----------
  /** 'docked'=右侧贴边;'free'=拖拽到中间常显 */
  let mode: 'docked' | 'free' = state.docked ? 'docked' : 'free';
  /** 贴边态下是否缩进隐藏(仅露 8px 边缘) */
  let isHidden = false;
  /** 隐藏倒计时(贴边动画完成后启动;PC 2s / 移动端 5s) */
  let hideTimer: number | null = null;
  /** transitionend 监听是否已触发(防重复) */
  let transitionHandler: ((e: TransitionEvent) => void) | null = null;
  /** transition 兜底定时器 */
  let transitionFallbackTimer: number | null = null;

  /** 取当前应使用的贴边垂直位置(元素左上角 Y) */
  function getDockedY(): number {
    if (state.dockedY !== null && state.dockedY >= 0) {
      // 边界保护:确保不超出视口
      const maxTop = Math.max(0, window.innerHeight - player.offsetHeight);
      return Math.min(state.dockedY, maxTop);
    }
    // 默认垂直居中
    return Math.max(0, (window.innerHeight - player.offsetHeight) / 2);
  }

  /** 切换到自由态:用当前视觉 rect 设置 inline left/top,避免跳动 */
  function setModeFree(): void {
    mode = 'free';
    state.docked = false;
    const rect = player.getBoundingClientRect();
    player.classList.remove('is-docked');
    player.classList.add('is-free');
    player.classList.remove('is-hidden');
    player.style.left = `${rect.left}px`;
    player.style.top = `${rect.top}px`;
    player.style.right = 'auto';
    player.style.bottom = 'auto';
    player.style.transform = '';
    isHidden = false;
    clearTimers();
  }

  /** 切换到贴边态:右侧固定,垂直跟随 dockedY,先完整显示再启动隐藏倒计时 */
  function setModeDocked(y: number): void {
    mode = 'docked';
    state.docked = true;
    state.dockedY = y;
    isHidden = false;
    clearTimers();

    // 先用 transform 记录当前偏移,避免切换定位时跳动
    const rect = player.getBoundingClientRect();
    const targetLeft = window.innerWidth - rect.width; // right:0 时的 left

    // 设置 inline transform 让元素视觉不动(仍在 rect.left)
    player.style.transform = `translateX(${rect.left - targetLeft}px)`;

    // 切换到 docked 定位
    player.classList.remove('is-free');
    player.classList.add('is-docked');
    player.classList.remove('is-hidden'); // 先完整显示
    player.style.left = '';
    player.style.top = `${y}px`;
    player.style.right = '0';
    player.style.bottom = '';

    // 强制 reflow,然后清除 inline transform 触发 CSS 过渡(translateX(0))
    void player.offsetWidth;
    player.style.transform = '';

    // 等贴边滑动动画(transform 过渡)完成,再启动隐藏倒计时
    waitForTransitionThenStartHideTimer();
  }

  /** 缩进隐藏或滑出显示(仅 docked 模式) */
  function setHidden(hidden: boolean): void {
    if (mode !== 'docked') return;
    isHidden = hidden;
    player.classList.toggle('is-hidden', hidden);
  }

  /** 弹出(滑出显示):取消倒计时 + 滑出 */
  function expand(): void {
    clearTimers();
    setHidden(false);
  }

  /** 监听 transform 过渡完成,再启动隐藏倒计时 */
  function waitForTransitionThenStartHideTimer(): void {
    // 清理上一次的监听
    if (transitionHandler) {
      player.removeEventListener('transitionend', transitionHandler);
      transitionHandler = null;
    }
    if (transitionFallbackTimer !== null) {
      clearTimeout(transitionFallbackTimer);
      transitionFallbackTimer = null;
    }

    let triggered = false;
    const onEnd = (): void => {
      if (triggered) return;
      triggered = true;
      if (transitionHandler) {
        player.removeEventListener('transitionend', transitionHandler);
        transitionHandler = null;
      }
      if (transitionFallbackTimer !== null) {
        clearTimeout(transitionFallbackTimer);
        transitionFallbackTimer = null;
      }
      // 贴边动画完成,启动隐藏倒计时(PC 2s / 移动端 5s)
      startHideTimer();
    };

    transitionHandler = (e: TransitionEvent): void => {
      if (e.propertyName !== 'transform') return;
      onEnd();
    };
    player.addEventListener('transitionend', transitionHandler);
    // 兜底:CSS 过渡 300ms + 20ms 缓冲,防止 transitionend 不触发
    transitionFallbackTimer = window.setTimeout(onEnd, TRANSITION_DURATION + 20);
  }

  /** 启动隐藏倒计时:到时缩进隐藏 */
  function startHideTimer(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    const delay = isDesktopDevice() ? PC_HIDE_DELAY : MOBILE_HIDE_DELAY;
    hideTimer = window.setTimeout(() => {
      setHidden(true);
    }, delay);
  }

  function clearTimers(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (transitionHandler) {
      player.removeEventListener('transitionend', transitionHandler);
      transitionHandler = null;
    }
    if (transitionFallbackTimer !== null) {
      clearTimeout(transitionFallbackTimer);
      transitionFallbackTimer = null;
    }
  }

  /** 移动端操作后重置隐藏倒计时(仅 docked 完整显示态) */
  function resetHideTimer(): void {
    if (mode !== 'docked' || isHidden) return;
    startHideTimer();
  }

  // 初始化模式:docked=true 用贴边(恢复 dockedY);否则自由态恢复保存坐标
  if (mode === 'docked') {
    player.classList.add('is-docked');
    player.style.top = `${getDockedY()}px`;
    // 初始即隐藏(页面加载默认贴边隐藏态)
    isHidden = true;
    player.classList.add('is-hidden');
  } else if (state.x !== null && state.y !== null) {
    player.classList.add('is-free');
    applyPosition(state.x, state.y);
  } else {
    // 无保存位置:回退到贴边隐藏态
    mode = 'docked';
    state.docked = true;
    player.classList.add('is-docked');
    player.style.top = `${getDockedY()}px`;
    isHidden = true;
    player.classList.add('is-hidden');
  }

  // 加载初始曲目 + 还原封面(若有保存的索引;否则等飞书数据回来再随机)
  loadTrack(state.currentIndex, false);
  syncPlayingClass();
  syncAriaPressed();
  // 异步加载自动识别的歌单;加载成功后重新加载当前曲目并更新 loop 模式
  void loadPlaylistFromManifest();
  // 启动封面拉取(异步,不阻塞 UI)
  void loadCoverPool();
  // 若已保存封面索引且仍在范围内,先恢复
  if (state.coverIndex >= 0) {
    // 等飞书数据回来后由 loadCoverPool 处理;此处先不预渲染避免索引错位
  }

  // ---------- 静音自动播放 ----------
  if (state.playing) {
    void audio.play().catch(() => {
      const retry = (): void => {
        if (state.playing) void audio.play().catch(() => {});
        document.removeEventListener('pointerdown', retry);
        document.removeEventListener('keydown', retry);
      };
      document.addEventListener('pointerdown', retry, { once: true, passive: true });
      document.addEventListener('keydown', retry, { once: true, passive: true });
    });
  }

  // ---------- 拖拽 + 点击区分 ----------
  let dragState:
    | {
        active: true;
        moved: boolean;
        startX: number;
        startY: number;
        startRect: DOMRect;
        startedDocked: boolean;
      }
    | { active: false } = { active: false };
  let justDragged = false;

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    const rect = player.getBoundingClientRect();
    dragState = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
      startedDocked: mode === 'docked',
    };
    // 按下时清除自动收回计时(操作保活)
    clearTimers();
    try {
      player.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragState.active) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      dragState.moved = true;
      player.classList.add('is-dragging');
      // 从贴边态开始拖拽:切换到自由态以便 inline left/top 生效,并刷新基准 rect
      if (dragState.startedDocked) {
        setModeFree();
        dragState.startRect = player.getBoundingClientRect();
      }
    }
    if (dragState.moved) {
      const newLeft = dragState.startRect.left + dx;
      const newTop = dragState.startRect.top + dy;
      applyPosition(newLeft, newTop);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragState.active) return;
    const wasMoved = dragState.moved;
    dragState = { active: false };
    if (wasMoved) {
      justDragged = true;
      window.setTimeout(() => {
        justDragged = false;
      }, 80);
      // 吸附判定:右边缘距屏幕右边界 ≤ 20px → 触发贴边(垂直跟随松手位置)
      const rect = player.getBoundingClientRect();
      const distToRight = window.innerWidth - rect.right;
      if (distToRight <= EDGE_SNAP_THRESHOLD) {
        setModeDocked(rect.top);
      }
      saveState();
    } else {
      // 未拖动:移动端贴边隐藏态下,点击容器弹出
      if (!isDesktopDevice() && mode === 'docked' && isHidden) {
        expand();
        // 弹出后启动隐藏倒计时(PC 不走此分支;移动端 5s)
        startHideTimer();
      }
    }
    player.classList.remove('is-dragging');
    try {
      player.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.stopPropagation();
  }

  function onContainerClick(e: MouseEvent): void {
    e.stopPropagation();
    if (justDragged) return;
  }

  // ---------- 播放/暂停 ----------
  async function togglePlay(): Promise<void> {
    // 首次点击解除静音(浏览器要求 user gesture 后才能 unmute)
    if (audio.muted) {
      audio.muted = false;
      state.unmuted = true;
      if (!state.volume || state.volume <= 0) state.volume = 0.5;
      audio.volume = state.volume;
    }
    // 真实播放/暂停:以 audio 实际状态为准,失败时 state.playing 不被推到 true
    // 否则下次点击会走 else 分支误判为"已播放"导致永远停在 ⏸
    if (audio.paused) {
      try {
        await audio.play();
        state.playing = true;
      } catch {
        // 自动播放策略 / 无有效 src 失败:保持暂停态
        state.playing = false;
      }
    } else {
      audio.pause();
      state.playing = false;
    }
    syncPlayingClass();
    syncAriaPressed();
    saveState();
    // 移动端操作后重置隐藏倒计时(仅 docked 完整显示态)
    if (!isDesktopDevice()) resetHideTimer();
  }

  function onVinylBtnKeydown(e: KeyboardEvent): void {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (document.body.classList.contains('lightbox-open')) return;
    e.preventDefault();
    e.stopPropagation();
    togglePlay();
  }

  // ---------- 切歌 + 淡入淡出 + 换封面 ----------
  function fadeVolume(from: number, to: number, duration: number): Promise<void> {
    return new Promise((resolve) => {
      const startTime = performance.now();
      const step = (now: number): void => {
        const t = Math.min(1, (now - startTime) / duration);
        audio.volume = from + (to - from) * t;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function switchTrack(delta: number): Promise<void> {
    const list = getPlaylist();
    if (list.length <= 1) {
      // 单曲歌单:仍然随机换封面,营造切换感
      changeCoverRandom();
      return;
    }
    const wasPlaying = !audio.paused;
    const targetVol = state.unmuted ? state.volume : 0;

    await fadeVolume(audio.volume, 0, FADE_DURATION);

    // 切歌同时随机换封面
    changeCoverRandom();

    state.currentIndex =
      (state.currentIndex + delta + list.length) % list.length;
    state.currentTime = 0;
    loadTrack(state.currentIndex, false);

    if (wasPlaying) {
      audio.volume = 0;
      try {
        await audio.play();
        await fadeVolume(0, targetVol, FADE_DURATION);
        state.playing = true;
      } catch {
        state.playing = false;
      }
    } else {
      audio.volume = targetVol;
      state.playing = false;
    }
    syncPlayingClass();
    syncAriaPressed();
    saveState();
    // 移动端切歌后重置隐藏倒计时
    if (!isDesktopDevice()) resetHideTimer();
  }

  function loadTrack(index: number, _autoplay: boolean): void {
    const track = getPlaylist()[index];
    if (!track) return;
    audio.src = track.src;
    audio.load();
    updateTrackName(track.name);
    const restoreTime = state.currentTime > 0 && state.currentIndex === index;
    const applyTime = (): void => {
      if (restoreTime && Number.isFinite(audio.duration) && state.currentTime < audio.duration) {
        try {
          audio.currentTime = state.currentTime;
        } catch {
          /* ignore */
        }
      }
      audio.removeEventListener('loadedmetadata', applyTime);
    };
    audio.addEventListener('loadedmetadata', applyTime, { once: true });
  }

  // ---------- 跑马灯 ----------
  function updateTrackName(name: string): void {
    // 切歌重置:清空容器、移除滚动 class,强制 reflow 让动画从 0 开始
    trackWrapperEl.innerHTML = '';
    trackWrapperEl.classList.remove('is-overflowing');
    trackInfoEl.classList.remove('is-overflowing');
    // 重置后重新填充文字
    trackNameEl.textContent = name;
    trackWrapperEl.appendChild(trackNameEl);
    // 强制 reflow,确保后续 class 添加能重新触发动画
    void trackWrapperEl.offsetWidth;
    // 判定溢出:文字实际宽度 > 歌名容器可见宽度
    const overflowed = trackNameEl.scrollWidth > trackInfoEl.clientWidth + 2;
    if (overflowed) {
      // 复制一份 span,配合 CSS translateX(-50%) 实现首尾无缝循环
      const span2 = document.createElement('span');
      span2.className = 'music-player__track-name';
      span2.setAttribute('aria-hidden', 'true');
      span2.textContent = name;
      trackWrapperEl.appendChild(span2);
      trackWrapperEl.classList.add('is-overflowing');
      trackInfoEl.classList.add('is-overflowing');
    }
  }

  // ---------- 位置 ----------
  function applyPosition(left: number, top: number): void {
    const margin = 8;
    const w = player.offsetWidth;
    const h = player.offsetHeight;
    const maxLeft = Math.max(margin, window.innerWidth - w - margin);
    const maxTop = Math.max(margin, window.innerHeight - h - margin);
    const clampedLeft = Math.max(margin, Math.min(maxLeft, left));
    const clampedTop = Math.max(margin, Math.min(maxTop, top));
    player.style.left = `${clampedLeft}px`;
    player.style.top = `${clampedTop}px`;
    player.style.right = 'auto';
    player.style.bottom = 'auto';
    state.x = clampedLeft;
    state.y = clampedTop;
  }

  function onResize(): void {
    if (mode === 'free' && state.x !== null && state.y !== null) {
      applyPosition(state.x, state.y);
    } else if (mode === 'docked') {
      // 贴边态:重新计算 dockedY 边界(横竖屏切换后视口高度变化)
      const y = getDockedY();
      player.style.top = `${y}px`;
    }
    const track = getPlaylist()[state.currentIndex];
    if (track) updateTrackName(track.name);
  }

  // ---------- UI 同步 ----------
  function syncPlayingClass(): void {
    player.classList.toggle('is-playing', state.playing);
    // 中央图标:▶ 暂停态 / ⏸ 播放态(写在内部 span 上,不破坏外层 flex 布局)
    vinylIconEl.textContent = state.playing ? '⏸' : '▶';
  }

  function syncAriaPressed(): void {
    vinylBtn.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    vinylBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }

  // ---------- 状态持久化 ----------
  function loadState(): MusicState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw) as Partial<MusicState>;
      return { ...DEFAULT_STATE, ...parsed };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  let saveTimer: number | null = null;
  function saveState(): void {
    state.volume = audio.volume;
    state.playing = !audio.paused;
    state.unmuted = !audio.muted;
    state.currentTime = audio.currentTime || 0;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  function scheduleProgressSave(): void {
    if (saveTimer !== null) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      saveState();
    }, PROGRESS_SAVE_INTERVAL);
  }

  // ---------- 事件绑定 ----------
  player.addEventListener('pointerdown', onPointerDown);
  player.addEventListener('pointermove', onPointerMove);
  player.addEventListener('pointerup', onPointerUp);
  player.addEventListener('pointercancel', onPointerUp);
  player.addEventListener('click', onContainerClick);
  player.addEventListener('contextmenu', (e) => e.preventDefault());
  player.addEventListener('selectstart', (e) => e.preventDefault());

  // ---------- PC 端:鼠标移入展开,移出后启动隐藏倒计时 ----------
  player.addEventListener('mouseenter', () => {
    if (!isDesktopDevice()) return;
    if (mode !== 'docked') return;
    // 倒计时过程中鼠标移入:立即终止倒计时并滑出
    expand();
  });
  player.addEventListener('mouseleave', () => {
    if (!isDesktopDevice()) return;
    if (mode !== 'docked') return;
    if (isHidden) return; // 已隐藏无需计时
    // 鼠标移出:启动隐藏倒计时(PC 2s)
    startHideTimer();
  });

  // ---------- 移动端:点击播放器外空白区域立即缩进隐藏 ----------
  document.addEventListener('pointerdown', (e) => {
    if (isDesktopDevice()) return;
    if (mode !== 'docked' || isHidden) return;
    const target = e.target as Node | null;
    if (target && player.contains(target)) return;
    // 点击外部:立即缩进隐藏并清计时
    clearTimers();
    setHidden(true);
  });

  vinylBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (justDragged) return;
    togglePlay();
  });
  vinylBtn.addEventListener('keydown', onVinylBtnKeydown);

  prevBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (justDragged) return;
    void switchTrack(-1);
  });
  nextBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (justDragged) return;
    void switchTrack(1);
  });

  audio.addEventListener('ended', () => {
    if (audio.loop) return;
    void switchTrack(1);
  });
  audio.addEventListener('timeupdate', scheduleProgressSave);
  audio.addEventListener('pause', saveState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!audio.paused && !audio.muted) audio.pause();
      saveState();
    } else if (state.playing && audio.paused && !audio.muted) {
      void audio.play().catch(() => {});
    }
  });
  window.addEventListener('beforeunload', saveState);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => {
    window.setTimeout(onResize, 120);
  });
}
