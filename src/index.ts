/**
 * RenTech — vahid Cloudflare Worker
 * ---------------------------------
 * Bir Worker həm site (static assets), həm API (/api/news), həm də bot (cron)
 * mesuliyyətini daşıyır.
 *
 *   GET  /api/news    → KV-dəki news.json, public
 *   PUT  /api/news    → admin bearer token ilə news.json-u yeniləyir
 *   POST /run         → admin token ilə botu əl ilə işə salır
 *   * (digər yollar)  → env.ASSETS-dən static fayl (index.html, admin.html və s.)
 *
 * Cron trigger hər 3 saatda botu işə salır (0 4,8,15 UTC = Bakı 08,12,19).
 */

import { XMLParser } from "fast-xml-parser";

// ─────────────────────────── AYARLAR ───────────────────────────

interface Menbe {
  url: string;
  ad: string;
  kateqoriya: string;
  suzgec: boolean;
  dil: "az" | "en" | "de";
}

const MENBELER: Menbe[] = [
  { url: "https://report.az/rss/", ad: "Report.az", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://az.trend.az/feeds/index.rss", ad: "Trend.az", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://apa.az/rss", ad: "APA", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://musavat.com/rss.xml", ad: "Müsavat", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://www.pv-magazine.com/feed/", ad: "pv magazine", kateqoriya: "Dünya", suzgec: false, dil: "en" },
  { url: "https://www.pv-magazine-usa.com/feed/", ad: "pv magazine USA", kateqoriya: "ABŞ", suzgec: false, dil: "en" },
  { url: "https://cleantechnica.com/feed/", ad: "CleanTechnica", kateqoriya: "ABŞ", suzgec: true, dil: "en" },
  { url: "https://www.pv-magazine.de/feed/", ad: "pv magazine Deutschland", kateqoriya: "Almaniya", suzgec: false, dil: "de" },
  { url: "https://www.pv-tech.org/feed/", ad: "PV Tech", kateqoriya: "Çin", suzgec: false, dil: "en" },
  { url: "https://www.energytrend.com/rss.xml", ad: "EnergyTrend", kateqoriya: "Çin", suzgec: false, dil: "en" },
  { url: "https://electrek.co/feed/", ad: "Electrek", kateqoriya: "Texnologiya", suzgec: true, dil: "en" },
  { url: "https://www.energy-storage.news/feed/", ad: "Energy Storage News", kateqoriya: "Texnologiya", suzgec: false, dil: "en" },
  { url: "https://news.mit.edu/topic/mitenergy-rss.xml", ad: "MIT News", kateqoriya: "Texnologiya", suzgec: false, dil: "en" },
];

const ACAR_SOZLER = [
  "günəş enerji", "günəş panel", "günəş elektrik", "fotovoltaik",
  "bərpa olunan", "yaşıl enerji", "alternativ enerji", "yaşıl keçid",
  "külək enerji", "külək elektrik", "günəş stansiya", "elektrik stansiyası",
  "enerji səmərəliliyi", "hidrogen", "yaşıl hidrogen", "batareya",
  "enerji anbarı", "elektromobil", "elektrik avtomobil", "elektroliz",
  "perovskit", "mikro şəbəkə", "ağıllı şəbəkə", "iqlim",
  "socar green", "masdar", "azərişıq", "azərenerji",
  "beoea", "bərpa olunan enerji üzrə agentlik",
  "yaşıl enerji zonası", "yaşıl dəhliz", "yaşıl enerji hövzəsi",
  "xızı-abşeron", "xızı abşeron", "bilasuvar günəş",
  "neftçala günəş", "zəngilan yaşıl", "qarabağ yaşıl",
  "cop29", "cop 29", "azərbaycan-mərkəzi asiya",
  "solar", "photovoltaic", "renewable", "wind power", "wind farm",
  "battery", "battery storage", "energy storage", "grid-scale",
  "utility-scale", "gigafactory", "perovskite", "tandem cell", "bifacial",
  "hydrogen", "green hydrogen", "electrolyzer", "electric vehicle",
  " ev ", "microgrid", "smart grid",
  "solarmodul", "energiewende", "wasserstoff", "batterie",
];

const DOVLET_ACARLARI = [
  "prezident", "ilham əliyev", "əliyev",
  "sərəncam", "fərman",
  "nazirlər kabineti", "hökumət qərarı",
  "energetika naziri", "energetika nazirliyi",
  "iqtisadiyyat naziri", "iqtisadiyyat nazirliyi",
  "ekologiya naziri", "ekologiya və təbii sərvətlər",
  "dövlət başçısı", "dövlət neft şirkəti",
  "socar", "azərişıq", "azərenerji",
];

const ENERJI_KONTEKST = [
  "enerji", "elektrik", "günəş", "külək", "hidrogen",
  "batareya", "yaşıl", "bərpa", "alternativ", "iqlim",
  "gigavat", "megavat", "mvt", "qvt", "kvt·s",
  "stansiya", "generasiya", "şəbəkə",
];

const MAKS_XEBER = 50;
const REDD_DEDUP_LIMIT = 150;
const MAKS_TERCUME = MAKS_XEBER;
const XULASE_UZUNLUGU = 260;
const KV_KEY = "news.json";

// ───────────────────────── TİPLƏR ──────────────────────────

interface Xeber {
  cat: string;
  date: string;
  title: string;
  excerpt: string;
  source: string;
  url: string;
  status: "derc" | "gozleyir" | "redd";
  tercume?: boolean;
  dercDate?: string;
  added?: string;
  edited?: boolean;
  _dil?: string;
}

interface NewsFile {
  _qeyd?: string;
  updated: string;
  items: Xeber[];
}

export interface Env {
  NEWS_KV: KVNamespace;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  ADMIN_TOKEN: string;
  GEMINI_MODEL?: string;
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  ADMIN_URL?: string;
}

// ───────────────────────── KÖMƏKÇİLƏR ──────────────────────────

function temizMetn(xam: string): string {
  if (!xam) return "";
  const metn = xam.replace(/<[^>]+>/g, " ");
  const decoded = metn
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return decoded.replace(/\s+/g, " ").trim();
}

function qisalt(metn: string, hedd: number = XULASE_UZUNLUGU): string {
  if (metn.length <= hedd) return metn;
  const kesilmis = metn.slice(0, hedd);
  const sonBosluq = kesilmis.lastIndexOf(" ");
  const parca = sonBosluq > 0 ? kesilmis.slice(0, sonBosluq) : kesilmis;
  return parca.replace(/[ ,.;:—-]+$/, "") + "…";
}

function tarixAl(giris: any): string {
  const kandidatlar = [giris.pubDate, giris.published, giris.updated, giris["dc:date"]];
  for (const t of kandidatlar) {
    if (!t) continue;
    const d = new Date(t);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function uygundur(baslıq: string, xulase: string, menbe?: Menbe): boolean {
  const metn = (baslıq + " " + xulase).toLowerCase();
  if (ACAR_SOZLER.some((s) => metn.includes(s))) return true;
  if (menbe && menbe.dil === "az") {
    if (
      DOVLET_ACARLARI.some((s) => metn.includes(s)) &&
      ENERJI_KONTEKST.some((s) => metn.includes(s))
    ) {
      return true;
    }
  }
  return false;
}

function normalBaslıq(b: string): string {
  return b.toLowerCase().replace(/[^a-zəğıöşüçA-ZƏĞIİÖŞÜÇ0-9]+/g, "").slice(0, 80);
}

// ─────────────────────────── RSS ───────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  isArray: (name) => name === "item" || name === "entry",
});

function itemleriCix(parsed: any): any[] {
  if (parsed?.rss?.channel?.item) return parsed.rss.channel.item;
  if (parsed?.feed?.entry) return parsed.feed.entry;
  if (parsed?.["rdf:RDF"]?.item) return parsed["rdf:RDF"].item;
  return [];
}

function metnAl(deyer: any): string {
  if (deyer == null) return "";
  if (typeof deyer === "string") return deyer;
  if (typeof deyer === "object") {
    if (deyer.__cdata) return String(deyer.__cdata);
    if (deyer["#text"]) return String(deyer["#text"]);
    if (deyer["@_href"]) return String(deyer["@_href"]);
  }
  return String(deyer);
}

function linkAl(giris: any): string {
  if (typeof giris.link === "string") return giris.link.trim();
  if (giris.link && typeof giris.link === "object") {
    if (Array.isArray(giris.link)) {
      const alt = giris.link.find((l: any) => l["@_rel"] === "alternate" || !l["@_rel"]);
      if (alt) return String(alt["@_href"] || "").trim();
    }
    if (giris.link["@_href"]) return String(giris.link["@_href"]).trim();
    if (giris.link["#text"]) return String(giris.link["#text"]).trim();
  }
  if (giris.guid && typeof giris.guid === "string" && /^https?:/.test(giris.guid)) {
    return giris.guid.trim();
  }
  return "";
}

async function lentiOxu(menbe: Menbe): Promise<Xeber[]> {
  try {
    const cavab = await fetch(menbe.url, {
      headers: { "User-Agent": "RenTechBot/1.0 (+https://rentech.az)" },
      cf: { cacheTtl: 300 },
    });
    if (!cavab.ok) {
      console.log(`  → ${menbe.ad} … XƏTA (HTTP ${cavab.status})`);
      return [];
    }
    const xml = await cavab.text();
    const parsed = xmlParser.parse(xml);
    const items = itemleriCix(parsed);

    const netice: Xeber[] = [];
    for (const giris of items) {
      const baslıq = temizMetn(metnAl(giris.title));
      const link = linkAl(giris);
      if (!baslıq || !link) continue;

      const xulase = temizMetn(
        metnAl(giris.description ?? giris.summary ?? giris.content ?? giris["content:encoded"] ?? ""),
      );
      if (menbe.suzgec && !uygundur(baslıq, xulase, menbe)) continue;

      const status: Xeber["status"] = menbe.dil === "az" ? "derc" : "gozleyir";
      const yeni: Xeber = {
        cat: menbe.kateqoriya,
        date: tarixAl(giris),
        title: baslıq,
        excerpt: xulase ? qisalt(xulase) : "",
        source: menbe.ad,
        url: link,
        status,
        _dil: menbe.dil,
      };
      if (status === "derc") {
        yeni.dercDate = new Date().toISOString();
      }
      netice.push(yeni);
    }
    console.log(`  → ${menbe.ad} … ${netice.length} uyğun xəbər`);
    return netice;
  } catch (xeta: any) {
    console.log(`  → ${menbe.ad} … XƏTA (${xeta?.message || xeta})`);
    return [];
  }
}

// ─────────────────────────── TƏRCÜMƏ ───────────────────────────

const TERCUME_TAPSIRIGI = `Sən enerji sahəsi üzrə peşəkar tərcüməçisən.
Aşağıdakı xəbər başlıqlarını və xülasələrini Azərbaycan dilinə tərcümə et.
Mətnlər müxtəlif dillərdə (əsasən ingilis və alman) ola bilər — mənbə dilini özün müəyyən et.

Qaydalar:
- Texniki terminləri Azərbaycan enerji sahəsində işlənən formada saxla:
  inverter, string, fotovoltaik, kVt, MVt, QVt, kVt·s, TVt·s, şəbəkə, batareya.
- Şirkət, ölkə və layihə adlarını tərcümə etmə, olduğu kimi saxla.
- Rəqəmləri dəyişmə. Onluq ayırıcı kimi vergül işlət (25,5%).
- Başlıq qısa və xəbər dilində olsun, şüar kimi yazma.
- Əlavə şərh, izah və ya fikir yazma — yalnız tərcümə.

Cavabı YALNIZ bu formatda JSON massivi kimi qaytar:
[{"i": 0, "title": "...", "excerpt": "..."}, ...]

Tərcümə ediləcək xəbərlər:
`;

async function geminiTercume(xeberler: Xeber[], env: Env): Promise<void> {
  if (!xeberler.length) return;
  if (!env.GEMINI_API_KEY) {
    console.log("  (GEMINI_API_KEY yoxdur — tərcümə edilmədi)");
    return;
  }

  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const giris = xeberler.map((x, i) => ({ i, title: x.title, excerpt: x.excerpt }));
  const sorgu = {
    contents: [{ parts: [{ text: TERCUME_TAPSIRIGI + JSON.stringify(giris, null, 1) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };
  const unvan = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  let netice: any = null;
  for (let cehd = 1; cehd <= 3; cehd++) {
    try {
      const cavab = await fetch(unvan, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sorgu),
      });
      if (!cavab.ok) {
        const metn = await cavab.text();
        if ([429, 500, 502, 503, 504].includes(cavab.status) && cehd < 3) {
          console.log(`  (cəhd ${cehd}: HTTP ${cavab.status} — 10 sn gözləyirəm)`);
          await new Promise((r) => setTimeout(r, 10000 * cehd));
          continue;
        }
        console.log(`  (tərcümə alınmadı: HTTP ${cavab.status} — ${metn.slice(0, 200)})`);
        return;
      }
      const data: any = await cavab.json();
      const metn = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!metn) throw new Error("Boş cavab");
      netice = JSON.parse(metn);
      break;
    } catch (xeta: any) {
      console.log(`  (tərcümə alınmadı: ${xeta?.message || xeta})`);
      if (cehd >= 3) return;
    }
  }
  if (!Array.isArray(netice)) return;

  let sayğac = 0;
  for (const sətir of netice) {
    try {
      const n = Number(sətir.i);
      if (n >= 0 && n < xeberler.length && sətir.title) {
        xeberler[n].title = temizMetn(sətir.title);
        if (sətir.excerpt) xeberler[n].excerpt = qisalt(temizMetn(sətir.excerpt));
        xeberler[n].tercume = true;
        sayğac++;
      }
    } catch {
      continue;
    }
  }
  console.log(`  ${sayğac} xəbər tərcümə olundu`);
}

// ─────────────────────────── ntfy ──────────────────────────

async function ntfyGonder(yeniGozleyen: Xeber[], env: Env): Promise<void> {
  if (!env.NTFY_TOPIC || !yeniGozleyen.length) return;

  const server = env.NTFY_SERVER || "https://ntfy.sh";
  const adminUrl = env.ADMIN_URL || "https://rentech.az/admin.html";
  const say = yeniGozleyen.length;

  const ölkələr = new Map<string, number>();
  for (const x of yeniGozleyen) {
    const k = x.cat || "?";
    ölkələr.set(k, (ölkələr.get(k) || 0) + 1);
  }
  const bölgü = [...ölkələr.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  const setirler: string[] = [`${say} yeni xəbər təsdiq gözləyir`, ""];
  setirler.push(bölgü);
  setirler.push("");
  for (const x of yeniGozleyen.slice(0, 3)) {
    setirler.push(`• [${x.cat || "?"}] ${(x.title || "").slice(0, 80)}`);
  }
  if (say > 3) setirler.push(`...və ${say - 3} xəbər daha`);

  const yuk = {
    topic: env.NTFY_TOPIC,
    title: `RenTech: ${say} yeni xəbər`,
    message: setirler.join("\n"),
    click: adminUrl,
    tags: ["newspaper"],
    priority: 3,
  };
  try {
    const cavab = await fetch(server, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(yuk),
    });
    if (!cavab.ok) throw new Error(`HTTP ${cavab.status}`);
    console.log(`ntfy bildirişi göndərildi (${say} xəbər)`);
  } catch (xeta: any) {
    console.log(`  (ntfy göndərilmədi: ${xeta?.message || xeta})`);
  }
}

// ─────────────────────────── ƏSAS BOT ──────────────────────────

async function kohnəniYuklə(env: Env, origin?: string): Promise<Xeber[]> {
  const xam = await env.NEWS_KV.get(KV_KEY);
  if (xam) {
    try {
      const data = JSON.parse(xam) as NewsFile;
      return data.items || [];
    } catch {
      // xarab JSON — aşağıda seed
    }
  }
  // KV boşdur (ilk işə salma) — static news.json-dan seed et
  try {
    if (origin) {
      const cavab = await fetch(`${origin}/news.json`, { cf: { cacheTtl: 0 } });
      if (cavab.ok) {
        const data = (await cavab.json()) as NewsFile;
        console.log(`  (KV boş idi — ${data.items?.length || 0} xəbər static news.json-dan seed olundu)`);
        return data.items || [];
      }
    }
  } catch {}
  return [];
}

async function botIsle(env: Env, origin?: string): Promise<void> {
  console.log("RenTech xəbər botu işə düşdü");

  const kohne = await kohnəniYuklə(env, origin);
  const kohneLinkler = new Set(kohne.map((x) => x.url));
  const kohneBasliqlar = new Set(kohne.map((x) => normalBaslıq(x.title || "")));

  const yenilər: Xeber[] = [];
  for (const menbe of MENBELER) {
    const b = await lentiOxu(menbe);
    yenilər.push(...b);
  }

  const təzə: Xeber[] = [];
  const görülənLink = new Set<string>();
  const görülənBaslıq = new Set<string>();
  for (const x of yenilər) {
    const b = normalBaslıq(x.title);
    if (
      kohneLinkler.has(x.url) ||
      kohneBasliqlar.has(b) ||
      görülənLink.has(x.url) ||
      görülənBaslıq.has(b)
    ) {
      continue;
    }
    görülənLink.add(x.url);
    görülənBaslıq.add(b);
    təzə.push(x);
  }
  console.log(`\nYeni xəbər: ${təzə.length}`);

  const hamısı = [...kohne, ...təzə];
  let aktiv = hamısı.filter((x) => x.status !== "redd");
  let redd = hamısı.filter((x) => x.status === "redd");

  const sıralaAcar = (x: Xeber) => x.dercDate || x.date || "";
  aktiv.sort((a, b) => (sıralaAcar(a) < sıralaAcar(b) ? 1 : -1));
  redd.sort((a, b) => (sıralaAcar(a) < sıralaAcar(b) ? 1 : -1));

  aktiv = aktiv.slice(0, MAKS_XEBER);
  redd = redd.slice(0, REDD_DEDUP_LIMIT);

  const tercumeOlunacaq = aktiv
    .filter((x) => x.status === "gozleyir" && !x.tercume)
    .slice(0, MAKS_TERCUME);
  if (tercumeOlunacaq.length) {
    console.log(`Tərcümə olunur (${tercumeOlunacaq.length}):`);
    await geminiTercume(tercumeOlunacaq, env);
  }

  for (const x of [...aktiv, ...redd]) {
    delete x._dil;
  }

  const gozleyen = aktiv.filter((x) => x.status === "gozleyir").length;
  const yazılacaq: NewsFile = {
    _qeyd:
      "status sahəsi: 'derc' — saytda görünür, 'gozleyir' — təsdiq gözləyir, 'redd' — saytda gizli.",
    updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    items: [...aktiv, ...redd],
  };

  await env.NEWS_KV.put(KV_KEY, JSON.stringify(yazılacaq, null, 2));
  console.log(
    `\nKV yazıldı — ${aktiv.length} aktiv (${gozleyen} təsdiq gözləyir), ${redd.length} rədd dedup üçün.`,
  );

  const kohneUrl = new Set(kohne.map((x) => x.url));
  const yeniGozleyen = aktiv.filter((x) => x.status === "gozleyir" && !kohneUrl.has(x.url));
  if (yeniGozleyen.length) {
    await ntfyGonder(yeniGozleyen, env);
  }
}

// ─────────────────────── API HANDLERS ─────────────────────────

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function checkAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token) && token === env.ADMIN_TOKEN;
}

async function apiGetNews(env: Env, request: Request): Promise<Response> {
  const xam = await env.NEWS_KV.get(KV_KEY);
  if (xam) {
    try {
      const data = JSON.parse(xam);
      return jsonResp(data);
    } catch {
      // xarab — aşağıda seed
    }
  }
  // KV hələ boşdur — /news.json-dan qayıt
  try {
    const url = new URL(request.url);
    url.pathname = "/news.json";
    const assetResp = await env.ASSETS.fetch(new Request(url.toString()));
    if (assetResp.ok) {
      const data = await assetResp.json();
      return jsonResp(data);
    }
  } catch {}
  return jsonResp({
    _qeyd:
      "status sahəsi: 'derc' — saytda görünür, 'gozleyir' — təsdiq gözləyir, 'redd' — saytda gizli.",
    updated: new Date().toISOString().slice(0, 16).replace("T", " "),
    items: [],
  });
}

async function apiPutNews(env: Env, request: Request): Promise<Response> {
  if (!checkAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: "keçərsiz JSON" }, 400);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    return jsonResp({ error: "`items` massivi tələb olunur" }, 400);
  }
  for (const x of body.items) {
    if (!x || typeof x !== "object") return jsonResp({ error: "xəbər elementi obyekt deyil" }, 400);
    if (typeof x.url !== "string" || !x.url) return jsonResp({ error: "url boşdur" }, 400);
    if (typeof x.title !== "string") return jsonResp({ error: "title mətn deyil" }, 400);
  }
  body.updated = new Date().toISOString().slice(0, 16).replace("T", " ");
  await env.NEWS_KV.put(KV_KEY, JSON.stringify(body, null, 2));
  return jsonResp({ ok: true, count: body.items.length, updated: body.updated });
}

// ─────────────────────── WORKER HANDLER ───────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron zamanı origin bilinmir — env.ADMIN_URL-dən götür
    const adminUrl = env.ADMIN_URL || "https://rentech.az/admin.html";
    let origin: string | undefined;
    try {
      origin = new URL(adminUrl).origin;
    } catch {}
    ctx.waitUntil(botIsle(env, origin));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // API /api/news
    if (url.pathname === "/api/news") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method === "GET") return apiGetNews(env, request);
      if (request.method === "PUT") return apiPutNews(env, request);
      return jsonResp({ error: "method not allowed" }, 405);
    }

    // Manual bot trigger
    if (url.pathname === "/run" && request.method === "POST") {
      if (!checkAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401);
      await botIsle(env, url.origin);
      return jsonResp({ ok: true });
    }

    // Digər hər şey — static asset
    return env.ASSETS.fetch(request);
  },
};
