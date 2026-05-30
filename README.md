# Morning News Digest

21 RSS-лента → EWMA-скоринг → дедупликация → тренды → OpenRouter LLM → Telegram.
Каждый день в **08:00 МСК**. Учится на твоих 👍/👎. Отвечает на вопросы по статьям.

## Архитектура

| Что | Где | Зачем |
|-----|-----|-------|
| Ежедневный запуск | **GitHub Actions** | бесплатный cron, `digest/run.js` |
| Кнопки 👍/👎, `/stats`, разбор статей | **Cloudflare Worker** | `worker.js`, маршрут `/webhook/feedback` |
| Статьи, профиль, история | **Supabase** | бесплатно, `digest/schema.sql` |
| LLM | **OpenRouter** | Gemini 2.5 Flash, ~$0.06/месяц |

## Быстрый старт

### 1. Supabase (5 минут)
1. [supabase.com](https://supabase.com) → New project
2. SQL Editor → вставь содержимое `digest/schema.sql` → Run
3. Settings → API → скопируй **Project URL** и **anon public key**

### 2. OpenRouter (2 минуты)
[openrouter.ai](https://openrouter.ai) → Keys → Create key

### 3. GitHub секреты (3 минуты)
Settings → Secrets and variables → Actions → добавь:
```
TELEGRAM_TOKEN          — токен бота
TELEGRAM_CHAT_ID        — твой chat_id
OPENROUTER_API_KEY      — ключ openrouter
SUPABASE_URL            — https://xxxx.supabase.co
SUPABASE_ANON_KEY       — anon/public ключ

# Опционально:
OPENROUTER_MODEL        — дефолт: google/gemini-2.5-flash
DIGEST_RETENTION_DAYS   — дефолт: 14 дней
EMBEDDINGS_API_KEY      — включает семантический профиль
```

### 4. Cloudflare Worker (3 минуты)
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```
Затем в Cloudflare Dashboard → Workers → news-digest → Settings → Variables:
```
TELEGRAM_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET   — придумай любое слово (например: mysecret123)
SUPABASE_URL
SUPABASE_ANON_KEY
OPENROUTER_API_KEY
```

### 5. Зарегистрировать Telegram webhook (30 секунд)
```bash
curl -X POST "https://api.telegram.org/botТВОЙ_ТОКЕН/setWebhook" \
  -d "url=https://news-digest.АККАУНТ.workers.dev/webhook/feedback" \
  -d 'allowed_updates=["callback_query","message"]' \
  -d "secret_token=mysecret123"
```

### 6. Проверка
GitHub → Actions → **Morning Digest** → **Run workflow** → через 30 сек дайджест в Telegram.

---

## Что умеет бот

| Команда / действие | Результат |
|---|---|
| 08:00 МСК каждый день | дайджест с кнопками 👍/👎 на каждую статью |
| `/stats` | профиль интересов: топ источники и темы с весами % |
| *«расскажи про третью»* | полный разбор статьи: суть / почему важно / контекст |
| *«подробнее про OpenAI»* | то же, поиск по совпадению слов с заголовком |

---

## Как работает обучение

**EWMA-профиль (keyword + source скоринг):**
```
profile[x] = 0.2 × signal + 0.8 × старое_значение
```
👍 → signal 1.0 (вес растёт), 👎 → signal 0.0 (вес падает).

**Скоринг каждой статьи:**
```
score = kwScore × srcScore × e^(−0.05 × часов_с_публикации)
```

**Тренд-радар 🔥:**
Статьи кластеризуются по пересечению слов заголовка. 3+ источника на одну тему → статья помечается 🔥, получает буст.

**Семантический вектор вкуса** (если задан `EMBEDDINGS_API_KEY`):
EWMA эмбеддингов всех лайкнутых статей. При утреннем запуске кандидаты реранжируются по косинусной близости к вектору: `score × (1 + 0.5 × cosine)`.

---

## Файлы

```
digest/
  run.js                — основной скрипт (GitHub Actions)
  schema.sql            — Supabase: articles, feedback, interest_profile, taste_vector
  workflow.json         — n8n-воркфлоу (альтернативный вариант деплоя)
  workflow_feedback.json
  workflow_weekly.json
  deploy.sh             — деплой в n8n

.github/workflows/
  digest.yml            — GitHub Actions cron (08:00 МСК)

worker.js               — Cloudflare Worker: /webhook/feedback
wrangler.toml           — Cloudflare конфиг
package.json            — зависимость: rss-parser
```

## Альтернатива: n8n

Импортируй воркфлоу вручную: Workflows → Import → `digest/workflow.json`, затем `workflow_feedback.json`, `workflow_weekly.json`.

Или задеплой скриптом:
```bash
N8N_URL=... N8N_API_KEY=... bash digest/deploy.sh
```
