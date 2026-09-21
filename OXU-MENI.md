# RenTech — Cloudflare quraşdırma

Sayt, admin PWA və xəbər botu — hamısı Cloudflare-də işləyir.
GitHub yalnız mənbə kodu üçün ehtiyat nüsxə saxlayır.

## Fayl quruluşu

```
repo/
├─ index.html                  ← sayt (public)
├─ admin.html                  ← təsdiq paneli (admin token ilə)
├─ manifest.json, *.svg        ← PWA və logolar
├─ news.json                   ← seed data (KV boş olanda /api/news buraya qayıdır)
├─ functions/api/news.js       ← Pages Function: GET/PUT /api/news
└─ worker/                     ← Cloudflare Worker (bot, cron hər 3 saatda)
   ├─ src/index.ts             ← RSS scrape + Gemini + KV yazı + ntfy
   ├─ wrangler.toml            ← Worker config (cron, KV binding, vars)
   └─ package.json             ← fast-xml-parser dependency
```

## Miqrasiya (bir dəfə edilir)

### 1. Cloudflare hesaba daxil ol
`dash.cloudflare.com` — mövcud hesabla giriş et.

### 2. KV namespace yarat
`Workers & Pages → KV → Create namespace`
- **Adı:** `rentech-news`
- Yaradandan sonra namespace ID-ni kopyala (uzun hex sətir).

### 3. Pages layihəsi yarat (site + API)
`Workers & Pages → Create → Pages → Connect to Git`
- Repo: `pashanaghdaliyev/rentech`
- Branch: `main`
- Build command: **boş qoy** (statik site)
- Build output directory: **boş qoy** (root)
- Deploy et — bir neçə saniyə çəkir.

Sonra `Settings` bölməsinə keç:
- **Environment variables → Production:**
  - `ADMIN_TOKEN` — uzun random sətir yarat (məs. `openssl rand -hex 32`).
    Bu token-ı admin.html paneli girişində istifadə edəcəksən.
    Type: **Secret** seç.
- **Functions → KV namespace bindings:**
  - Variable name: `NEWS_KV`
  - KV namespace: `rentech-news`

Save et. Yeni deploy trigger et (`Deployments → Retry deployment`) ki, yeni ayarlar tətbiq olsun.

### 4. Worker (bot) deploy et
İki yolu var:

**A) wrangler CLI (kompüterdən):**
```bash
cd worker
npm install
npx wrangler login          # brauzerdə auth
# wrangler.toml içində PLACEHOLDER_KV_NAMESPACE_ID sətirini
# KV yaratdığın ID ilə əvəz et
npx wrangler secret put GEMINI_API_KEY      # Gemini açarını yapışdır
npx wrangler secret put NTFY_TOPIC          # ntfy topic adı
npx wrangler secret put ADMIN_TOKEN         # (istəyə görə) manual /run üçün
npx wrangler deploy
```

**B) Dashboard-dan:**
`Workers & Pages → Create → Workers → Deploy` — sonra `worker/src/index.ts` faylının məzmununu quick edit içinə yapışdır.
- Settings → Variables → KV Namespace bindings → `NEWS_KV` → `rentech-news`
- Settings → Variables → Secret → `GEMINI_API_KEY`, `NTFY_TOPIC` əlavə et
- Settings → Triggers → Cron Triggers → `0 4,8,15 * * *`

### 5. Custom domain qoş
Cloudflare Pages layihəsi → `Custom domains → Set up custom domain` → `rentech.az`

Cloudflare bunu tələb edəcək:
- **online.az name server ekranında** Cloudflare-in verdiyi 2 nameserver-i yaz
  (məs. `maya.ns.cloudflare.com`, `rick.ns.cloudflare.com` — panel özü göstərir)
- Yayılma 15 dəq – 24 saat çəkir. Yayıldıqdan sonra HTTPS avtomatik açılır.

### 6. Admin panelə daxil ol
`https://rentech.az/admin.html` aç → yaratdığın `ADMIN_TOKEN` dəyərini daxil et → yadda saxla.

### 7. Botu ilk dəfə əl ilə işə sal
- Dashboard → Workers → `rentech-bot` → `Triggers → Cron` → `Trigger`
- və ya: `curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://rentech-bot.<hesab>.workers.dev/run`

Bir dəqiqədən sonra ntfy telefonuna push gələcək və admin panel boş deyil olacaq.

## Xarici xəbərlərin təsdiqi

Azərbaycan mənbələrindən gələn xəbərlər **birbaşa saytda görünür**.

Xarici mənbədən gələn xəbər Gemini ilə tərcümə olunur, sonra admin panelə
`"gozleyir"` kimi düşür. Telefondan admin.html-i aç → **Dərc et** düyməsi ilə saytda göstərsin.

Niyə əl ilə: maşın tərcüməsi enerji terminlərində səhv edir
(*grid-scale*, *curtailment*, *utility*). Maarifləndirici saytda səhv termin
ən çox zərər verən şeydir — bir dəqiqəlik yoxlama bunun qarşısını alır.

## Mənbə əlavə etmək

`worker/src/index.ts` faylında `MENBELER` massivinə bir sətir yaz:

```ts
{ url: "https://saytin-adi.az/rss", ad: "Sayt adı",
  kateqoriya: "Azərbaycan", suzgec: true, dil: "az" },
```

- `kateqoriya` — saytdakı nişan: `Azərbaycan`, `Dünya`, `Texnologiya`, `Bazar`, `ABŞ`, `Almaniya`, `Çin`
- `suzgec` — `true` olsa, yalnız açar sözlərə uyğun xəbərlər götürülür
- `dil` — `az` birbaşa dərc, `en` / `de` tərcümə + təsdiq gözləyir

Sonra `cd worker && npx wrangler deploy`.

## Vacib — müəllif hüququ

**Bot xəbər yazmır — yalnız başlıq, tarix, 1–2 cümləlik xülasə və
mənbə linkini götürür.** Məqalənin tam mətnini köçürmək müəllif hüququ
pozuntusudur. Saytda hər xəbərin altında "Mənbə: ..." linki görünür, oxucu
tam mətni orada oxuyur. Bu qaydanı dəyişmə.

## Nəzarət

- **Bot işi:** Dashboard → Workers → `rentech-bot` → `Logs` (real-time).
- **Xəbər gəlmirsə:** çox güman lentdə uyğun xəbər olmayıb.
  Bot belə halda köhnə KV-ni olduğu kimi saxlayır, sayt boşalmır.
- **Sayt yüklənmir:** DNS hələ yayılmayıb və ya Cloudflare Pages deploy alınmayıb.
  Pages → Deployments son deploy-un yaşıl olduğunu yoxla.
- **admin panel "auth qəbul olunmadı" deyir:** token dəyişib.
  Pages → Settings → Environment variables → `ADMIN_TOKEN`-ı yenidən oxu və panelin girişinə yapışdır.

## Cədvəli dəyişmək

`worker/wrangler.toml` faylında:
```toml
[triggers]
crons = ["0 4,8,15 * * *"]     # UTC — Bakı 08:00, 12:00, 19:00
```

Günə bir dəfə: `["0 6 * * *"]` (Bakı 10:00).
