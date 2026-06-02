import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

/* ─────────────────────────────────────────────
   ENV VALIDATION
───────────────────────────────────────────── */
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) { console.error(`Missing ENV: ${key}`); process.exit(1); }
}

/* ─────────────────────────────────────────────
   APP SETUP
───────────────────────────────────────────── */
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://xeerhub.com',
    'https://www.xeerhub.com',
    'http://localhost:3000',
    'http://localhost:5500',
  ],
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─────────────────────────────────────────────
   CACHE  (LRU-style, 300 entries max)
───────────────────────────────────────────── */
const cache = new Map();
function cacheSet(k, v) {
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

/* ─────────────────────────────────────────────
   STOP WORDS
───────────────────────────────────────────── */
const STOP = new Set([
  'what','when','where','which','who','how','does','can','the','and','for',
  'are','that','this','with','have','from','will','been','they','also','into',
  'its','not','but','any','all','more','must','their','your','there','under',
  'after','only','both','each','such','some','than','then','made','make',
  'same','most','other','may','is','in','of','to','a','an','on','at','by',
  'do','if','it','me','my','no','or','so','up','us','we','was','has','had',
]);

function extractKeywords(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

/* ─────────────────────────────────────────────
   RETRIEVAL
   Three tiers — all use text only, no embeddings needed.

   BUG FIXED: old code used type:'plain' with |-joined terms.
   Postgres plain tsquery does NOT support | — it treated the
   whole string as one token, so multi-word questions returned
   nothing and Groq hallucinated to fill the empty context.

   Fix: websearch type handles AND/OR/phrase naturally, and we
   also have ILIKE + keyword fallbacks so we never send Groq
   an empty context.
───────────────────────────────────────────── */

/**
 * Tier 1 — native full-text search via tsvector column.
 * Requires a GIN-indexed `text_search` tsvector column.
 * Returns null (not []) if the column doesn't exist so we can fall through.
 */
async function tier1_fts(keywords) {
  if (!keywords.length) return null;

  // websearch_to_tsquery: treats each word as AND by default, supports phrases
  // "maternity leave" → works; "charcoal" → works; "foreign investor rights" → works
  const query = keywords.slice(0, 8).join(' ');

  const { data, error } = await supabase
    .from('laws')
    .select('id, law_name, article_number, title, text')
    .textSearch('text_search', query, { type: 'websearch', config: 'english' })
    .limit(5);

  if (error) {
    // Column missing or no GIN index — fall through silently
    console.warn('[FTS] unavailable:', error.message);
    return null;
  }
  return data || [];
}

/**
 * Tier 2 — ILIKE on title column (fast with B-tree index on title).
 * Tries each keyword independently and merges unique results.
 */
async function tier2_ilike(keywords) {
  if (!keywords.length) return [];

  const results = new Map(); // deduplicate by id

  // Try the top 3 most specific keywords
  for (const kw of keywords.slice(0, 3)) {
    const { data } = await supabase
      .from('laws')
      .select('id, law_name, article_number, title, text')
      .ilike('title', `%${kw}%`)
      .limit(4);
    (data || []).forEach(r => results.set(r.id, r));
  }

  return [...results.values()];
}

/**
 * Tier 3 — ILIKE on text column.
 * Slower but catches articles where the keyword is in the body, not the title.
 */
async function tier3_fulltext_ilike(keywords) {
  if (!keywords.length) return [];

  const results = new Map();

  for (const kw of keywords.slice(0, 2)) {
    const { data } = await supabase
      .from('laws')
      .select('id, law_name, article_number, title, text')
      .ilike('text', `%${kw}%`)
      .limit(4);
    (data || []).forEach(r => results.set(r.id, r));
  }

  return [...results.values()];
}

/**
 * Score a row against query keywords.
 * Used to re-rank ILIKE results (which only filter, not rank).
 */
function scoreRow(row, keywords) {
  const hay = (row.title + ' ' + row.text).toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (row.title.toLowerCase().includes(kw)) score += 3;  // title match = high signal
    else if (hay.includes(kw)) score += 1;
  }
  return score;
}

async function retrieve(question) {
  const keywords = extractKeywords(question);
  console.log(`[retrieve] keywords: ${keywords.join(', ')}`);

  // Tier 1: FTS
  const fts = await tier1_fts(keywords);
  if (fts && fts.length >= 2) {
    console.log(`[retrieve] tier1 FTS → ${fts.length} results`);
    return { laws: fts.slice(0, 4), method: 'fts' };
  }

  // Tier 2: ILIKE on title
  const ilike = await tier2_ilike(keywords);
  if (ilike.length >= 1) {
    const ranked = ilike
      .map(r => ({ ...r, _score: scoreRow(r, keywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 4);
    console.log(`[retrieve] tier2 ILIKE → ${ranked.length} results`);
    return { laws: ranked, method: 'ilike' };
  }

  // Tier 3: ILIKE on full text
  const body = await tier3_fulltext_ilike(keywords);
  if (body.length >= 1) {
    const ranked = body
      .map(r => ({ ...r, _score: scoreRow(r, keywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 4);
    console.log(`[retrieve] tier3 body ILIKE → ${ranked.length} results`);
    return { laws: ranked, method: 'body_ilike' };
  }

  // If FTS returned exactly 1 result, use it rather than returning empty
  if (fts && fts.length === 1) {
    return { laws: fts, method: 'fts_single' };
  }

  console.log('[retrieve] no results found');
  return { laws: [], method: 'none' };
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
   Only sends the most relevant portion of each article
   to keep Groq focused and prevent hallucination from
   information overload.
───────────────────────────────────────────── */
function buildContext({ laws }) {
  const blocks = laws.map((l, i) => {
    // Cap each article at 800 chars — enough for Groq to answer accurately
    const text = (l.text || '').slice(0, 800);
    return [
      `--- ARTICLE ${i + 1} ---`,
      `Law:     ${l.law_name}`,
      `Article: ${l.article_number}`,
      `Title:   ${l.title}`,
      `Text:    ${text}`,
    ].join('\n');
  });

  return [
    '=== VERIFIED SOMALI LEGAL SOURCES ===',
    ...blocks,
    '=== END OF SOURCES ===',
  ].join('\n\n');
}

/* ─────────────────────────────────────────────
   SYSTEM PROMPT
   Anti-hallucination: Groq is explicitly told what to
   do when context is empty or insufficient, so it never
   invents article numbers or legal provisions.
───────────────────────────────────────────── */
const SYSTEM = `You are XeerHub, Somalia's AI legal assistant. You answer questions about Somali law.

STRICT ANTI-HALLUCINATION RULES — follow these exactly:
1. Answer ONLY using the legal articles provided in the context below.
2. NEVER invent, guess, or extrapolate article numbers, provisions, or penalties.
3. ALWAYS cite: exact Law name + Article number from the context.
4. If the context articles do not contain enough information to answer the question, respond ONLY with:
   "The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer."
5. Do NOT use your general training knowledge about Somali law — only what is in the context.
6. Be concise: 2–4 short paragraphs maximum.
7. Write in plain English for lawyers, NGOs, and business professionals.`;

/* ─────────────────────────────────────────────
   CITATIONS
───────────────────────────────────────────── */
function citationsFrom({ laws }) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: l.article_number,
      title: l.title,
    })),
    blogs: [],
  };
}

/* ─────────────────────────────────────────────
   SSE HELPER
───────────────────────────────────────────── */
function makeSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Railway/Nginx buffering
  res.flushHeaders();                        // send headers immediately

  return function send(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };
}

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */
app.get('/', (_req, res) => res.json({ status: 'XeerHub API running', ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/ask', async (req, res) => {

  // Warmup ping — respond immediately, no DB call
  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true });
  }

  const question = req.query.q?.trim();
  if (!question) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const cacheKey = question.toLowerCase().replace(/\s+/g, ' ');

  /* ══════════════════════════════════════════
     STREAMING PATH  (?stream=1)
  ══════════════════════════════════════════ */
  if (req.query.stream === '1') {
    const send = makeSSE(res);

    // Hard deadline: 20s total. If we haven't finished by then, close cleanly.
    // BUG FIXED: old code reset the timer on every token, so a stalling stream
    // never timed out. Now we use a single hard deadline set once.
    const hardDeadline = setTimeout(() => {
      try { send('error', { msg: 'timeout' }); res.end(); } catch (_) {}
    }, 20_000);

    try {
      // Step 1 — retrieve (fast, Supabase only)
      send('status', { msg: 'Searching Somali legal database…' });
      const { laws, method } = await retrieve(question);
      console.log(`[stream] retrieve method=${method}, laws=${laws.length}`);

      send('citations', citationsFrom({ laws }));

      // Step 2 — guard against empty context (hallucination prevention)
      if (!laws.length) {
        send('answer_done', {
          answer: 'The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer.',
        });
        clearTimeout(hardDeadline);
        return res.end();
      }

      // Step 3 — Groq streaming
      send('status', { msg: 'Composing answer…' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.0,    // deterministic — reduces hallucination
        max_tokens: 400,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user',   content: `QUESTION: ${question}\n\n${buildContext({ laws })}` },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          full += token;
          send('token', { token });
        }
      }

      send('answer_done', { answer: full });
      clearTimeout(hardDeadline);
      res.end();

    } catch (err) {
      console.error('[stream] error:', err.message);
      clearTimeout(hardDeadline);
      try { send('error', { msg: err.message }); res.end(); } catch (_) {}
    }

    return;
  }

  /* ══════════════════════════════════════════
     JSON PATH  (no ?stream)
  ══════════════════════════════════════════ */
  try {
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    const { laws } = await retrieve(question);

    if (!laws.length) {
      return res.json({
        answer: 'The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer.',
        citations: { laws: [], blogs: [] },
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `QUESTION: ${question}\n\n${buildContext({ laws })}` },
      ],
    });

    const result = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws }),
    };

    cacheSet(cacheKey, result);
    return res.json(result);

  } catch (err) {
    console.error('[json] error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, () => console.log(`XeerHub API ready on port ${PORT}`));
