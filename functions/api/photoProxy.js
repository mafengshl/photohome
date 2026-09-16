// Cloudflare Pages Function — /api/photoProxy
// 图片代理：前端 <img src="/api/photoProxy?token=xxx"> → 后端用
// tenant_access_token 从飞书 download API 拿图片二进制 → 转发给浏览器
// 解决飞书附件无法生成公网 URL 的问题

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

let tokenCache = { value: '', expireAt: 0 };

async function getTenantAccessToken(env) {
  const now = Date.now();
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

export async function onRequestGet({ request, env }) {
  const cors = {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  try {
    const url = new URL(request.url);
    const fileToken = url.searchParams.get('token');
    if (!fileToken) {
      return new Response(JSON.stringify({ error: 'missing token param' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const token = await getTenantAccessToken(env);

    // 从飞书 download API 获取图片二进制（302 重定向 → 跟随 → 拿二进制）
    const dlUrl = `${FEISHU_BASE}/drive/v1/medias/${fileToken}/download`;
    const feishuRes = await fetch(dlUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!feishuRes.ok) {
      return new Response(JSON.stringify({ error: `feishu download failed: ${feishuRes.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // 转发图片二进制给前端
    const contentType = feishuRes.headers.get('Content-Type') || 'image/jpeg';
    const cacheControl = feishuRes.headers.get('Cache-Control') || 'public, max-age=3600';

    return new Response(feishuRes.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        ...cors,
      },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    return new Response(JSON.stringify({ error: 'photoProxy failed', message: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
