'use strict';

// Morning News Digest — standalone Node.js runner
// Mirrors the logic from digest/workflow.json
// Requires Node 20+ (built-in fetch) and rss-parser npm package

const Parser = require('rss-parser');

// ─── Config ────────────────────────────────────────────────────────────────
const BASE  = process.env.SUPABASE_URL;
const SKEY  = process.env.SUPABASE_ANON_KEY;
const TG    = process.env.TELEGRAM_TOKEN;
const CHAT  = process.env.TELEGRAM_CHAT_ID;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const EMB_KEY   = process.env.EMBEDDINGS_API_KEY || '';
const EMB_URL   = process.env.EMBEDDINGS_URL   || 'https://api.openai.com/v1/embeddings';
const EMB_MODEL = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
const RETENTION_DAYS = Number(process.env.DIGEST_RETENTION_DAYS) || 14;

// ─── Constants ──────────────────────────────────────────────────────────────
const FEEDS = [
  'https://techcrunch.com/feed/',
  'https://feeds.feedburner.com/venturebeat/SZYF',
  'https://www.theverge.com/rss/index.xml',
  'https://a16z.com/feed/',
  'https://news.ycombinator.com/rss',
  'https://www.marktechpost.com/feed/',
  'https://venturebeat.com/category/ai/feed/',
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://openai.com/news/rss/',
  'https://huggingface.co/blog/feed.xml',
  'https://simonwillison.net/atom/everything/',
  'https://bensbites.beehiiv.com/feed',
  'https://inc.com/rss',
  'https://www.producthunt.com/feed',
  'https://techcrunch.com/category/venture/feed/',
  'https://avc.com/feed',
  'https://openvc.app/blog/rss',
  'https://feeds.bloomberg.com/economics/news.rss',
  'https://www.economist.com/finance-and-economics/rss.xml',
  'https://www.ft.com/economics?format=rss',
  'https://feeds.businessinsider.com/custom/all',
];

const KEYWORDS = [
  'ai', 'llm', 'gpt', 'agent', 'model', 'startup', 'funding', 'seed', 'series',
  'raises', 'launch', 'product', 'saas', 'economy', 'market', 'inflation',
  'open source', 'gemini', 'claude', 'openai', 'anthropic', 'nvidia', 'vc',
  'venture', 'acquire', 'ipo',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fetch with an AbortController timeout. Returns null on error. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    return resp;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title) {
  return new Set(
    title.toLowerCase().split(/[^a-zA-Z0-9Ѐ-ӿ]+/).filter(w => w.length > 3)
  );
}

function isDuplicate(a, b) {
  const sa = titleTokens(a.title);
  const sb = titleTokens(b.title);
  if (sa.size === 0 || sb.size === 0) return false;
  let overlap = 0;
  for (const w of sa) if (sb.has(w)) overlap++;
  const jaccard = overlap / (sa.size + sb.size - overlap);
  return overlap >= 2 && jaccard >= 0.3;
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SKEY,
    Authorization: `Bearer ${SKEY}`,
    ...extra,
  };
}

// ─── Step 1: Fetch RSS feeds ─────────────────────────────────────────────────
async function fetchAllFeeds() {
  const parser = new Parser({ timeout: 10000 });
  const results = await Promise.all(
    FEEDS.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        return feed.items || [];
      } catch (e) {
        console.error(`[RSS] Failed to fetch ${url}: ${e.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

// ─── Step 2: Load interest profile from Supabase ─────────────────────────────
async function loadProfile() {
  try {
    const resp = await fetchWithTimeout(
      `${BASE}/rest/v1/interest_profile?id=eq.1`,
      { headers: supabaseHeaders() },
      10000
    );
    if (!resp || !resp.ok) return { sources: {}, keywords: {} };
    const data = await resp.json();
    const raw = Array.isArray(data) ? data[0] : data;
    return raw || { sources: {}, keywords: {} };
  } catch (e) {
    console.error(`[Profile] Failed to load interest profile: ${e.message}`);
    return { sources: {}, keywords: {} };
  }
}

// ─── Step 3: Filter (last 24h) & Score (EWMA) ───────────────────────────────
function filterAndScore(rawItems, profile) {
  const srcW = profile.sources || {};
  const kwW  = profile.keywords || {};
  const now  = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const articles = [];

  for (const d of rawItems) {
    if (!d || !d.title || d.error) continue;

    let articleDate = null;
    const dateStr = d.isoDate || d.pubDate || d.date;
    if (dateStr) {
      try { articleDate = new Date(dateStr); } catch (e) {}
    }
    if (articleDate && !isNaN(articleDate) && articleDate < oneDayAgo) continue;

    const title   = String(d.title || '').trim().slice(0, 200);
    const link    = String(d.link || d.url || '').trim();
    if (!title || !link) continue;

    const snippet = stripHtml(
      String(d.contentSnippet || d.summary || d.description || d.content || '')
    ).slice(0, 500);

    let source = '';
    try { source = new URL(link).hostname.replace('www.', ''); } catch (e) {}

    const text = (title + ' ' + snippet).toLowerCase();
    const kws  = KEYWORDS.filter(k => text.includes(k));

    const hours    = articleDate ? (now - articleDate) / 3_600_000 : 12;
    const fresh    = Math.exp(-0.05 * hours);
    const kwScore  = kws.length ? kws.reduce((s, k) => s + (kwW[k] || 0.5), 0) / kws.length : 0.5;
    const srcScore = srcW[source] || 0.5;
    const score    = kwScore * srcScore * fresh;

    articles.push({ title, link, snippet, source, keywords: kws, score });
  }

  articles.sort((a, b) => b.score - a.score);
  return articles;
}

// ─── Step 4: Deduplicate + Step 5: Trend detection ──────────────────────────
function deduplicateAndDetectTrends(articles) {
  const TREND_MIN = 3;
  const clusters = [];

  for (const art of articles) {
    const c = clusters.find(cl => isDuplicate(cl.rep, art));
    if (c) {
      c.sources.add(art.source);
    } else {
      clusters.push({ rep: art, sources: new Set([art.source]) });
    }
  }

  for (const c of clusters) {
    const n = c.sources.size;
    c.rep.sourceCount = n;
    c.rep.trending = n >= TREND_MIN;
    if (c.rep.trending) c.rep.score *= (1 + 0.3 * (n - 1));
  }

  return clusters.map(c => c.rep).sort((a, b) => b.score - a.score);
}

// ─── Step 6: Optional semantic rerank ───────────────────────────────────────
async function semanticRerank(articles) {
  if (!EMB_KEY || !articles.length) return articles;

  try {
    const cand   = articles.slice(0, 30);
    const inputs = cand.map(a => (String(a.title || '') + '. ' + String(a.snippet || '')).slice(0, 800));

    const embResp = await fetchWithTimeout(
      EMB_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${EMB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMB_MODEL, input: inputs }),
      },
      20000
    );
    if (!embResp || !embResp.ok) throw new Error(`Embeddings API returned ${embResp?.status}`);
    const embData = await embResp.json();
    const vecs = (embData.data || []).map(d => d.embedding);
    cand.forEach((a, i) => { a.embedding = vecs[i]; });

    // Try loading taste vector from Supabase
    let taste = null;
    try {
      const tr = await fetchWithTimeout(
        `${BASE}/rest/v1/taste_vector?id=eq.1`,
        { headers: supabaseHeaders() },
        8000
      );
      if (tr && tr.ok) {
        const td = await tr.json();
        const t = Array.isArray(td) ? td[0] : td;
        if (t && Array.isArray(t.vector) && (t.n || 0) > 0) taste = t.vector;
      }
    } catch (e) {
      // taste vector unavailable — skip
    }

    if (taste) {
      for (const a of cand) {
        if (!Array.isArray(a.embedding)) continue;
        const cos = cosine(taste, a.embedding);
        a.semCos = cos;
        a.score *= (1 + 0.5 * Math.max(0, cos));
      }
      articles.sort((x, y) => y.score - x.score);
    }
  } catch (e) {
    console.error(`[Embeddings] Semantic rerank failed, falling back to keyword scoring: ${e.message}`);
  }

  return articles;
}

// ─── Step 7: Store top-40 articles in Supabase ───────────────────────────────
async function storeArticles(articles) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = articles.slice(0, 40).map(a => ({
    digest_id: today,
    title:     a.title,
    link:      a.link,
    source:    a.source,
    keywords:  a.keywords,
    score:     a.score,
  }));

  const resp = await fetchWithTimeout(
    `${BASE}/rest/v1/articles`,
    {
      method: 'POST',
      headers: supabaseHeaders({
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
      }),
      body: JSON.stringify(rows),
    },
    15000
  );

  if (!resp || !resp.ok) {
    const body = await resp?.text();
    console.error(`[Supabase] Store articles failed (${resp?.status}): ${body}`);
    return [];
  }

  const stored = await resp.json();
  return Array.isArray(stored) ? stored : [];
}

// ─── Step 8: Fetch full text for top-10 articles ─────────────────────────────
async function fetchFullText(url) {
  try {
    const resp = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsDigestBot/1.0)' } },
      8000
    );
    if (!resp || !resp.ok) return '';
    const html = await resp.text();
    return stripHtml(html).slice(0, 2500);
  } catch (e) {
    return '';
  }
}

// ─── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — умный друг Даниила который каждое утро рассказывает ему что важного случилось в мире технологий, стартапов и экономики. Не новостной агрегатор, а собеседник который реально понимает темы и умеет объяснить их так, чтобы было интересно и понятно.

Даниилу 16 лет. Он учит AI, кодинг, экономику (по Mankiw), интересуется стартапами и геополитикой. Готовится к переезду в Японию. В экономике разбирается хорошо — лёгкие и средние модели понимает сам. А вот в коде и AI почти ноль: технические термины и структуры нужно объяснять с самого начала.

-----

ЧТО ТЫ ПОЛУЧАЕШЬ

Полные тексты статей с английских сайтов (TechCrunch, FT, MarkTechPost, The Verge и др.). Твоя работа — прочитать их целиком и выжать суть, а не пересказать заголовок.

Некоторые статьи помечены значком [ГОРЯЧЕЕ] — это пометка парсера, означает что тему освещают несколько источников. Значит тема горячая, дай ей больше внимания. Сам значок в дайджест не переноси (твой вывод без эмодзи).

-----

ГЛАВНЫЙ ПРИНЦИП: МЕНЬШЕ, НО ГЛУБЖЕ

Не вали 15 новостей. Выбери 5 самых важных историй дня и разбери каждую по-настоящему.

Лучше одна история которую Даниил поймёт и запомнит, чем десять которые он пролистает.

Критерий отбора истории:
- Это реально меняет что-то (не "компания X выпустила обновление")
- Это интересно или неожиданно
- Из этого можно что-то понять про то как устроен мир

Если хороших историй больше 5 — приоритет тем что ближе к жизни Даниила:
1. AI-интеграция и автоматизация бизнеса — он на этом зарабатывает на фрилансе, такие новости для него рабочий инструмент
2. Япония — экономика, технологии, общество. Он туда переезжает
3. Стартапы один-в-один как он мог бы делать — маленькие команды, AI-продукты, понятная бизнес-модель
4. Экономические кейсы которые перекликаются с тем что он учит по Mankiw
5. Всё остальное

То есть из двух AI-новостей выбирай ту что практичнее для фрилансера, а не самую громкую корпоративную.

-----

СТРУКТУРА ИСТОРИИ

Без эмодзи. Категории и разделы отчерчиваются текстом — заглавными буквами и линиями.

Каждая из 5 историй — по этому шаблону:

────────────────────────
[КАТЕГОРИЯ]
[Заголовок — живая фраза, не сухой заголовок статьи]
[Что случилось — 2-3 предложения простым языком]
Почему это важно: [1-2 предложения — последствия, контекст, к чему ведёт]
Ссылка: [url]

5 слотов по темам:
1. [AI / ТЕХНОЛОГИИ] — объясняй с нуля (Даниил тут новичок)
2. [СТАРТАП] — конкретная компания, раунд, история фаундера. Бизнес-часть объясняй нормально, техническую (если стартап про AI) — с нуля
3. [ЭКОНОМИКА] — кейс рынка или компании. Можно экономическим языком
4. [ГЕОПОЛИТИКА] — страновая ситуация
5. [ИНТЕРЕСНОЕ] — наука, Япония, что-то неожиданное

Правила слотов:
- Если новость подходит под две категории — положи в ОДНУ, ту что точнее, не дублируй.
- Если годных историй меньше 5 — лучше дай 3-4 сильных, чем добивай слабыми. Если день пустой — так и скажи: "Сегодня тихо, всего три истории стоят внимания."
- Если по теме нет ничего — пропусти слот или замени темой где новость есть.

-----

КАК ПИСАТЬ — КРИТИЧЕСКИ ВАЖНО

ТОН:
- Пиши как умный друг за завтраком, а не как пресс-релиз
- Можно живо, с характером, с лёгкой иронией где уместно
- Но факты — точные, без выдумок

ПРОСТОТА ЯЗЫКА:
Экономика и финансы — Даниил тут в теме. Объясняй только реально сложные модели и редкие термины. Не разжёвывай инфляцию, спрос-предложение, базовые раунды инвестиций.
AI, код, технические структуры — Даниил тут почти ноль. Объясняй с нуля. Любой термин обязательно объясни простой фразой. Например: "fine-tuning (дообучение готовой модели под конкретную задачу)", "inference (момент когда модель уже работает и отвечает, а не учится)", "API (способ одной программы дёргать другую)".

Запрещённые слова без объяснения: экосистема, нарратив, вертикаль, имплементация, трекшн, юзкейс, синергия.

- Одна мысль = одно предложение. Короткие предложения.
- Тест перед отправкой по технике: понял бы это человек который про AI знает только слово "нейросеть"? Если нет — перепиши.

ПЕРЕВОД:
- Источники английские — переводи смысл, а не слова
- Никакого корявого дословного перевода. Пиши как будто изначально писал на русском.

-----

ФИНАЛ ДАЙДЖЕСТА

После 5 историй — финальный блок:

────────────────────────
МЫСЛЬ ДНЯ
[одно наблюдение которое связывает что-то из сегодняшних новостей с чем-то большим — паттерн, тренд, урок]

Сильная мысль дня:
- связывает 2+ истории в один паттерн
- или вытаскивает урок применимый к Даниилу
- или замечает что-то неочевидное

Если связать истории не получается честно — лучше дай один точный вывод по самой важной из них, чем натягивай ложную связь.

-----

ФОРМАТ ВЫВОДА ЦЕЛИКОМ:

ДАЙДЖЕСТ — {дата}
════════════════════════
────────────────────────
[AI / ТЕХНОЛОГИИ]
[заголовок]
[что случилось]
Почему это важно: ...
Ссылка: [url]
────────────────────────
[СТАРТАП]
...
[и так 5 историй]
────────────────────────
МЫСЛЬ ДНЯ
...

-----

ЧЕГО НЕ ДЕЛАТЬ:
- Не пиши "это подчёркивает растущий спрос" и подобный пустой пресс-релизный язык
- Не оставляй термин без объяснения
- Не делай больше 5 историй
- Не пересказывай заголовок — ты прочитал полный текст, используй его
- Не выдумывай факты которых нет в статье`;

// ─── Step 9: Build LLM prompt ────────────────────────────────────────────────
async function buildPrompt(articles) {
  const N    = 10;
  const head = articles.slice(0, N);

  console.log('[Prompt] Fetching full text for top-10 articles...');
  const texts = await Promise.all(head.map(a => fetchFullText(a.link)));
  head.forEach((a, i) => { a.fullText = texts[i]; });

  const today = new Date().toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
  });

  const NL = '\n';
  const lines = articles.slice(0, 40).map(a => {
    const flag = a.trending ? ` [ГОРЯЧЕЕ — пишут ${a.sourceCount} источников]` : '';
    const parts = [`Заголовок: ${a.title}${flag}`];
    const hasFull = a.fullText && a.fullText.length > 200;
    const bodyText = hasFull ? a.fullText : a.snippet;
    if (bodyText) parts.push((hasFull ? 'Текст статьи: ' : 'Описание: ') + bodyText);
    parts.push('Ссылка: ' + a.link);
    return parts.join(NL);
  });
  const articlesText = lines.join(NL + NL + '---' + NL + NL);

  const userPrompt = [
    `Вот статьи за сегодня (${today}). Для большинства дан полный текст — используй его, а не только заголовок.`,
    articlesText,
    `Составь дайджест за ${today}.`,
  ].join(NL + NL);

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

// ─── Step 10: Call OpenRouter LLM ────────────────────────────────────────────
async function callLLM(systemPrompt, userPrompt) {
  const resp = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OR_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    },
    90000
  );

  if (!resp || !resp.ok) {
    const body = await resp?.text();
    throw new Error(`OpenRouter API error (${resp?.status}): ${body}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned empty content');
  return text.slice(0, 4000);
}

// ─── Step 11: Send digest text to Telegram ───────────────────────────────────
async function sendTelegramMessage(text) {
  const resp = await fetchWithTimeout(
    `https://api.telegram.org/bot${TG}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text }),
    },
    15000
  );
  if (!resp || !resp.ok) {
    const body = await resp?.text();
    throw new Error(`Telegram sendMessage failed (${resp?.status}): ${body}`);
  }
  return resp.json();
}

// ─── Step 12: Send like/dislike keyboard ─────────────────────────────────────
async function sendLikeKeyboard(storedArticles) {
  const buttons = storedArticles.slice(0, 15).map(a => ([
    { text: '👍 ' + String(a.title).slice(0, 32), callback_data: 'like:'    + a.id },
    { text: '👎',                                   callback_data: 'dislike:' + a.id },
  ]));

  const resp = await fetchWithTimeout(
    `https://api.telegram.org/bot${TG}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      CHAT,
        text:         'Оцени статьи 👍 или 👎 — бот учится на твоих оценках:',
        reply_markup: JSON.stringify({ inline_keyboard: buttons }),
      }),
    },
    15000
  );
  if (!resp || !resp.ok) {
    const body = await resp?.text();
    console.error(`[Telegram] Keyboard send failed (${resp?.status}): ${body}`);
  }
}

// ─── Step 13: Cleanup old articles ───────────────────────────────────────────
async function cleanupOldArticles() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString().slice(0, 10);
  try {
    const resp = await fetchWithTimeout(
      `${BASE}/rest/v1/articles?digest_id=lt.${cutoff}`,
      {
        method: 'DELETE',
        headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
      },
      15000
    );
    if (!resp || !resp.ok) {
      const body = await resp?.text();
      console.error(`[Supabase] Cleanup failed (${resp?.status}): ${body}`);
    } else {
      console.log(`[Cleanup] Deleted articles older than ${cutoff}`);
    }
  } catch (e) {
    console.error(`[Cleanup] Error during cleanup: ${e.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Validate required env vars
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'OPENROUTER_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[Config] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Fire off cleanup in background — don't await yet
  const cleanupPromise = cleanupOldArticles();

  // ── 1. Fetch RSS feeds ──
  console.log('[Step 1] Fetching RSS feeds...');
  const rawItems = await fetchAllFeeds();
  console.log(`[Step 1] Fetched ${rawItems.length} raw items`);

  // ── 2. Load interest profile ──
  console.log('[Step 2] Loading interest profile...');
  const profile = await loadProfile();

  // ── 3. Filter & Score ──
  console.log('[Step 3] Filtering and scoring articles...');
  const scored = filterAndScore(rawItems, profile);
  console.log(`[Step 3] ${scored.length} articles from last 24h`);

  // ── 4+5. Deduplicate & Trend Detection ──
  console.log('[Step 4] Deduplicating and detecting trends...');
  const deduped = deduplicateAndDetectTrends(scored);
  const trendCount = deduped.filter(a => a.trending).length;
  console.log(`[Step 4] ${deduped.length} unique articles, ${trendCount} trending`);

  // ── Check: exit if zero articles ──
  if (deduped.length === 0) {
    console.error('[Fatal] No articles found after filtering. Exiting.');
    process.exit(1);
  }

  // ── 6. Semantic rerank (optional) ──
  console.log('[Step 6] Semantic rerank...');
  const articles = await semanticRerank(deduped);

  // ── 7. Store top-40 in Supabase ──
  console.log('[Step 7] Storing articles in Supabase...');
  const stored = await storeArticles(articles);
  console.log(`[Step 7] Stored ${stored.length} articles`);

  // ── 8+9. Fetch full text & Build prompt ──
  console.log('[Step 9] Building LLM prompt...');
  const { systemPrompt, userPrompt } = await buildPrompt(articles);

  // ── 10. Call LLM ──
  console.log('[Step 10] Calling OpenRouter LLM...');
  let digestText;
  try {
    digestText = await callLLM(systemPrompt, userPrompt);
  } catch (e) {
    console.error(`[LLM] Error: ${e.message}`);
    digestText = '⚠️ Не удалось получить дайджест от LLM. Проверьте OPENROUTER_API_KEY и лимиты.';
  }

  // ── 11. Send digest to Telegram ──
  console.log('[Step 11] Sending digest to Telegram...');
  await sendTelegramMessage(digestText);

  // ── 12. Send like/dislike keyboard ──
  console.log('[Step 12] Sending like/dislike keyboard...');
  // Use stored articles (have .id) for keyboard; fall back to scored list
  const keyboardSource = stored.length > 0 ? stored : articles;
  await sendLikeKeyboard(keyboardSource);

  // ── 13. Wait for cleanup ──
  await cleanupPromise;

  console.log('[Done] Morning digest sent successfully.');
}

main().catch(e => {
  console.error('[Fatal]', e);
  process.exit(1);
});
