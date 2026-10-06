/**
 * RenTech — vahid Cloudflare Worker
 * ---------------------------------
 * Bir Worker həm site (static assets), həm API (/api/news), həm də bot (cron)
 * mesuliyyətini daşıyır.
 *
 *   GET  /api/news    → KV-dəki news.json, public
 *   PUT  /api/news    → admin bearer token ilə news.json-u yeniləyir
 *   POST /run         → admin token ilə botu əl ilə işə salır
 *   POST /run?dry=1   → test: AI qərarlarını və seçimi qaytarır, KV-yə yazmır
 *   * (digər yollar)  → env.ASSETS-dən static fayl (index.html, admin.html və s.)
 *
 * Cron trigger botu gündə bir dəfə işə salır (0 4 UTC = Bakı 08:00).
 *
 * Son 24 saatın xəbərləri Gemini-dən keçir: mövzuya uyğunluq + önəm balı (1–10).
 * Uyğunlardan gündə 7 xəbər dərc olunur — 2 yerli + 5 xarici, önəm və təzəlik üzrə.
 * Dərc olunanların tarixi dərc günüdür (Bakı vaxtı). Gemini cavab verməsə heç nə dərc olunmur.
 */

import { XMLParser } from "fast-xml-parser";

// ─────────────────────────── AYARLAR ───────────────────────────

interface Menbe {
  url: string;
  ad: string;
  kateqoriya: string;
  suzgec: boolean;
  dil: "az" | "en" | "de";
  // Bing News RSS vasitəsilə oxunur (sayt öz lentini botlara bağlayıb).
  // Bing linkləri yönləndirmədir — orijinal URL "url" parametrindən çıxarılır.
  bingNews?: boolean;
}

const MENBELER: Menbe[] = [
  { url: "https://report.az/rss/", ad: "Report.az", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://az.trend.az/feeds/index.rss", ad: "Trend.az", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://apa.az/rss", ad: "APA", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://musavat.com/rss.xml", ad: "Müsavat", kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
  { url: "https://www.pv-magazine.com/feed/", ad: "pv magazine", kateqoriya: "Dünya", suzgec: false, dil: "en" },
  { url: "https://www.pv-magazine-usa.com/feed/", ad: "pv magazine USA", kateqoriya: "ABŞ", suzgec: false, dil: "en" },
  // cleantechnica.com/feed/ Cloudflare bot qoruması ilə 403 qaytarır; Google News isə Workers IP-lərinə 503
  { url: "https://www.bing.com/news/search?q=site%3acleantechnica.com&format=rss", ad: "CleanTechnica", kateqoriya: "ABŞ", suzgec: true, dil: "en", bingNews: true },
  { url: "https://www.pv-magazine.de/feed/", ad: "pv magazine Deutschland", kateqoriya: "Almaniya", suzgec: false, dil: "de" },
  { url: "https://www.pv-tech.org/feed/", ad: "PV Tech", kateqoriya: "Çin", suzgec: false, dil: "en" },
  { url: "https://www.energytrend.com/rss.xml", ad: "EnergyTrend", kateqoriya: "Çin", suzgec: false, dil: "en" },
  { url: "https://electrek.co/feed/", ad: "Electrek", kateqoriya: "Texnologiya", suzgec: true, dil: "en" },
  { url: "https://www.energy-storage.news/feed/", ad: "Energy Storage News", kateqoriya: "Texnologiya", suzgec: false, dil: "en" },
  { url: "https://news.mit.edu/topic/mitenergy-rss.xml", ad: "MIT News", kateqoriya: "Texnologiya", suzgec: false, dil: "en" },
  // Standart təyin edən və təlim/sertifikat verən qurumlar
  { url: "https://standards.ieee.org/feed/", ad: "IEEE Standards Association", kateqoriya: "Standart və təlim", suzgec: false, dil: "en" },
  { url: "https://www.solarenergy.org/feed/", ad: "Solar Energy International", kateqoriya: "Standart və təlim", suzgec: false, dil: "en" },
  { url: "https://irecusa.org/feed/", ad: "IREC", kateqoriya: "Standart və təlim", suzgec: false, dil: "en" },
  { url: "https://www.nabcep.org/feed/", ad: "NABCEP", kateqoriya: "Standart və təlim", suzgec: false, dil: "en" },
];

// Açar söz süzgəci yalnız ucuz ilkin seçimdir — son qərarı Gemini verir (geminiYoxla).

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
  "microgrid", "smart grid",
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
const YOXLAMA_QRUPU = 20; // bir Gemini sorğusunda neçə xəbər
// Bir işə düşmədə ən çox neçə xəbər yoxlanılır. Workers pulsuz planında bir çağırışda
// 50 xarici sorğu limiti var: ~18 RSS + 4 qrup × 3 cəhd + təkrar tərcümə — limitdən aşağı qalır.
const MAKS_YOXLAMA = YOXLAMA_QRUPU * 4;
const TEZE_SAAT = 24; // yalnız son bu qədər saatda çıxan xəbərlər namizəddir
const GUNLUK_YERLI = 2; // gündə dərc olunan Azərbaycan xəbərləri
const GUNLUK_XARICI = 5; // gündə dərc olunan xarici xəbərlər
const BAKI_FERQ_SAAT = 4; // UTC+4
const GORULEN_KEY = "seen.json"; // artıq yoxlanmış URL-lər (təkrar yoxlanmasın)
const GORULEN_LIMIT = 3000;
const XULASE_UZUNLUGU = 260;
const KV_KEY = "news.json";

// ───────────────────────── TİPLƏR ──────────────────────────

interface Xeber {
  cat: string;
  date: string; // dərc günü (Bakı vaxtı), YYYY-MM-DD
  pubDate?: string; // mənbədə çıxış vaxtı (ISO) — sıralama üçün
  title: string;
  excerpt: string;
  source: string;
  url: string;
  status: "derc" | "gozleyir" | "redd";
  tercume?: boolean;
  dercDate?: string;
  added?: string;
  edited?: boolean;
  yoxlanib?: boolean; // Gemini mövzu yoxlamasından keçib
  sebeb?: string; // Gemini-nin qərar səbəbi
  onem?: number; // Gemini-nin önəm balı (1–10)
  _dil?: string;
}

interface NewsFile {
  _qeyd?: string;
  updated: string;
  items: Xeber[];
}

// Cloudflare Secrets Store bindings — `.get()` ilə oxunur
interface SecretRef { get(): Promise<string | null> }

export interface Env {
  NEWS_KV: KVNamespace;
  ASSETS: Fetcher;
  GEMINI_API_KEY: SecretRef;
  ADMIN_TOKEN: SecretRef;
  GEMINI_MODEL?: string;
  ADMIN_URL?: string;
}

async function secret(ref: SecretRef | undefined): Promise<string> {
  if (!ref) return "";
  try {
    return (await ref.get()) || "";
  } catch {
    return "";
  }
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

/** Mənbədəki çıxış vaxtı, tam ISO formatında. Tapılmasa boş sətir (namizəd olmur). */
function tarixAl(giris: any): string {
  const kandidatlar = [giris.pubDate, giris.published, giris.updated, giris["dc:date"]];
  for (const t of kandidatlar) {
    if (!t) continue;
    const d = new Date(metnAl(t));
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return "";
}

/** Bakı vaxtı ilə bugünkü tarix (YYYY-MM-DD). */
function bakiGunu(an: number = Date.now()): string {
  return new Date(an + BAKI_FERQ_SAAT * 3600000).toISOString().slice(0, 10);
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
  // Standart limit (1000 entity) MIT News kimi uzun lentlərdə aşılır. Limitlər
  // qalır (iç-içə genişlənmə və ölçü), sadəcə adi &amp; / &#8217; sayı üçün geniş.
  processEntities: { enabled: true, maxTotalExpansions: 50000, maxExpandedLength: 2000000 },
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
      let link = linkAl(giris);
      if (menbe.bingNews && link) {
        try {
          link = new URL(link).searchParams.get("url") || link;
        } catch {}
      }
      if (!baslıq || !link) continue;

      const xulase = temizMetn(
        metnAl(giris.description ?? giris.summary ?? giris.content ?? giris["content:encoded"] ?? ""),
      );
      if (menbe.suzgec && !uygundur(baslıq, xulase, menbe)) continue;
      const pubDate = tarixAl(giris);
      if (!pubDate) continue; // tarixsiz xəbərin təzəliyini bilmirik

      // Status və date müvəqqətidir — son qərarı botIsle() Gemini yoxlamasından sonra verir
      netice.push({
        cat: menbe.kateqoriya,
        date: pubDate.slice(0, 10),
        pubDate,
        title: baslıq,
        excerpt: xulase ? qisalt(xulase) : "",
        source: menbe.ad,
        url: link,
        status: "gozleyir",
        _dil: menbe.dil,
      });
    }
    console.log(`  → ${menbe.ad} … ${netice.length} uyğun xəbər`);
    return netice;
  } catch (xeta: any) {
    console.log(`  → ${menbe.ad} … XƏTA (${xeta?.message || xeta})`);
    return [];
  }
}

// ──────────────────── MÖVZU YOXLAMASI + TƏRCÜMƏ ────────────────────

const YOXLAMA_TAPSIRIGI = `Sən RenTech saytının xəbər redaktorusan. RenTech Azərbaycan auditoriyası üçün
bərpa olunan enerji və enerji keçidi haqqında xəbər saytıdır.

Hər xəbər üçün üç iş gör:
1) Mövzuya uyğundurmu — qərar ver (uygun: true/false) və qısa səbəb yaz.
2) Önəm balı ver (onem: 1–10) — xəbərin oxucular arasında nə qədər çox oxunacağı və
   sektor üçün nə qədər vacib olduğu. Saytda gündə yalnız ən yüksək ballı 7 xəbər çıxır.
   Yüksək (8–10): böyük layihələr, rekordlar, Azərbaycanda yeni stansiya, müqavilə və ya
   dövlət qərarı, qlobal bazara təsir edən hadisələr, böyük şirkətlərin mühüm addımları,
   geniş auditoriyanın maraqlanacağı xəbərlər.
   Orta (4–7): regional layihələr, sənaye hesabatları, yeni texnologiyalar.
   Aşağı (1–3): kiçik şirkətlərin press-relizləri, dar texniki qeydlər, təkrar xəbərlər.
   HƏMİŞƏ 10: Azərbaycanın strateji yaşıl enerji layihələri — Xəzər–Qara dəniz–Avropa
   Yaşıl Enerji Dəhlizi, GECO (Green Energy Corridor Power Company), Qara dəniz sualtı
   kabeli, Azərbaycan–Mərkəzi Asiya yaşıl dəhlizi.
   Uyğun olmayan xəbərə onem: 0 yaz.
3) Uyğundursa və Azərbaycan dilində deyilsə — başlığı və xülasəni Azərbaycan dilinə tərcümə et.

UYĞUNDUR — xəbərin ƏSAS mövzusu bunlardan biridirsə:
- günəş, külək, hidro, geotermal, bioenerji; fotovoltaik texnologiyalar, panellər, inverterlər
- batareyalar və enerji saxlama sistemləri; hidrogen
- elektrik şəbəkəsi, ötürmə, enerji səmərəliliyi
- elektromobillər, onların bazarı və şarj infrastrukturu
- iqlim siyasəti və iqlim sammitləri (COP və s.), enerji keçidi kontekstində
- sektorun biznesi: investisiya, maliyyələşmə, tender, birləşmə, iflas, məhkəmə işləri,
  istehsal gücləri — bərpa olunan enerji, saxlama və ya elektromobil şirkətləri ilə bağlıdırsa
- Azərbaycanda bərpa olunan enerji layihələri, yaşıl enerji dəhlizləri, bu sahədə dövlət
  qərarları və beynəlxalq əməkdaşlıq
- mühəndislər üçün standartlar, normativlər və sertifikatlaşdırma (IEC, IEEE, UL və s.),
  təlim proqramları, peşə sertifikatları, şəbəkəyə qoşulma qaydaları — enerji, PV,
  saxlama, elektrik təhlükəsizliyi və ya elektromobil sahəsinə aiddirsə
  (tibb, aviasiya, media, süni intellekt etikası kimi başqa sahələrin standartları — uyğun deyil)
- enerji obyektlərində (günəş, külək, saxlama stansiyaları və s.) yanğın, qəza, təbii fəlakət
  zərəri və təhlükəsizlik hadisələri — mühəndislər üçün faydalıdır

UYĞUN DEYİL:
- atom (nüvə) enerjisi və atom elektrik stansiyaları
- neft və qaz — yalnız yaşıl keçidlə birbaşa bağlı deyilsə
- ümumi siyasət, diplomatiya, hərbi mövzular, cinayət, qəza, sağlamlıq, idman, mədəniyyət,
  şou-biznes, süni intellekt və İT — enerji ilə birbaşa bağlı deyilsə
- adi avtomobil bazarı, rüsumlar, ticarət — xəbər açıq şəkildə elektromobillərdən bəhs etmirsə
- endirim, kupon, satış təklifi, məhsul reklamı tipli xəbərlər (məs. "$700 off", "aşağı qiymətə")
- dövlət rəsmilərini, nazirlikləri və ya hökuməti tənqid edən, ittiham edən, onlara qarşı
  çıxan xəbərlər — xüsusilə Azərbaycanla bağlı olanlar
- "enerji", "şəbəkə", "ev" kimi sözlər yalnız təsadüfən keçirsə (məs. "sosial şəbəkə", "Ağ Ev")

Şübhəli halda — uygun: false.

Tərcümə qaydaları:
- Texniki terminləri Azərbaycan enerji sahəsində işlənən formada yaz:
  inverter, string, fotovoltaik, kVt, MVt, QVt, kVt·s, TVt·s, şəbəkə, batareya.
- Şirkət, ölkə və layihə adlarını tərcümə etmə.
- Rəqəmləri dəyişmə; onluq ayırıcı vergüldür (25,5%).
- Başlıq qısa və xəbər dilində olsun; əlavə şərh yazma.
- title və excerpt HƏMİŞƏ Azərbaycan dilində olmalıdır: lang "az" deyilsə mütləq tərcümə et,
  orijinal dildə saxlama. lang "az"-dırsa, olduğu kimi qaytar.

Cavabı YALNIZ JSON massivi kimi qaytar:
[{"i": 0, "uygun": true, "onem": 7, "sebeb": "...", "title": "...", "excerpt": "..."}]

Xəbərlər:
`;

const YOXLAMA_SXEMI = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      i: { type: "INTEGER" },
      uygun: { type: "BOOLEAN" },
      onem: { type: "INTEGER" },
      sebeb: { type: "STRING" },
      title: { type: "STRING" },
      excerpt: { type: "STRING" },
    },
    required: ["i", "uygun", "onem", "sebeb", "title", "excerpt"],
  },
};

interface Qerar {
  uygun: boolean;
  onem: number; // 0–10
  sebeb: string;
  title?: string; // tərcümə (yalnız xarici dildə olanlar üçün)
  excerpt?: string;
}

/** Bir qrup xəbəri Gemini-yə göndərir. Alınmasa null qaytarır (fail-closed). */
async function geminiQrup(qrup: Xeber[], apiKey: string, model: string): Promise<(Qerar | null)[] | null> {
  const giris = qrup.map((x, i) => ({
    i,
    source: x.source,
    lang: x._dil || "en",
    title: x.title,
    excerpt: x.excerpt,
  }));
  const sorgu = {
    contents: [{ parts: [{ text: YOXLAMA_TAPSIRIGI + JSON.stringify(giris, null, 1) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: YOXLAMA_SXEMI,
    },
  };
  const unvan = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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
        if ([408, 429, 500, 502, 503, 504, 524].includes(cavab.status) && cehd < 3) {
          console.log(`  (cəhd ${cehd}: HTTP ${cavab.status} — ${10 * cehd} sn gözləyirəm)`);
          await new Promise((r) => setTimeout(r, 10000 * cehd));
          continue;
        }
        console.log(`  (yoxlama alınmadı: HTTP ${cavab.status} — ${metn.slice(0, 200)})`);
        return null;
      }
      const data: any = await cavab.json();
      const metn = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!metn) throw new Error("Boş cavab");
      netice = JSON.parse(metn);
      break;
    } catch (xeta: any) {
      console.log(`  (yoxlama alınmadı: ${xeta?.message || xeta})`);
      if (cehd >= 3) return null;
    }
  }
  if (!Array.isArray(netice)) return null;

  const qerarlar: (Qerar | null)[] = qrup.map(() => null);
  for (const s of netice) {
    const n = Number(s?.i);
    if (!Number.isInteger(n) || n < 0 || n >= qrup.length || typeof s.uygun !== "boolean") continue;
    qerarlar[n] = {
      uygun: s.uygun,
      onem: Math.max(0, Math.min(10, Math.round(Number(s.onem) || 0))),
      sebeb: temizMetn(String(s.sebeb || "")).slice(0, 200),
      title: s.title ? temizMetn(String(s.title)) : undefined,
      excerpt: s.excerpt ? temizMetn(String(s.excerpt)) : undefined,
    };
  }
  return qerarlar;
}

/**
 * Xəbərləri Gemini ilə yoxlayır və xarici dildə olanları tərcümə edir.
 * Hər xəbər üçün qərar qaytarır; qərar alınmayanlar üçün null (onlar dərc olunmamalıdır).
 */
async function geminiYoxla(xeberler: Xeber[], env: Env): Promise<(Qerar | null)[]> {
  const bos = xeberler.map(() => null);
  if (!xeberler.length) return bos;
  const apiKey = await secret(env.GEMINI_API_KEY);
  if (!apiKey) {
    console.log("  (GEMINI_API_KEY yoxdur — yoxlama edilmədi, heç nə dərc olunmur)");
    return bos;
  }
  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";

  const hamisi: (Qerar | null)[] = [];
  for (let bas = 0; bas < xeberler.length; bas += YOXLAMA_QRUPU) {
    const qrup = xeberler.slice(bas, bas + YOXLAMA_QRUPU);
    const qerarlar = await geminiQrup(qrup, apiKey, model);
    hamisi.push(...(qerarlar || qrup.map(() => null)));
  }

  // Uyğun sayılıb, amma tərcümə olunmayan xarici xəbərlər üçün bir dəfə də cəhd et
  const tercumesiz = xeberler
    .map((x, n) => n)
    .filter((n) => {
      const q = hamisi[n];
      const xarici = (xeberler[n]._dil || "en") !== "az" && !xeberler[n].tercume;
      return q && q.uygun && xarici && (!q.title || q.title === xeberler[n].title);
    })
    .slice(0, YOXLAMA_QRUPU);
  if (tercumesiz.length) {
    console.log(`  ${tercumesiz.length} xəbər tərcümə olunmayıb — yenidən cəhd`);
    const ikinci = await geminiQrup(tercumesiz.map((n) => xeberler[n]), apiKey, model);
    ikinci?.forEach((q, k) => {
      if (q && q.uygun) hamisi[tercumesiz[k]] = q;
    });
  }
  const say = hamisi.filter(Boolean).length;
  console.log(`  ${say}/${xeberler.length} xəbər üçün qərar alındı`);
  return hamisi;
}

/**
 * Qərarı xəbərə tətbiq edir: tərcümə, səbəb, bal; uyğun deyilsə "redd".
 * Uyğun xəbərin statusuna toxunmur — dərc qərarını gündəlik seçim verir.
 * Xarici xəbər tərcümə olunmayıbsa false qaytarır (dərc olunmamalıdır).
 */
function qerariTetbiqEt(x: Xeber, q: Qerar): boolean {
  const strateji = stratejidir(x); // orijinal mətnlə, tərcümədən əvvəl
  const xarici = (x._dil || "en") !== "az" && !x.tercume;
  if (q.uygun && xarici) {
    if (!q.title || q.title === x.title) return false; // tərcümə alınmayıb
    x.title = q.title;
    if (q.excerpt) x.excerpt = qisalt(q.excerpt);
    x.tercume = true;
  }
  if (!q.uygun) x.status = "redd";
  x.yoxlanib = true;
  x.sebeb = q.sebeb;
  // Strateji layihələr Gemini-nin balından asılı olmayaraq həmişə ən yüksək bal alır
  x.onem = q.uygun && (strateji || stratejidir(x)) ? 10 : q.onem;
  return true;
}

/** Azərbaycanın strateji yaşıl enerji layihələri (Yaşıl Enerji Dəhlizi, GECO və s.). */
const STRATEJI_ACARLAR = [
  "yaşıl enerji dəhliz", "yaşıl dəhliz", "geco", "green energy corridor",
  "xəzər-qara dəniz", "xəzər–qara dəniz", "qara dəniz kabel", "qara dənizin dibi",
  "caspian-black sea", "black sea submarine cable", "black sea cable",
  "azərbaycan-mərkəzi asiya", "azərbaycan–mərkəzi asiya",
];

function stratejidir(x: Xeber): boolean {
  const metn = ((x.title || "") + " " + (x.excerpt || "")).toLowerCase();
  return STRATEJI_ACARLAR.some((s) => metn.includes(s));
}

function yerlidir(x: Xeber): boolean {
  return x.cat === "Azərbaycan";
}

/** Uyğun yeni xəbərlərdən günün seçimi: kvota qədər yerli + xarici, önəm və təzəlik üzrə. */
function gunlukSecim(uygunlar: Xeber[], yerliKvota: number, xariciKvota: number): Xeber[] {
  const sirala = (a: Xeber, b: Xeber) =>
    (b.onem || 0) - (a.onem || 0) || ((b.pubDate || "") > (a.pubDate || "") ? 1 : -1);
  const yerli = uygunlar.filter(yerlidir).sort(sirala);
  const xarici = uygunlar.filter((x) => !yerlidir(x)).sort(sirala);
  const cem = yerliKvota + xariciKvota;
  // Bir qrupda xəbər çatmasa boş yer o biri qrupla doldurulur
  const yerliSay = Math.min(yerli.length, Math.max(yerliKvota, cem - xarici.length));
  const xariciSay = Math.min(xarici.length, cem - yerliSay);
  return [...yerli.slice(0, yerliSay), ...xarici.slice(0, xariciSay)];
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

/** Mətndə yalnız Azərbaycan əlifbasına xas hərflər varsa (ə, ğ, ı, ş) — Azərbaycan dilidir. */
function azMetndir(x: Xeber): boolean {
  return /[əğış]/.test(((x.title || "") + " " + (x.excerpt || "")).toLowerCase());
}

async function gorulenleriYuklə(env: Env): Promise<Set<string>> {
  try {
    const xam = await env.NEWS_KV.get(GORULEN_KEY);
    const siyahi = xam ? JSON.parse(xam) : [];
    return new Set(Array.isArray(siyahi) ? siyahi : []);
  } catch {
    return new Set();
  }
}

interface Hesabat {
  dry: boolean;
  yeni: number;
  yoxlanan: number;
  derc: number;
  redd: number;
  qerarsiz: number;
  xeberler: {
    source: string;
    title: string;
    uygun: boolean | null;
    onem: number | null;
    secildi: boolean;
    sebeb: string;
    kohne: boolean;
  }[];
}

async function botIsle(env: Env, origin?: string, secim: { dry?: boolean } = {}): Promise<Hesabat> {
  const dry = Boolean(secim.dry);
  console.log(`RenTech xəbər botu işə düşdü${dry ? " (TEST — KV-yə yazılmır)" : ""}`);

  const kohne = await kohnəniYuklə(env, origin);
  const kohneLinkler = new Set(kohne.map((x) => x.url));
  const kohneBasliqlar = new Set(kohne.map((x) => normalBaslıq(x.title || "")));
  const yoxlanmisLinkler = await gorulenleriYuklə(env);

  const yenilər: Xeber[] = [];
  for (const menbe of MENBELER) {
    const b = await lentiOxu(menbe);
    yenilər.push(...b);
  }

  const hedd = new Date(Date.now() - TEZE_SAAT * 3600000).toISOString();
  let təzə: Xeber[] = [];
  const görülənLink = new Set<string>();
  const görülənBaslıq = new Set<string>();
  for (const x of yenilər) {
    const b = normalBaslıq(x.title);
    if (
      (x.pubDate || "") < hedd ||
      kohneLinkler.has(x.url) ||
      yoxlanmisLinkler.has(x.url) ||
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
  // Ən təzələr birinci; limitdən artığı yoxlanmır
  təzə.sort((a, b) => ((a.pubDate || "") < (b.pubDate || "") ? 1 : -1));
  const qalan = Math.max(0, təzə.length - MAKS_YOXLAMA);
  təzə = təzə.slice(0, MAKS_YOXLAMA);
  console.log(`\nYeni xəbər (son ${TEZE_SAAT} saat): ${təzə.length}${qalan ? ` (+${qalan} yoxlanmadı)` : ""}`);

  // Hələ yoxlanmamış köhnə xəbərlər də bir dəfə yoxlanır. Toxunulmur:
  // redaktə edilənlər, əl ilə əlavə olunanlar və əl ilə təsdiqlənmiş tərcümələr.
  const menbeDili = new Map(MENBELER.map((m) => [m.ad, m.dil]));
  const kohneYoxlanacaq = kohne.filter(
    (x) =>
      !x.yoxlanib &&
      !x.edited &&
      !x.added &&
      x.status !== "redd" &&
      !(x.status === "derc" && x.tercume),
  );
  // Mətni həqiqətən Azərbaycan dilindədirsə Gemini yalnız qərar versin, yenidən tərcümə etməsin.
  // "tercume" bayrağına güvənmirik: köhnə botun bəzi "tərcümə"ləri almanca qalıb.
  for (const x of kohneYoxlanacaq) {
    if (azMetndir(x)) {
      x._dil = "az";
    } else {
      x._dil = menbeDili.get(x.source) || "en";
      x.tercume = false;
    }
  }

  // Yenilər birinci yoxlanır (günün seçimi onlardan olur), qalan yer köhnələrə
  const kohneSec = kohneYoxlanacaq.slice(0, MAKS_YOXLAMA - təzə.length);
  const yoxlanacaq = [...təzə, ...kohneSec];
  if (yoxlanacaq.length) console.log(`Gemini yoxlaması (${yoxlanacaq.length}):`);
  const qerarlar = await geminiYoxla(yoxlanacaq, env);

  const indi = new Date().toISOString();
  const bugun = bakiGunu();
  const hesabat: Hesabat = {
    dry, yeni: təzə.length, yoxlanan: yoxlanacaq.length, derc: 0, redd: 0, qerarsiz: 0, xeberler: [],
  };
  const qerarliYeni: Xeber[] = []; // qərarı alınmış yeni xəbərlər (növbəti dəfə yoxlanmasın)
  const uygunYeni: Xeber[] = [];
  const tetbiqOlundu = yoxlanacaq.map((x, n) => {
    const q = qerarlar[n];
    const tetbiq = q ? qerariTetbiqEt(x, q) : false;
    if (tetbiq && n < təzə.length) {
      qerarliYeni.push(x);
      if (q!.uygun) uygunYeni.push(x);
    }
    return tetbiq;
  });

  // Gündəlik kvota: bu gün artıq dərc olunanlar çıxılır (məs. /run əl ilə təkrar işə salınıbsa)
  const bugunDerc = kohne.filter((x) => x.status === "derc" && x.pubDate && x.date === bugun);
  const yerliKvota = Math.max(0, GUNLUK_YERLI - bugunDerc.filter(yerlidir).length);
  const xariciKvota = Math.max(0, GUNLUK_XARICI - bugunDerc.filter((x) => !yerlidir(x)).length);
  const secilenler = new Set(gunlukSecim(uygunYeni, yerliKvota, xariciKvota));
  for (const x of secilenler) {
    x.status = "derc";
    x.date = bugun;
    x.dercDate = indi;
  }

  yoxlanacaq.forEach((x, n) => {
    const q = qerarlar[n];
    const kohnedir = n >= təzə.length;
    const tetbiq = tetbiqOlundu[n];
    if (!tetbiq) hesabat.qerarsiz++;
    else if (secilenler.has(x)) hesabat.derc++;
    else if (x.status === "redd") hesabat.redd++;
    hesabat.xeberler.push({
      source: x.source,
      title: x.title,
      uygun: tetbiq && q ? q.uygun : null,
      onem: tetbiq && q ? q.onem : null,
      secildi: secilenler.has(x),
      sebeb: q ? q.sebeb : "qərar alınmadı — dərc olunmadı",
      kohne: kohnedir,
    });
  });
  hesabat.xeberler.sort((a, b) => Number(b.secildi) - Number(a.secildi) || (b.onem || 0) - (a.onem || 0));
  console.log(
    `Nəticə: ${hesabat.derc} dərc (kvota ${yerliKvota}+${xariciKvota}), ${uygunYeni.length - hesabat.derc} uyğun seçilmədi, ` +
      `${hesabat.redd} rədd, ${hesabat.qerarsiz} qərarsız`,
  );
  if (dry) return hesabat;

  // Yeni xəbərlərdən yalnız seçilənlər və rədd olunanlar yazılır. Seçilməyən uyğunlar
  // sadəcə "görülən" siyahısına düşür; qərarı alınmayanlar növbəti dəfə yenidən yoxlanılır.
  const hamısı = [...kohne, ...təzə.filter((x) => secilenler.has(x) || x.status === "redd")];
  let aktiv = hamısı.filter((x) => x.status !== "redd");
  let redd = hamısı.filter((x) => x.status === "redd");

  // Ən təzələr üstdə: əvvəl dərc günü, sonra mənbədə çıxış vaxtı
  const sıralaAcar = (x: Xeber) => `${x.date || ""}|${x.pubDate || x.dercDate || ""}`;
  aktiv.sort((a, b) => (sıralaAcar(a) < sıralaAcar(b) ? 1 : -1));
  redd.sort((a, b) => (sıralaAcar(a) < sıralaAcar(b) ? 1 : -1));

  aktiv = aktiv.slice(0, MAKS_XEBER);
  redd = redd.slice(0, REDD_DEDUP_LIMIT);

  for (const x of [...aktiv, ...redd]) {
    delete x._dil;
  }

  const yazılacaq: NewsFile = {
    _qeyd:
      "status sahəsi: 'derc' — saytda görünür, 'redd' — saytda gizli (sebeb: Gemini-nin qərarı), 'gozleyir' — köhnə format. " +
      "date — dərc günü (Bakı), pubDate — mənbədə çıxış vaxtı, onem — Gemini balı (1–10).",
    updated: indi.slice(0, 16).replace("T", " "),
    items: [...aktiv, ...redd],
  };

  await env.NEWS_KV.put(KV_KEY, JSON.stringify(yazılacaq, null, 2));
  console.log(`\nKV yazıldı — ${aktiv.length} aktiv, ${redd.length} rədd dedup üçün.`);

  if (qerarliYeni.length) {
    const yeniSiyahi = [...qerarliYeni.map((x) => x.url), ...yoxlanmisLinkler].slice(0, GORULEN_LIMIT);
    await env.NEWS_KV.put(GORULEN_KEY, JSON.stringify(yeniSiyahi));
  }
  return hesabat;
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

async function checkAdmin(request: Request, env: Env): Promise<boolean> {
  const adminToken = await secret(env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token) && token === adminToken;
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
  if (!(await checkAdmin(request, env))) return jsonResp({ error: "unauthorized" }, 401);
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
      if (!(await checkAdmin(request, env))) return jsonResp({ error: "unauthorized" }, 401);
      const dry = url.searchParams.get("dry") === "1";
      const hesabat = await botIsle(env, url.origin, { dry });
      return jsonResp({ ok: true, ...hesabat });
    }

    // Digər hər şey — static asset
    return env.ASSETS.fetch(request);
  },
};
