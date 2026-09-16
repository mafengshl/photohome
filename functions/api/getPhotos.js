// ===========================================================================
// Cloudflare Pages Function — /api/getPhotos
// 安全代理层：所有飞书开放 API 调用都在此完成，密钥仅来自环境变量，
// 浏览器前端永远拿不到飞书凭证，只能拿到此处整理后的图片 JSON。
// ===========================================================================
//
// 职责：
//  1. 获取并缓存 tenant_access_token（模块级缓存，复用 isolate 热实例）
//  2. 分页拉取飞书多维表格全部记录（单次最多 500 条，按 page_token 翻页）
//  3. 抽取字段：图片附件、title、desc、photo_time
//  4. 调用 batch_get_tmp_download_url 把 file_token 转换为公网可访问的临时链接
//  5. 整理、按拍摄时间倒序、按客户端分页参数切片返回
//  6. 全量列表短缓存（默认 30s），降低轮询时对飞书的请求压力
//  7. CORS 跨域与异常捕获
// ===========================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ---------- 模块级缓存（warm isolate 内复用） ----------
let tokenCache = { value: '', expireAt: 0 };
let listCache = { data: null, fetchedAt: 0, total: 0 };
let wikiAppTokenCache = { value: '', expireAt: 0 };

// ---------- 工具：读取必填环境变量 ----------
function getEnv(env) {
  const required = {
    FEISHU_APP_ID: env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: env.FEISHU_APP_SECRET,
    FEISHU_BITABLE_TABLE_ID: env.FEISHU_BITABLE_TABLE_ID,
  };
  // app_token 必填，除非用 wiki node token 自动解析
  const hasWikiToken = env.FEISHU_WIKI_NODE_TOKEN || '';
  const hasAppToken = env.FEISHU_BITABLE_APP_TOKEN || '';
  if (!hasWikiToken && !hasAppToken) {
    required.FEISHU_BITABLE_APP_TOKEN = '';
  }
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(', ')}`);
  }
  return {
    ...required,
    FEISHU_BITABLE_APP_TOKEN: hasAppToken,
    // Wiki 节点 token：设置后自动解析为多维表格 app_token（wiki 链接场景）
    wikiNodeToken: hasWikiToken,
    // 字段名允许自定义，默认按中文
    fieldImage: env.PHOTO_FIELD_IMAGE || '图片',
    fieldTitle: env.PHOTO_FIELD_TITLE || 'title',
    fieldDesc: env.PHOTO_FIELD_DESC || 'desc',
    fieldTime: env.PHOTO_FIELD_TIME || 'photo_time',
    fieldSortOrder: env.PHOTO_FIELD_SORT_ORDER || 'sort_order',
    cacheTtl: parseInt(env.PHOTO_CACHE_TTL || '30', 10),
    pageSize: parseInt(env.PHOTO_PAGE_SIZE || '30', 10),
  };
}

// ---------- CORS 头 ----------
function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

// ---------- 飞书：获取 tenant_access_token（带缓存） ----------
async function getTenantAccessToken(env) {
  const now = Date.now();
  // 提前 5 分钟刷新，避免边界过期
  if (tokenCache.value && tokenCache.expireAt - now > 5 * 60 * 1000) {
    return tokenCache.value;
  }
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${JSON.stringify(data)}`);
  }
  tokenCache = {
    value: data.tenant_access_token,
    expireAt: now + (data.expire || 7200) * 1000,
  };
  return tokenCache.value;
}

// ---------- 飞书：Wiki 节点 token → 多维表格 app_token（带缓存） ----------
async function resolveWikiAppToken(env, token) {
  const now = Date.now();
  if (wikiAppTokenCache.value && wikiAppTokenCache.expireAt - now > 0) {
    return wikiAppTokenCache.value;
  }
  const url = new URL(`${FEISHU_BASE}/wiki/v2/spaces/get_node`);
  url.searchParams.set('token', env.wikiNodeToken);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code && data.code !== 0) {
    throw new Error(`Wiki get_node error: ${data.code} ${data.msg}`);
  }
  const appToken = data?.data?.node?.obj_token;
  if (!appToken) {
    throw new Error('Wiki node has no obj_token (app_token)');
  }
  // wiki 解析结果缓存 10 分钟（token 不会变）
  wikiAppTokenCache = { value: appToken, expireAt: now + 10 * 60 * 1000 };
  return appToken;
}

// ---------- 飞书：列出多维表格记录（自动翻页，单次最多 500 条） ----------
async function listAllRecords(env, token) {
  const records = [];
  let pageToken;
  let total = 0;
  do {
    const url = new URL(
      `${FEISHU_BASE}/bitable/v1/apps/${env.FEISHU_BITABLE_APP_TOKEN}/tables/${env.FEISHU_BITABLE_TABLE_ID}/records`,
    );
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code && data.code !== 0) {
      throw new Error(`Bitable list error: ${data.code} ${data.msg}`);
    }
    const items = data?.data?.items || [];
    records.push(...items);
    total = data?.data?.total ?? records.length;
    pageToken = data?.data?.has_more ? data?.data?.page_token : undefined;
  } while (pageToken);
  return { records, total };
}

// ---------- 整理一条记录为前端可用的照片对象 ----------
// 不再调用飞书 batch_get_tmp_download_url(临时链接有时效、无法 CDN 缓存),
// 直接用 file_token 构造 /api/photoProxy?token=xxx —— photoProxy 后端拿 token
// 从飞书 download API 拉图片二进制转发,前端 URL 稳定、可被 Cloudflare CDN 强缓存。
function normalizeRecord(env, record) {
  const fields = record.fields || {};
  const attachments = fields[env.fieldImage];
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const first = attachments[0];
  if (!first?.file_token) return null;

  const fileToken = first.file_token;
  const url = `/api/photoProxy?token=${fileToken}`;

  // 标题 / 描述：飞书多行文本字段返回 [{type:'text', text:'...'}]
  const title = pickText(fields[env.fieldTitle]);
  const desc = pickText(fields[env.fieldDesc]);
  // 日期字段：毫秒时间戳
  const photoTime = pickTime(fields[env.fieldTime]);
  // 排序序号字段：数字类型，越小越靠前
  const sortOrder = typeof fields[env.fieldSortOrder] === 'number'
    ? fields[env.fieldSortOrder]
    : (typeof fields[env.fieldSortOrder] === 'string' ? Number(fields[env.fieldSortOrder]) || 0 : 0);

  return {
    id: record.record_id,
    title: title || '',
    desc: desc || '',
    photoTime: photoTime || 0,
    sortOrder,
    fileToken,
    url,
    width: first.width || 1000,
    height: first.height || 1000,
    type: first.type || 'image/jpeg',
  };
}

function pickText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.name || ''))
      .join('');
  }
  if (v.text) return v.text;
  return '';
}

function pickTime(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

// ---------- 获取整理后的全量照片列表（带短缓存） ----------
// refresh=true 时跳过内存缓存，强制从飞书拉最新数据
async function getAllPhotos(env, refresh = false) {
  const now = Date.now();
  const ttl = env.cacheTtl * 1000;
  if (!refresh && listCache.data && now - listCache.fetchedAt < ttl) {
    return listCache.data;
  }
  const token = await getTenantAccessToken(env);

  // Wiki 链接场景：自动解析 node token → app_token
  if (env.wikiNodeToken) {
    const appToken = await resolveWikiAppToken(env, token);
    env = { ...env, FEISHU_BITABLE_APP_TOKEN: appToken };
  }

  const { records, total } = await listAllRecords(env, token);

  // 不再调 batch_get_tmp_download_url —— 直接从 file_token 构造 /api/photoProxy URL。
  // photoProxy 后端自己拿 token 从飞书 download API 拉二进制，URL 稳定可缓存。
  const photos = records
    .map((r) => normalizeRecord(env, r))
    .filter(Boolean)
    // 拍摄时间倒序（未知时间靠后）
    .sort((a, b) => (b.photoTime || 0) - (a.photoTime || 0));

  listCache = { data: photos, fetchedAt: now, total };
  return photos;
}

// ===========================================================================
// 入口
// ===========================================================================

// 处理 CORS 预检
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders({ headers: new Headers() }) });
}

// GET /api/getPhotos?page=1&pageSize=30&refresh=1
export async function onRequestGet({ request, env }) {
  const cors = corsHeaders(request);
  try {
    const url = new URL(request.url);
    const refresh = url.searchParams.get('refresh') === '1';

    // 本地预览 mock：显式设置 MOCK_PHOTOS=1 时返回 placeholder 图片，
    // 无需飞书密钥即可看到完整布局/交互效果。生产环境不设该变量，不受影响。
    if (env.MOCK_PHOTOS === '1' || env.MOCK_PHOTOS === 1) {
      const all = mockPhotos();
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const pageSize = Math.min(
        200,
        Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10)),
      );
      const start = (page - 1) * pageSize;
      const slice = all.slice(start, start + pageSize);
      const cacheControl = refresh
        ? 'no-store'
        : 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800';
      return json(
        { photos: slice, total: all.length, page, pageSize, hasMore: start + slice.length < all.length },
        200,
        { ...cors, 'Cache-Control': cacheControl },
      );
    }

    const envCfg = getEnv(env);
    const all = await getAllPhotos(envCfg, refresh);

    // 客户端分页
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(url.searchParams.get('pageSize') || String(envCfg.pageSize), 10)),
    );
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);

    const cacheControl = refresh
      ? 'no-store'
      : 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800';

    return json(
      {
        photos: slice,
        total: all.length,
        page,
        pageSize,
        hasMore: start + slice.length < all.length,
      },
      200,
      { ...cors, 'Cache-Control': cacheControl },
    );
  } catch (err) {
    const msg = err?.message || String(err);
    return json({ error: 'getPhotos failed', message: msg }, 502, cors);
  }
}

// ===========================================================================
// 本地预览 mock 数据（仅在 MOCK_PHOTOS=1 时使用）
// 用 picsum.photos 的 seed 图作 placeholder，混合横/竖/方比例，
// 便于本地无飞书密钥时直观看到错落拼贴、灯箱、轮询追加等全部交互。
// ===========================================================================
function mockPhotos() {
  const seeds = [
    'mountain', 'river', 'sunset', 'forest', 'ocean', 'desert', 'city',
    'flower', 'snow', 'lake', 'valley', 'cloud', 'wave', 'tree', 'bird',
    'star', 'dune', 'mist', 'aurora', 'canyon', 'reef', 'glacier',
  ];
  // 混合比例：横、竖、方，模拟真实照片墙
  const ratios = [
    [1600, 900], [1200, 1600], [1400, 1050], [1600, 1067], [1080, 1440],
    [1280, 960], [1500, 1000], [1024, 1365], [1600, 1200], [1440, 1920],
    [1800, 1200], [1200, 800],
  ];
  const now = Date.now();
  return seeds.map((s, i) => {
    const [w, h] = ratios[i % ratios.length];
    return {
      id: `mock-${s}`,
      title: `Sample ${i + 1}`,
      desc: '',
      photoTime: now - i * 3600_000,
      fileToken: `mock-token-${s}`,
      // mock 数据用 picsum 外链,不走 photoProxy(本地调试无飞书密钥时用)
      url: `https://picsum.photos/seed/${s}/${w}/${h}`,
      width: w,
      height: h,
      type: 'image/jpeg',
    };
  });
}
