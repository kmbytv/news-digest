# Инструкция по установке Morning News Digest

> Скопируй этот файл целиком и вставь в чат с Клодом (расширение).
> Клод будет задавать вопросы и вести тебя по шагам.

---

## Что за проект

Утренний дайджест новостей в Telegram. Каждый день в 08:00 МСК бот:
1. Читает 21 RSS-ленту (TechCrunch, HN, VentureBeat, Bloomberg, OpenAI и другие)
2. Скорит статьи по твоим интересам (EWMA)
3. Отправляет дайджест в Telegram с кнопками 👍/👎
4. Учится на твоих оценках

**Важно:** архитектура — GitHub Actions + Cloudflare Worker + Supabase.
Никакого n8n, никакого Railway.

---

## Что уже сделано

- [x] Файлы бота находятся в GitHub репозитории `kmbytv/news-digest`
  - `digest/run.js` — скрипт дайджеста (запускается GitHub Actions)
  - `worker.js` — Cloudflare Worker (принимает лайки от Telegram)
  - `.github/workflows/digest.yml` — запуск каждый день в 08:00 МСК
  - `digest/schema.sql` — структура базы данных Supabase
- [x] Supabase проект создан, schema.sql выполнен
- [x] OpenRouter API ключ получен
- [x] Telegram бот создан, токен и chat_id известны

---

## Что нужно сделать (веди меня по этим шагам)

### Шаг 1 — GitHub секреты

Открой: `https://github.com/kmbytv/news-digest` → Settings → Secrets and variables → Actions → New repository secret

Добавь 5 секретов (спрашивай по одному, жди ответа):

| Название | Значение |
|----------|----------|
| `TELEGRAM_TOKEN` | токен бота (формат: `1234567890:AABBcc...`) |
| `TELEGRAM_CHAT_ID` | твой chat_id (число) |
| `OPENROUTER_API_KEY` | ключ openrouter |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | anon/public ключ из Supabase |

После каждого — подтверди что секрет добавлен.

---

### Шаг 2 — Cloudflare Worker

**2а. Задеплоить воркер:**

Открой: `https://dash.cloudflare.com` → Workers & Pages → Create application → Create Worker

- Нажми **Deploy** (можно с дефолтным кодом — мы потом заменим через wrangler)
- Запомни URL воркера: `https://news-digest.АККАУНТ.workers.dev`

Или задеплой через терминал:
```bash
npx wrangler deploy
```
(потребует логина в Cloudflare через браузер)

**2б. Добавить переменные воркера:**

Открой: Cloudflare Dashboard → Workers → **news-digest** → Settings → Variables and Secrets

Добавь 6 переменных (тип **Secret**):

| Переменная | Значение |
|------------|----------|
| `TELEGRAM_TOKEN` | токен бота |
| `TELEGRAM_CHAT_ID` | твой chat_id |
| `TELEGRAM_WEBHOOK_SECRET` | придумай слово, например `digest2024` |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | anon ключ |
| `OPENROUTER_API_KEY` | ключ openrouter |

После добавления нажми **Save and deploy**.

---

### Шаг 3 — Telegram webhook

Открой браузер или выполни в терминале (замени ТОКЕН, URL и SECRET):

```
https://api.telegram.org/botТВОЙ_ТОКЕН/setWebhook?url=https://news-digest.АККАУНТ.workers.dev/webhook/feedback&allowed_updates=["callback_query","message"]&secret_token=digest2024
```

Должен вернуться ответ: `{"ok":true,"result":true}`

---

### Шаг 4 — Тест

Открой: `https://github.com/kmbytv/news-digest` → Actions → **Morning Digest** → Run workflow → Run workflow

Через 30–60 секунд дайджест должен прийти в Telegram.

Если не пришёл — нажми на запуск и посмотри логи (красный крестик = ошибка → скажи мне текст ошибки).

---

## Помощь при ошибках

Если видишь ошибку в логах GitHub Actions — скажи мне текст ошибки, разберёмся вместе.

Частые проблемы:
- `Missing required env vars` — не все секреты добавлены на шаге 1
- `Telegram sendMessage failed (401)` — неверный TELEGRAM_TOKEN
- `Supabase` ошибка — неверный SUPABASE_URL или SUPABASE_ANON_KEY
- `OpenRouter` ошибка — неверный или исчерпанный OPENROUTER_API_KEY
