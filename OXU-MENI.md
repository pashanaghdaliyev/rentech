# RenTech xəbər botu — quraşdırma

Bot hər 3 saatdan bir seçilmiş saytların RSS lentini oxuyur, günəş və bərpa
olunan enerji ilə bağlı xəbərləri seçir və `news.json` faylına yazır. Sayt
həmin faylı oxuyur. Hər şey pulsuzdur — GitHub-ın öz imkanları ilə işləyir.

## Fayl quruluşu

```
repo/
├─ rentech-site.html          ← sayt (index.html adlandır)
├─ news.json                  ← botun yazdığı fayl (ilk işləmədən sonra yaranır)
├─ news/
│  └─ bot.py                  ← botun özü
└─ .github/workflows/
   └─ news.yml                ← botu saat başı işə salan cədvəl
```

## Addımlar

**1. GitHub-da repo yarat** və bu faylları ora at. Saytı `index.html`
adlandırsan, ünvan qısa olur.

**2. Botun yazmasına icazə ver.**
Repo → Settings → Actions → General → "Workflow permissions" bölməsində
**Read and write permissions** seç və yadda saxla. Bu olmasa bot faylı
yeniləyə bilməz.

**3. Saytı yayımla.**
Repo → Settings → Pages → Source: `Deploy from a branch` → Branch: `main`,
qovluq `/ (root)`. Bir neçə dəqiqəyə sayt `https://<istifadəçi>.github.io/<repo>/`
ünvanında açılır.

**4. Gemini açarını əlavə et** (xarici xəbərlərin tərcüməsi üçün).
`aistudio.google.com` → Get API key → açarı kopyala.
Sonra repo → Settings → Secrets and variables → Actions → **New repository
secret** → ad: `GEMINI_API_KEY`, dəyər: açar.

Açar qoymasan da bot işləyir — sadəcə xarici xəbərlər ingiliscə qalır.

**5. Botu ilk dəfə əl ilə işə sal.**
Repo → Actions → "Xəbər botu" → **Run workflow**. Bir dəqiqədən sonra
`news.json` faylı görünəcək. Sonra bot özü hər 3 saatdan bir işləyəcək.

Hazırdır.

## Xarici xəbərlərin təsdiqi

Azərbaycan mənbələrindən gələn xəbərlər **birbaşa saytda görünür**.

Xarici mənbədən gələn xəbər Gemini ilə tərcümə olunur, amma saytda dərhal
görünmür — `news.json` faylında `"status": "gozleyir"` kimi saxlanılır.

Təsdiq etmək üçün:

1. GitHub-da `news.json` faylını aç
2. Karandaş işarəsinə bas
3. Tərcüməni oxu — texniki terminlər düzgündürsə, `"gozleyir"` sözünü
   `"derc"` ilə əvəz et (mətni də düzəldə bilərsən)
4. **Commit changes**

Sayt bir neçə saniyəyə yenilənir. Təsdiqlədiyin xəbəri bot bir daha
tərcümə etmir və vəziyyətini dəyişmir.

Niyə belədir: maşın tərcüməsi enerji terminlərində səhv edir
(*grid-scale*, *curtailment*, *utility*). Maarifləndirici saytda səhv termin
ən çox zərər verən şeydir — bir dəqiqəlik yoxlama bunun qarşısını alır.

## Mənbə əlavə etmək

`news/bot.py` faylında `MENBELER` siyahısına bir sətir yaz:

```python
{"url": "https://saytin-adi.az/rss", "ad": "Sayt adı",
 "kateqoriya": "Azərbaycan", "suzgec": True},
```

- `kateqoriya` — saytdakı nişan: `Azərbaycan`, `Dünya`, `Texnologiya`, `Bazar`
- `suzgec` — `True` olsa, yalnız açar sözlərə uyğun xəbərlər götürülür.
  Lent onsuz da yalnız enerji xəbərləri verirsə, `False` yaz.

Açar sözləri `ACAR_SOZLER` siyahısından dəyişə bilərsən.

## Hazırkı mənbələr

| Sayt | Lent | Süzgəc |
|---|---|---|
| Report.az | `https://report.az/rss/` | var |
| Trend.az | `https://az.trend.az/feeds/index.rss` | var |
| pv magazine | `https://www.pv-magazine.com/feed/` | yox |

Report.az və Trend.az ümumi xəbər lentləridir — orada idmandan siyasətə qədər
hər şey var, ona görə açar söz süzgəci işləyir. pv magazine onsuz da yalnız
günəş enerjisi yazır.

## Vacib

**Botun özü xəbər yazmır — yalnız başlıq, tarix, 1–2 cümləlik xülasə və
mənbə linkini götürür.** Məqalənin tam mətnini köçürmək müəllif hüququ
pozuntusudur. Saytda hər xəbərin altında "Mənbə: ..." linki görünür, oxucu
tam mətni orada oxuyur. Bu qaydanı dəyişmə.

## Nəzarət

- **İşləyib-işləmədiyini yoxlamaq:** Actions bölməsində son işləmənin yanında
  yaşıl işarə olmalıdır.
- **Xəbər gəlmirsə:** çox güman lentdə uyğun xəbər olmayıb. Bot belə halda
  köhnə faylı olduğu kimi saxlayır, saytı boşaltmır.
- **Lent dəyişsə və ya sayt RSS-i bağlasa:** həmin mənbə sadəcə nəticə
  verməyəcək, digərləri işləməyə davam edəcək.
- Sayt `news.json` faylını tapa bilməsə (məsələn faylı birbaşa kompüterdə
  ikiqat klikləyəndə), içindəki ehtiyat siyahını göstərir — boş qalmır.

## Cədvəli dəyişmək

`.github/workflows/news.yml` faylında:

```yaml
- cron: "17 */3 * * *"     # hər 3 saatdan bir
```

Günə bir dəfə kifayətdirsə: `"17 6 * * *"` — hər gün UTC 06:17-də
(Bakı vaxtı ilə 10:17).
