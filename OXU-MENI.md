# RenTech — Cloudflare Worker (with Assets)

Sayt, admin PWA və xəbər botu — hamısı **bir Cloudflare Worker** altındadır.
GitHub yalnız mənbə kodu üçün ehtiyat nüsxə saxlayır.

## Fayl quruluşu

```
repo/
├─ index.html              ← sayt (static asset)
├─ admin.html              ← admin PWA (static asset)
├─ manifest.json, *.svg    ← PWA və logolar
├─ news.json               ← seed data (KV boş olanda /api/news buna qayıdır)
├─ src/index.ts            ← Worker: /api/news + /run + cron bot
├─ wrangler.toml           ← config (assets, cron, KV, vars)
├─ package.json            ← fast-xml-parser dependency
└─ .assetsignore           ← src/, wrangler.toml və s. serverdə göstərilmir
```

## Necə işləyir

Bir tək Worker istəkləri belə bölüşdürür:

- `GET /api/news` → KV-dəki `news.json`, public
- `PUT /api/news` → admin bearer token ilə yenilənir
- `POST /run` → admin token ilə botu əl ilə işə salır
- `/*` (digər hər şey) → static asset (index.html, admin.html və s.)

Cron trigger UTC-də 04:00, 08:00, 15:00 (Bakı 08/12/19) botu işə salır.

## Cloudflare quraşdırma

### 1. KV namespace yarat
`Storage & databases → KV → Create` → ad `rentech-news`.

### 2. Worker deploy et (Cloudflare Dashboard yolu)

`Workers & Pages → Create → Workers → Deploy from Git`
- Repo: `pashanaghdaliyev/rentech`
- **Production branch: `cloudflare-migration`** (main-ə sonra merge edərsən)
- Build command: (boş)
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

### 3. Bindings və secrets əlavə et

Worker deploy olunandan sonra `Settings`:

**Bindings → Add binding → KV Namespace:**
- Variable name: `NEWS_KV`
- KV namespace: `rentech-news`

**Bindings → Add binding → Secret text** (hər biri üçün):
- `ADMIN_TOKEN` — uzun random sətir (məs. `openssl rand -hex 32`)
- `GEMINI_API_KEY` — Google AI Studio-dan
- `NTFY_TOPIC` — ntfy.sh topic adı

**Triggers** avtomatik `wrangler.toml`-dan gəlir. Yoxla: `0 4,8,15 * * *` görünməlidir.

Save. Yeni deploy trigger et — Deployments → Retry.

### 4. Custom domain qoş

Worker → `Domains & Routes → Add → Custom domain` → `rentech.az`.

Cloudflare 2 nameserver verəcək. Onları online.az panelinə (Name Server ekranı) yaz.
Yayılma 15 dəq – 24 saat çəkir. HTTPS avtomatik.

### 5. Admin panelə daxil ol

`https://rentech.az/admin.html` aç → `ADMIN_TOKEN` dəyərini daxil et.

### 6. Botu ilk dəfə işə sal

Dashboard → Worker → `Triggers → Cron → Trigger`
və ya:
```bash
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://rentech.az/run
```

Bir dəqiqədən sonra ntfy telefonuna push gələcək.

## Xarici xəbərlərin təsdiqi

Azərbaycan mənbələri (Report.az, Trend.az, APA, Müsavat) → **birbaşa dərc**.

Xarici (pv-magazine, CleanTechnica, PV Tech, EnergyTrend, pv-magazine.de, Electrek, ESN, MIT News)
→ Gemini ilə tərcümə → admin panelə `"gozleyir"` kimi düşür → sən **Dərc et**.

Niyə əl ilə: maşın tərcüməsi enerji terminlərində səhv edir (*grid-scale*, *curtailment*, *utility*).

## Mənbə əlavə etmək

`src/index.ts` faylında `MENBELER` massivinə bir sətir yaz:

```ts
{ url: "https://saytin-adi.az/rss", ad: "Sayt adı",
  kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
```

- `kateqoriya` — `Azərbaycan`, `Dünya`, `Texnologiya`, `Bazar`, `ABŞ`, `Almaniya`, `Çin`
- `suzgec` — `true` olsa, açar söz süzgəci tətbiq edilir
- `dil` — `az` birbaşa dərc, `en`/`de` tərcümə + təsdiq gözləyir

Sonra push et — Cloudflare avtomatik redeploy edir.

## Vacib — müəllif hüququ

Bot yalnız başlıq + 1–2 cümlə xülasə + link götürür. Tam mətn HEÇ VAXT
saxlanmır — müəllif hüququ pozuntusudur. `src/index.ts` içindəki
`XULASE_UZUNLUGU = 260` sərhədini artırma.

## Nəzarət

- **Loglar:** Worker → `Logs` (real-time).
- **KV məzmunu:** `Storage & databases → KV → rentech-news → KV Pairs` → `news.json` açarı.
- **Cron nəticə:** Worker → `Metrics` → scheduled executions.
- **Admin auth xətası:** ADMIN_TOKEN dəyişib — Settings-dən yenidən oxu və panelə yapışdır.

## Cədvəli dəyişmək

`wrangler.toml`:
```toml
[triggers]
crons = ["0 4,8,15 * * *"]     # UTC — Bakı 08:00, 12:00, 19:00
```

Günə bir dəfə: `["0 6 * * *"]` (Bakı 10:00).
