#!/usr/bin/env python3
"""
RenTech xəbər botu
------------------
Seçilmiş saytların RSS lentlərini oxuyur, günəş və bərpa olunan enerji ilə
bağlı yeni xəbərləri seçir və news.json faylına yazır. Sayt həmin faylı oxuyur.

Yalnız başlıq, tarix, qısa xülasə və mənbə linki saxlanılır — məqalənin tam
mətni köçürülmür.

Xarici dildəki mənbələr Gemini ilə Azərbaycan dilinə tərcümə olunur və
"gozleyir" vəziyyətində saxlanılır: saytda görünmür, sən təsdiqləyənə qədər.

İşə salmaq:  python news/bot.py
"""

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

try:
    import feedparser
except ImportError:
    sys.exit("feedparser quraşdırılmayıb.  pip install feedparser")

# ─────────────────────────── AYARLAR ───────────────────────────

# Yeni mənbə əlavə etmək üçün bu siyahıya bir sətir yaz.
#   url        – RSS lentinin ünvanı
#   ad         – saytda "Mənbə:" yanında görünəcək ad
#   kateqoriya – Azərbaycan | Dünya | Texnologiya | Bazar
#   suzgec     – True olsa, yalnız açar sözlərə uyğun xəbərlər götürülür
#   dil        – "az" birbaşa dərc olunur, "en" tərcümə olunub təsdiq gözləyir
MENBELER = [
    {"url": "https://report.az/rss/", "ad": "Report.az",
     "kateqoriya": "Azərbaycan", "suzgec": True, "dil": "az"},

    {"url": "https://az.trend.az/feeds/index.rss", "ad": "Trend.az",
     "kateqoriya": "Azərbaycan", "suzgec": True, "dil": "az"},

    {"url": "https://www.pv-magazine.com/feed/", "ad": "pv magazine",
     "kateqoriya": "Dünya", "suzgec": False, "dil": "en"},

    # ABŞ
    {"url": "https://www.pv-magazine-usa.com/feed/", "ad": "pv magazine USA",
     "kateqoriya": "ABŞ", "suzgec": False, "dil": "en"},

    {"url": "https://cleantechnica.com/feed/", "ad": "CleanTechnica",
     "kateqoriya": "ABŞ", "suzgec": True, "dil": "en"},

    # Almaniya
    {"url": "https://www.pv-magazine.de/feed/", "ad": "pv magazine Deutschland",
     "kateqoriya": "Almaniya", "suzgec": False, "dil": "de"},

    # Çin və Asiya PV bazarı
    {"url": "https://www.pv-tech.org/feed/", "ad": "PV Tech",
     "kateqoriya": "Çin", "suzgec": False, "dil": "en"},

    {"url": "https://www.energytrend.com/rss.xml", "ad": "EnergyTrend",
     "kateqoriya": "Çin", "suzgec": False, "dil": "en"},
]

ACAR_SOZLER = [
    "günəş enerji", "günəş panel", "günəş elektrik", "fotovoltaik",
    "bərpa olunan", "yaşıl enerji", "alternativ enerji", "yaşıl keçid",
    "külək enerji", "külək elektrik", "günəş stansiya", "elektrik stansiyası",
    "enerji səmərəliliyi", "socar green", "masdar", "solar", "photovoltaic",
    "renewable", "wind power", "wind farm", "battery storage",
    "grid-scale", "utility-scale", "gigafactory", "solarmodul", "energiewende",
]

MAKS_XEBER = 30            # saxlanılacaq maksimum xəbər sayı
MAKS_TERCUME = 30          # bir işləmədə tərcümə olunacaq maksimum xəbər
XULASE_UZUNLUGU = 260
CIXIS_FAYLI = "news.json"

GEMINI_ACAR = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-flash-latest"

# ───────────────────────── KÖMƏKÇİLƏR ──────────────────────────


def temiz_metn(xam: str) -> str:
    if not xam:
        return ""
    metn = re.sub(r"<[^>]+>", " ", xam)
    metn = html.unescape(metn)
    return re.sub(r"\s+", " ", metn).strip()


def qisalt(metn: str, hedd: int = XULASE_UZUNLUGU) -> str:
    if len(metn) <= hedd:
        return metn
    return metn[:hedd].rsplit(" ", 1)[0].rstrip(" ,.;:—-") + "…"


def tarix_al(giris) -> str:
    for sahe in ("published_parsed", "updated_parsed"):
        t = giris.get(sahe)
        if t:
            try:
                return datetime(*t[:6], tzinfo=timezone.utc).strftime("%Y-%m-%d")
            except (TypeError, ValueError):
                pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def uygundur(baslıq: str, xulase: str) -> bool:
    metn = (baslıq + " " + xulase).lower()
    return any(söz in metn for söz in ACAR_SOZLER)


def normal_baslıq(b: str) -> str:
    return re.sub(r"[^a-zəğıöşüçA-ZƏĞIİÖŞÜÇ0-9]+", "", b.lower())[:80]


# ─────────────────────────── TƏRCÜMƏ ───────────────────────────

TERCUME_TAPSIRIGI = """Sən enerji sahəsi üzrə peşəkar tərcüməçisən.
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
"""


def gemini_tercume(xeberler: list) -> list:
    """Xəbərlərin başlıq və xülasəsini Azərbaycan dilinə çevirir.
    Uğursuz olsa, mətni olduğu kimi qaytarır — bot dayanmır."""
    if not xeberler:
        return xeberler
    if not GEMINI_ACAR:
        print("  (GEMINI_API_KEY yoxdur — tərcümə edilmədi, mətn ingiliscə qaldı)")
        return xeberler

    giris = [{"i": n, "title": x["title"], "excerpt": x["excerpt"]}
             for n, x in enumerate(xeberler)]
    sorgu = {
        "contents": [{"parts": [{"text": TERCUME_TAPSIRIGI +
                                 json.dumps(giris, ensure_ascii=False, indent=1)}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
    }
    unvan = (f"https://generativelanguage.googleapis.com/v1beta/models/"
             f"{GEMINI_MODEL}:generateContent?key={GEMINI_ACAR}")

    print(f"  (model: {GEMINI_MODEL})")
    try:
        model_list_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={GEMINI_ACAR}"
        with urllib.request.urlopen(model_list_url, timeout=30) as r:
            models_data = json.loads(r.read().decode("utf-8"))
        available = [m["name"] for m in models_data.get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
        print(f"  (v1beta-da generateContent üçün mövcud modellər: {available[:10]})")
    except Exception as e:
        print(f"  (model siyahısı alınmadı: {e})")

    try:
        istek = urllib.request.Request(
            unvan,
            data=json.dumps(sorgu).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(istek, timeout=90) as cavab:
            data = json.loads(cavab.read().decode("utf-8"))
        metn = data["candidates"][0]["content"]["parts"][0]["text"]
        netice = json.loads(metn)
    except urllib.error.HTTPError as xeta:
        cavab_metn = ""
        try:
            cavab_metn = xeta.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        print(f"  (tərcümə alınmadı: HTTP {xeta.code} — {cavab_metn})")
        return xeberler
    except (urllib.error.URLError, KeyError, IndexError,
            json.JSONDecodeError, TimeoutError) as xeta:
        print(f"  (tərcümə alınmadı: {xeta} — mətn ingiliscə qaldı)")
        return xeberler

    sayğac = 0
    for sətir in netice if isinstance(netice, list) else []:
        try:
            n = int(sətir["i"])
            if 0 <= n < len(xeberler) and sətir.get("title"):
                xeberler[n]["title"] = temiz_metn(sətir["title"])
                if sətir.get("excerpt"):
                    xeberler[n]["excerpt"] = qisalt(temiz_metn(sətir["excerpt"]))
                xeberler[n]["tercume"] = True
                sayğac += 1
        except (KeyError, ValueError, TypeError):
            continue

    print(f"  {sayğac} xəbər tərcümə olundu")
    return xeberler


# ─────────────────────────── ƏSAS ──────────────────────────────


def lenti_oxu(menbe: dict) -> list:
    print(f"  → {menbe['ad']} …", end=" ", flush=True)
    try:
        lent = feedparser.parse(menbe["url"])
    except Exception as xeta:
        print(f"XƏTA ({xeta})")
        return []

    if getattr(lent, "bozo", 0) and not lent.entries:
        print(f"XƏTA ({getattr(lent, 'bozo_exception', 'oxunmadı')})")
        return []

    netice = []
    for giris in lent.entries:
        baslıq = temiz_metn(giris.get("title", ""))
        link = (giris.get("link") or "").strip()
        if not baslıq or not link:
            continue

        xulase = temiz_metn(giris.get("summary") or giris.get("description") or "")
        if menbe["suzgec"] and not uygundur(baslıq, xulase):
            continue

        netice.append({
            "cat": menbe["kateqoriya"],
            "date": tarix_al(giris),
            "title": baslıq,
            "excerpt": qisalt(xulase) if xulase else "",
            "source": menbe["ad"],
            "url": link,
            # az mənbə → dərhal saytda; xarici mənbə → təsdiq gözləyir
            "status": "derc" if menbe.get("dil", "az") == "az" else "gozleyir",
            "_dil": menbe.get("dil", "az"),
        })

    print(f"{len(netice)} uyğun xəbər")
    return netice


def kohnəni_yuklə(yol: str) -> list:
    if not os.path.exists(yol):
        return []
    try:
        with open(yol, encoding="utf-8") as f:
            return json.load(f).get("items", [])
    except (json.JSONDecodeError, OSError):
        return []


def main() -> int:
    print("RenTech xəbər botu işə düşdü\n")

    kohne = kohnəni_yuklə(CIXIS_FAYLI)
    kohne_linkler = {x.get("url") for x in kohne}
    kohne_basliqlar = {normal_baslıq(x.get("title", "")) for x in kohne}

    yenilər = []
    for menbe in MENBELER:
        yenilər.extend(lenti_oxu(menbe))

    # yalnız həqiqətən yeni olanları saxla
    təzə, görülən_link, görülən_baslıq = [], set(), set()
    for x in yenilər:
        b = normal_baslıq(x["title"])
        if (x["url"] in kohne_linkler or b in kohne_basliqlar
                or x["url"] in görülən_link or b in görülən_baslıq):
            continue
        görülən_link.add(x["url"])
        görülən_baslıq.add(b)
        təzə.append(x)

    print(f"\nYeni xəbər: {len(təzə)}")

    # xarici dildəkiləri tərcümə et
    tercume_olunacaq = [x for x in təzə if x.get("_dil") != "az"][:MAKS_TERCUME]
    if tercume_olunacaq:
        print(f"Tərcümə olunur ({len(tercume_olunacaq)}):")
        gemini_tercume(tercume_olunacaq)

    for x in təzə:
        x.pop("_dil", None)

    hamısı = kohne + təzə          # köhnələr öndə → onların vəziyyəti qorunur
    hamısı.sort(key=lambda x: x.get("date", ""), reverse=True)
    hamısı = hamısı[:MAKS_XEBER]

    gozleyen = sum(1 for x in hamısı if x.get("status") == "gozleyir")

    with open(CIXIS_FAYLI, "w", encoding="utf-8") as f:
        json.dump({
            "_qeyd": ("status sahəsi: 'derc' — saytda görünür, "
                      "'gozleyir' — təsdiq gözləyir. Xarici xəbəri saytda "
                      "göstərmək üçün mətni yoxla və 'gozleyir' sözünü "
                      "'derc' ilə əvəz et."),
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "items": hamısı,
        }, f, ensure_ascii=False, indent=2)

    print(f"\n{CIXIS_FAYLI} yazıldı — {len(hamısı)} xəbər "
          f"({gozleyen} təsdiq gözləyir).")
    if hamısı:
        print(f"Ən yenisi: {hamısı[0]['date']} · {hamısı[0]['title'][:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
