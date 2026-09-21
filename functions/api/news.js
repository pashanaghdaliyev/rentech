/**
 * /api/news — RenTech xəbərləri
 *
 *   GET  /api/news             → public, KV-dəki news.json faylını qaytarır
 *   PUT  /api/news             → admin, bearer token ilə news.json-u yeniləyir
 *   POST /api/news/hard-delete → admin, seçilmiş URL-ləri tamamilə silir (dedup üçün redd saxlanmır)
 *
 * Bindinglər (Cloudflare Pages → Settings → Functions):
 *   KV binding: NEWS_KV
 *   Secret:     ADMIN_TOKEN  (uzun random sətir — admin panel bu ilə auth olur)
 */

const KV_KEY = "news.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
      ...extra,
    },
  });
}

function unauthorized(msg = "unauthorized") {
  return json({ error: msg }, 401);
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function serverError(msg) {
  return json({ error: msg }, 500);
}

function checkAuth(request, env) {
  const admin = env.ADMIN_TOKEN;
  if (!admin) return false;
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token && token === admin;
}

async function readNews(env, request) {
  const xam = await env.NEWS_KV.get(KV_KEY);
  if (xam) {
    try {
      return JSON.parse(xam);
    } catch {
      // KV-də xarab JSON — aşağıda static fallback-a düşür
    }
  }
  // KV hələ seed edilməyibsə (birinci deploy) — Pages-in static news.json-una qayıt
  if (env.ASSETS && request) {
    try {
      const url = new URL(request.url);
      url.pathname = "/news.json";
      const assetResp = await env.ASSETS.fetch(new Request(url.toString()));
      if (assetResp.ok) {
        return await assetResp.json();
      }
    } catch {
      // sonuncu fallback aşağıda
    }
  }
  return {
    _qeyd:
      "status sahəsi: 'derc' — saytda görünür, 'gozleyir' — təsdiq gözləyir, 'redd' — saytda gizli.",
    updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    items: [],
  };
}

async function writeNews(env, data) {
  data.updated = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (!Array.isArray(data.items)) data.items = [];
  await env.NEWS_KV.put(KV_KEY, JSON.stringify(data, null, 2));
  return data;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env, request }) {
  const data = await readNews(env, request);
  // Public GET — token lazım deyil
  return json(data);
}

export async function onRequestPut({ request, env }) {
  if (!checkAuth(request, env)) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("keçərsiz JSON");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    return badRequest("`items` massivi tələb olunur");
  }

  // Sadə validasiya — hər xəbərdə url və title olmalıdır
  for (const x of body.items) {
    if (!x || typeof x !== "object") return badRequest("xəbər elementi obyekt deyil");
    if (typeof x.url !== "string" || !x.url) return badRequest("url boşdur");
    if (typeof x.title !== "string") return badRequest("title mətn deyil");
  }

  const saved = await writeNews(env, body);
  return json({ ok: true, count: saved.items.length, updated: saved.updated });
}
