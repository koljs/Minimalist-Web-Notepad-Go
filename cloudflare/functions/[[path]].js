// Minimalist Web Notepad - Cloudflare Pages Functions 后端(增强版)
// 对应原 Go 项目 main.go 的全部路由逻辑,存储改为 R2
//
// 路由设计(API 与页面路径分离,客户端渲染):
//   GET  /              → 生成随机串,302 重定向到 /<random>
//   GET  /<path>        → 返回静态 index.html(前端 JS 负责加载内容)
//   GET  /api/<path>    → 从 R2 读取,支持 ETag/304 协商缓存
//   POST /api/<path>    → 写入 R2;空内容则删除对象(受频率限制)
//   GET  /static/*      → 由 Pages 静态托管(不经过此 Function)
//
// 增强项:
//   - 路径白名单:仅允许 [A-Za-z0-9_-],拒绝特殊字符
//   - ETag/304:GET 命中客户端缓存时返回 304,省传输
//   - 频率限制:基于 Cache API 的单节点计数,POST 60 次/分钟

// R2 绑定名;需在 Cloudflare Dashboard 或 wrangler.toml 中配置为 NOTEPAD
const R2_BINDING = 'NOTEPAD';
// 随机串长度(对应原项目 -l 参数默认值)
const RANDOM_LENGTH = 10;
// 随机串字符集(与原项目 randomString 一致)
const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// 路径白名单:字母、数字、下划线、连字符(与随机串字符集兼容,且为常见 URL slug 规范)
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
// 频率限制:POST 每 IP 每窗口最大次数(正常轮询每秒最多 1 次,60 次/分钟不会误伤)
const RATE_LIMIT = 60;
// 频率限制窗口(秒)
const RATE_WINDOW = 60;

/**
 * Pages Functions 入口:匹配所有路径([[path]] splat)
 * @param {Object} context - { request, env, params, waitUntil }
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const method = request.method;

  // 仅允许 GET / POST,其余直接拒绝
  if (method !== 'GET' && method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 1) GET / → 生成随机串并重定向
  if (url.pathname === '/' && method === 'GET') {
    const random = generateRandomString(RANDOM_LENGTH);
    return Response.redirect(`${url.origin}/${random}`, 302);
  }

  // 解析 splat 参数(params.path 为数组或 undefined)
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const fullPath = segments.filter(Boolean).join('/');

  // 2) API 路径:/api/<key>
  if (fullPath.startsWith('api/')) {
    const key = fullPath.slice(4); // 去掉 'api/' 前缀

    // 路径白名单校验:拒绝空 key、含穿越字符、含非法字符
    if (!key || !KEY_PATTERN.test(key)) {
      return new Response('Bad Request', { status: 400 });
    }

    if (!env[R2_BINDING]) {
      return new Response('R2 binding not configured', { status: 500 });
    }
    const bucket = env[R2_BINDING];

    // GET /api/<key> → 读取 R2,支持 ETag/304 协商缓存
    if (method === 'GET') {
      const object = await bucket.get(key);
      if (!object) {
        // 对象不存在,返回空内容(无 ETag,不缓存)
        return new Response('', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const etag = object.httpEtag;
      const ifNoneMatch = request.headers.get('If-None-Match');

      // 客户端缓存命中 → 304(不读取 body,省传输)
      if (ifNoneMatch && etag && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            'ETag': etag,
            'Cache-Control': 'no-cache, must-revalidate',
          },
        });
      }

      // 正常返回内容 + ETag(允许浏览器缓存,但下次需协商)
      const body = await object.text();
      return new Response(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'ETag': etag || '',
          'Cache-Control': 'no-cache, must-revalidate',
        },
      });
    }

    // POST /api/<key> → 写入或删除 R2(受频率限制)
    if (method === 'POST') {
      // 频率限制检查(仅限写操作,避免误伤读取)
      const allowed = await checkRateLimit(request);
      if (!allowed) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': String(RATE_WINDOW) },
        });
      }

      const body = await request.text();

      // 空内容 → 删除对象(与原项目行为一致)
      if (body.length === 0) {
        await bucket.delete(key);
        return Response.json({ status: 'Success' });
      }

      await bucket.put(key, body);
      return Response.json({ status: 'Success' });
    }
  }

  // 3) 其他 GET 路径 → 返回 index.html(客户端渲染)
  //    通过 ASSETS 绑定获取 Pages 静态资源
  if (method === 'GET' && env.ASSETS) {
    const assetRequest = new Request(new URL('/index.html', url.origin));
    return env.ASSETS.fetch(assetRequest);
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * 频率限制:基于 Cache API 的单数据中心计数
 * 同一 IP 在 RATE_WINDOW 秒内最多 RATE_LIMIT 次 POST
 * 说明:Cache API 在同一 Cloudflare 数据中心内共享,故为单节点级限制;
 *       跨数据中心不共享,但对防止单点刷写足够,且无额外计费
 * @param {Request} request
 * @returns {Promise<boolean>} 是否允许
 */
async function checkRateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'anonymous';
  const cache = caches.default;
  // 用 .invalid 保留 TLD 构造内部 key,确保不与真实请求冲突
  const cacheKey = new Request(`https://rate-limit-internal.invalid/${ip}`, { method: 'GET' });

  let count = 0;
  const cached = await cache.match(cacheKey);
  if (cached) {
    count = parseInt(await cached.text(), 10) || 0;
  }
  count++;

  // 写回计数(覆盖式,重置 TTL 为 RATE_WINDOW)
  const counterResponse = new Response(String(count), {
    headers: { 'Cache-Control': `max-age=${RATE_WINDOW}` },
  });
  await cache.put(cacheKey, counterResponse.clone());

  return count <= RATE_LIMIT;
}

/**
 * 生成密码学安全随机字符串
 * 使用 Web Crypto API getRandomValues(对应原项目 randomString,但更安全)
 * @param {number} length
 * @returns {string}
 */
function generateRandomString(length) {
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  let result = '';
  for (let i = 0; i < length; i++) {
    // 用 uint32 取模,避免 byte 取模引入的字符分布偏差
    result += CHARSET[array[i] % CHARSET.length];
  }
  return result;
}
