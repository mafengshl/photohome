// 与 /api/getPhotos 通信：分页拉取 + 轮询新增
import type { PhotosResponse, Photo } from './types';

/** 轮询间隔（毫秒）：检测飞书表格新增图片，自动追加 */
const POLL_INTERVAL_MS = 30_000;
/** 每页条数 */
export const PAGE_SIZE = 30;
/** 首次加载失败时的退避上限 */
const MAX_RETRY = 3;

/** 拼接接口地址，允许自定义参数 */
function buildUrl(params: Record<string, string | number | boolean>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const base = '/api/getPhotos';
  return q.toString() ? `${base}?${q.toString()}` : base;
}

/** 拉取某一页照片 */
export async function fetchPage(page: number, pageSize = PAGE_SIZE, signal?: AbortSignal): Promise<PhotosResponse> {
  const res = await fetch(buildUrl({ page, pageSize }), {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`getPhotos ${res.status}`);
  }
  const data = (await res.json()) as PhotosResponse;
  return data;
}

/**
 * 简单的轮询器：每隔 POLL_INTERVAL_MS 拉取第 1 页，
 * 把尚未出现的照片（按 id 去重）通过回调交回去，实现“接近实时”追加。
 */
export function startPolling(
  onNew: (newPhotos: Photo[]) => void,
  onIdle?: () => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const data = await fetchPage(1, PAGE_SIZE * 2); // 多拉一些，覆盖轮询窗口内新增
      onNew(data.photos ?? []);
    } catch {
      // 轮询失败不打扰用户，静默跳过
    } finally {
      onIdle?.();
      if (!stopped) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  // 标签页隐藏时跳过一次，节省请求；可见时立即补一次
  const onVisibility = () => {
    if (!document.hidden && !stopped) {
      if (timer) window.clearTimeout(timer);
      tick();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // 首次稍延迟启动，避开首屏加载高峰
  timer = window.setTimeout(tick, POLL_INTERVAL_MS);

  // 返回取消函数
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** 带重试的首页加载 */
export async function fetchFirstWithRetry(): Promise<PhotosResponse> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRY; i++) {
    try {
      return await fetchPage(1);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}
