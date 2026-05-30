/**
 * Cloudflare Worker — Telegram webhook for Morning News Digest
 *
 * Routes:
 *   POST /webhook/feedback  — Telegram update (callback_query + messages)
 *   GET  /                  — health check
 *
 * Secrets (wrangler secret put / Cloudflare dashboard):
 *   TELEGRAM_TOKEN
 *   TELEGRAM_CHAT_ID
 *   TELEGRAM_WEBHOOK_SECRET
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   OPENROUTER_API_KEY
 *   OPENROUTER_MODEL      (optional, default: google/gemini-2.5-flash)
 *   EMBEDDINGS_API_KEY    (optional — enables semantic taste vector)
 *   EMBEDDINGS_URL        (optional, default: https://api.openai.com/v1/embeddings)
 *   EMBEDDINGS_MODEL      (optional, default: text-embedding-3-small)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook/feedback') {
      return handleTelegramWebhook(request, env);
    }
    return new Response('News Digest Bot is running', { status: 200 });
  },
};

async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = env.TELEGRAM_WEBHOOK_SECRET || '';
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update;
  try { update = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const TG    = env.TELEGRAM_TOKEN;
  const BASE  = env.SUPABASE_URL;
  const SKEY  = env.SUPABASE_ANON_KEY;
  const OWNER = env.TELEGRAM_CHAT_ID || '';
  const sh     = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };
  const shJson = { ...sh, 'Content-Type': 'application/json' };

  const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const sbGet   = path => fetch(`${BASE}/rest/v1/${path}`, { headers: sh }).then(r => r.json());
  const sbPatch = (path, body) => fetch(`${BASE}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...shJson, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  const sbPost  = (path, body) => fetch(`${BASE}/rest/v1/${path}`, {
    method: 'POST', headers: { ...shJson, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });

  const cq  = update?.callback_query;
  const msg = update?.message;

  // ── /stats ──────────────────────────────────────────────────────────────────
  if (msg?.text?.trim().startsWith('/stats')) {
    const chatId = String(msg.chat?.id || '');
    try {
      const profRes = await sbGet('interest_profile?id=eq.1');
      const p = (Array.isArray(profRes) ? profRes[0] : profRes) || {};
      const pct = w => (w * 100).toFixed(0) + '%';
      const topSrc = Object.entries(p.sources  || {}).sort((a,b) => b[1]-a[1]).slice(0,5)
        .map(([s,w]) => `  ${s}  ${pct(w)}`).join('\n') || '  —';
      const topKw  = Object.entries(p.keywords || {}).sort((a,b) => b[1]-a[1]).slice(0,10)
        .map(([k,w]) => `  #${k}  ${pct(w)}`).join('\n') || '  —';
      await tgApi('sendMessage', { chat_id: chatId, text: [
        '📊 Твой профиль интересов', '',
        `Всего оценок (👍+👎): ${p.total_feedbacks || 0}`, '',
        '🌐 Топ источники:', topSrc, '',
        '🔑 Топ темы:', topKw,
      ].join('\n') });
    } catch (e) { console.error('stats:', e); }
    return new Response('ok');
  }

  // ── Free text → deep dive ───────────────────────────────────────────────────
  if (msg?.text && !msg.text.startsWith('/') && (!OWNER || String(msg.chat?.id) === OWNER)) {
    const chatId = String(msg.chat?.id || '');
    const text   = msg.text.trim().toLowerCase();
    try {
      const today = new Date().toISOString().slice(0, 10);
      let arts = await sbGet(`articles?digest_id=eq.${today}&order=score.desc`);
      if (!Array.isArray(arts) || !arts.length) {
        const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
        arts = await sbGet(`articles?digest_id=eq.${yest}&order=score.desc`);
      }
      if (!Array.isArray(arts) || !arts.length) {
        await tgApi('sendMessage', { chat_id: chatId, text: 'Дайджест ещё не приходил сегодня — попробуй позже.' });
        return new Response('ok');
      }

      const ords = { 'перв':1,'втор':2,'трет':3,'четверт':4,'пят':5,'шест':6,'седьм':7 };
      let target = null;
      const mnum = text.match(/\b(\d{1,2})\b/);
      if (mnum) target = arts[parseInt(mnum[1]) - 1];
      if (!target) { for (const [k,v] of Object.entries(ords)) { if (text.includes(k)) { target = arts[v-1]; break; } } }
      if (!target) {
        const stop = new Set(['про','расскажи','подробнее','что','это','новость','статью','более']);
        const qt = new Set(text.split(/[^a-zа-яё0-9]+/).filter(w => w.length > 3 && !stop.has(w)));
        let best = null, bs = 0;
        for (const a of arts) {
          const tt = (a.title || '').toLowerCase();
          let s = 0; for (const w of qt) if (tt.includes(w)) s++;
          if (s > bs) { bs = s; best = a; }
        }
        target = bs > 0 ? best : arts[0];
      }

      let full = '';
      try {
        const r = await fetch(target.link, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await r.text();
        full = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
          .replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim().slice(0,5000);
      } catch {}

      const material = full.length > 200 ? full : target.title;
      const prompt = `Сделай подробный разбор этой новости на русском языке. Структура: 1) Что произошло. 2) Почему важно. 3) Контекст. 4) Что значит на практике.\n\nЗаголовок: ${target.title}\n\nТекст:\n${material}`;
      const lr = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash', messages: [{ role:'user', content: prompt }] }),
      });
      const lrd = await lr.json();
      const body = lrd?.choices?.[0]?.message?.content || 'Не удалось разобрать статью.';
      await tgApi('sendMessage', { chat_id: chatId, text: `🔍 ${target.title}\n\n${body.slice(0,3500)}\n\n→ ${target.link}`, disable_web_page_preview: true });
    } catch (e) {
      console.error('deep dive:', e);
      await tgApi('sendMessage', { chat_id: chatId, text: 'Что-то пошло не так — попробуй ещё раз.' });
    }
    return new Response('ok');
  }

  // ── callback_query: like / dislike ──────────────────────────────────────────
  if (!cq) return new Response('ok');

  const [action, idStr] = (cq.data || '').split(':');
  const articleId = parseInt(idStr);
  const isLike    = action === 'like'    && articleId > 0;
  const isDislike = action === 'dislike' && articleId > 0;
  if (!isLike && !isDislike) { await tgApi('answerCallbackQuery', { callback_query_id: cq.id }); return new Response('ok'); }

  await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: isLike ? '✅ Отмечено' : '👎 Учтено' });

  try {
    const [artRes, profRes] = await Promise.all([
      sbGet(`articles?id=eq.${articleId}&select=*`),
      sbGet('interest_profile?id=eq.1'),
    ]);
    const article = Array.isArray(artRes)  ? artRes[0]  : artRes;
    const profile = (Array.isArray(profRes) ? profRes[0] : profRes) || { sources:{}, keywords:{}, total_feedbacks:0 };
    if (!article) return new Response('ok');

    const ALPHA = 0.2, signal = isLike ? 1.0 : 0.0;
    const sources  = { ...profile.sources  };
    const keywords = { ...profile.keywords };
    if (article.source) sources[article.source] = ALPHA*signal + (1-ALPHA)*(sources[article.source]||0.5);
    for (const kw of (article.keywords||[])) keywords[kw] = ALPHA*signal + (1-ALPHA)*(keywords[kw]||0.5);

    const ops = [sbPatch('interest_profile?id=eq.1', { sources, keywords, total_feedbacks:(profile.total_feedbacks||0)+1, updated_at:new Date().toISOString() })];
    if (isLike) ops.push(sbPost('feedback', { article_id: articleId }));
    await Promise.all(ops);

    // Optional taste vector update
    const embKey = env.EMBEDDINGS_API_KEY;
    if (isLike && embKey) {
      try {
        const er = await fetch(env.EMBEDDINGS_URL||'https://api.openai.com/v1/embeddings', {
          method:'POST', headers:{ Authorization:`Bearer ${embKey}`, 'Content-Type':'application/json' },
          body: JSON.stringify({ model: env.EMBEDDINGS_MODEL||'text-embedding-3-small', input: `${article.title}. ${(article.keywords||[]).join(', ')}`.slice(0,800) }),
        });
        const ed  = await er.json();
        const emb = ed.data?.[0]?.embedding;
        if (emb) {
          const tr  = await sbGet('taste_vector?id=eq.1');
          const t   = Array.isArray(tr) ? tr[0] : tr;
          const old = t?.vector, n = t?.n || 0, A = 0.2;
          const nv  = (old && old.length===emb.length) ? old.map((v,i)=>A*emb[i]+(1-A)*v) : emb;
          await sbPatch('taste_vector?id=eq.1', { vector:nv, n:n+1, updated_at:new Date().toISOString() });
        }
      } catch (e) { console.warn('taste:', e.message); }
    }
  } catch (e) { console.error('feedback:', e); }

  return new Response('ok');
}
