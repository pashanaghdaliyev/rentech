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
    # Azərbaycan — süzgəclə (ümumi lentdir, yalnız enerji mövzusu keçir)
    {"url": "https://report.az/rss/", "ad": "Report.az",
     "kateqoriya": "Azərbaycan", "suzgec": True, "dil": "az"},

    {"url": "https://az.trend.az/feeds/index.rss", "ad": "Trend.az",
     "kateqoriya": "Azərbaycan", "suzgec": True, "dil": "az"},

    # Dünya — sənaye və bazar
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

    # Texnologiya və innovasiya — öyrənmək istəyənlər üçün
    # Electrek: EV, günəş, batareya innovasiyaları (praktik texnologiya)
    {"url": "https://electrek.co/feed/", "ad": "Electrek",
     "kateqoriya": "Texnologiya", "suzgec": True, "dil": "en"},

    # Energy Storage News: batareya və enerji anbarı texnologiyası
    {"url": "https://www.energy-storage.news/feed/", "ad": "Energy Storage News",
     "kateqoriya": "Texnologiya", "suzgec": False, "dil": "en"},

    # MIT News — enerji araşdırmaları (laboratoriya kəşfləri)
    {"url": "https://news.mit.edu/topic/mitenergy-rss.xml", "ad": "MIT News",
     "kateqoriya": "Texnologiya", "suzgec": False, "dil": "en"},
]

ACAR_SOZLER = [
    # Azərbaycanca
    "günəş enerji", "günəş panel", "günəş elektrik", "fotovoltaik",
    "bərpa olunan", "yaşıl enerji", "alternativ enerji", "yaşıl keçid",
    "külək enerji", "külək elektrik", "günəş stansiya", "elektrik stansiyası",
    "enerji səmərəliliyi", "hidrogen", "yaşıl hidrogen", "batareya",
    "enerji anbarı", "elektromobil", "elektrik avtomobil", "elektroliz",
    "perovskit", "mikro şəbəkə", "ağıllı şəbəkə", "iqlim",
    "socar green", "masdar", "azərişıq",
    # İngiliscə
    "solar", "photovoltaic", "renewable", "wind power", "wind farm",
    "battery", "battery storage", "energy storage", "grid-scale",
    "utility-scale", "gigafactory", "perovskite", "tandem cell", "bifacial",
    "hydrogen", "green hydrogen", "electrolyzer", "electric vehicle",
    " ev ", "microgrid", "smart grid",
    # Almanca
    "solarmodul", "energiewende", "wasserstoff", "batterie",
]

MAKS_XEBER = 50            # aktiv (derc + gozleyir) maksimum sayı
REDD_DEDUP_LIMIT = 150     # rədd edilmişlər yalnız dedup üçün saxlanır
# Bütün aktiv gözləyənlər bir işləmədə tərcümə olunsun — köhnə tərcüməsizlər
# yeni xəbərlər axını altında ilişib qalmasın. Gemini flash-lite bir batch-də
# 50 elementi asanlıqla işləyir (~2500 giriş + 2500 çıxış token, cap 8k).
MAKS_TERCUME = MAKS_XEBER
XULASE_UZUNLUGU = 260
CIXIS_FAYLI = "news.json"

GEMINI_ACAR = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-flash-lite-latest"

# ntfy.sh push bildirişi. Topic təyin edilməsə, bildiriş göndərilmir.
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
NTFY_SERVER = os.environ.get("NTFY_SERVER", "").strip() or "https://ntfy.sh"
ADMIN_URL = os.environ.get("ADMIN_URL", "").strip() or \
    "https://pashanaghdaliyev.github.io/rentech/admin.html"

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

    import time
    netice = None
    for cehd in range(1, 4):
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
            break
        except urllib.error.HTTPError as xeta:
            cavab_metn = ""
            try:
                cavab_metn = xeta.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            if xeta.code in (429, 500, 502, 503, 504) and cehd < 3:
                print(f"  (cəhd {cehd}: HTTP {xeta.code} — {cavab_metn[:100]}, 10 sn gözləyirəm)")
                time.sleep(10 * cehd)
                continue
            print(f"  (tərcümə alınmadı: HTTP {xeta.code} — {cavab_metn})")
            return xeberler
        except (urllib.error.URLError, KeyError, IndexError,
                json.JSONDecodeError, TimeoutError) as xeta:
            print(f"  (tərcümə alınmadı: {xeta} — mətn ingiliscə qaldı)")
            return xeberler
    if netice is None:
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


def ntfy_gonder(yeni_gozleyen: list) -> None:
    """Yeni "gozleyir" xəbərlər üçün ntfy.sh push göndərir.
    Uğursuz olsa səssizcə keçir — bildiriş bot işini dayandırmır."""
    if not NTFY_TOPIC or not yeni_gozleyen:
        return

    from collections import Counter
    ölkələr = Counter(x.get("cat", "?") for x in yeni_gozleyen)
    say = len(yeni_gozleyen)
    bölgü = ", ".join(f"{k}: {v}" for k, v in ölkələr.most_common())

    mesaj_setirleri = [f"{say} yeni xəbər təsdiq gözləyir", ""]
    mesaj_setirleri.append(bölgü)
    mesaj_setirleri.append("")
    for x in yeni_gozleyen[:3]:
        mesaj_setirleri.append(f"• [{x.get('cat', '?')}] {x.get('title', '')[:80]}")
    if say > 3:
        mesaj_setirleri.append(f"...və {say - 3} xəbər daha")

    mesaj = "\n".join(mesaj_setirleri)
    baslıq = f"RenTech: {say} yeni xəbər"

    yuk = {
        "topic": NTFY_TOPIC,
        "title": baslıq,
        "message": mesaj,
        "click": ADMIN_URL,
        "tags": ["newspaper"],
        "priority": 3,
    }
    try:
        istek = urllib.request.Request(
            NTFY_SERVER,
            data=json.dumps(yuk, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(istek, timeout=15) as cavab:
            cavab.read()
        print(f"ntfy bildirişi göndərildi ({say} xəbər)")
    except Exception as xeta:
        print(f"  (ntfy göndərilmədi: {xeta})")


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

    # Statusa görə iki qrupa böl:
    #  aktiv (derc + gozleyir) — saytda/admin-də görünür, MAKS_XEBER limiti
    #  redd — yalnız dedup üçün saxlanır, REDD_DEDUP_LIMIT-ə qədər
    hamısı = kohne + təzə          # köhnələr öndə → vəziyyət qorunur
    aktiv = [x for x in hamısı if x.get("status") != "redd"]
    redd  = [x for x in hamısı if x.get("status") == "redd"]

    aktiv.sort(key=lambda x: x.get("date", ""), reverse=True)
    redd.sort(key=lambda x: x.get("date", ""), reverse=True)

    aktiv = aktiv[:MAKS_XEBER]
    redd  = redd[:REDD_DEDUP_LIMIT]

    # tərcümə: yalnız aktiv siyahıdakı "gozleyir" və hələ tərcümə olunmamışlar
    tercume_olunacaq = [x for x in aktiv
                        if x.get("status") == "gozleyir"
                        and not x.get("tercume")][:MAKS_TERCUME]
    if tercume_olunacaq:
        print(f"Tərcümə olunur ({len(tercume_olunacaq)}):")
        gemini_tercume(tercume_olunacaq)

    for x in aktiv + redd:
        x.pop("_dil", None)

    gozleyen = sum(1 for x in aktiv if x.get("status") == "gozleyir")

    # yazılan siyahı: aktiv öndə, redd sonda (dedup üçün lazımdır, saytda göstərilmir)
    yazılacaq = aktiv + redd

    with open(CIXIS_FAYLI, "w", encoding="utf-8") as f:
        json.dump({
            "_qeyd": ("status sahəsi: 'derc' — saytda görünür, "
                      "'gozleyir' — təsdiq gözləyir, 'redd' — saytda gizli. "
                      "Xarici xəbəri saytda göstərmək üçün mətni yoxla və "
                      "'gozleyir' sözünü 'derc' ilə əvəz et."),
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "items": yazılacaq,
        }, f, ensure_ascii=False, indent=2)

    print(f"\n{CIXIS_FAYLI} yazıldı — {len(aktiv)} aktiv "
          f"({gozleyen} təsdiq gözləyir), {len(redd)} rədd dedup üçün.")
    if aktiv:
        print(f"Ən yenisi: {aktiv[0]['date']} · {aktiv[0]['title'][:70]}")

    # yalnız YENİ əlavə olunmuş "gozleyir" xəbərlər üçün bildiriş
    kohne_url = {x.get("url") for x in kohne}
    yeni_gozleyen = [x for x in aktiv
                     if x.get("status") == "gozleyir" and x.get("url") not in kohne_url]
    if yeni_gozleyen:
        ntfy_gonder(yeni_gozleyen)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
