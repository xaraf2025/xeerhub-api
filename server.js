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
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://xeerhub.com',
    'https://www.xeerhub.com',
    'http://localhost:3000',
    'http://localhost:5500',  // live-server dev
  ],
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─────────────────────────────────────────────
   IN-MEMORY CACHE  (survives within a dyno lifetime)
───────────────────────────────────────────── */
const cache = new Map();
const CACHE_MAX = 200;

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // evict oldest
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

/* ─────────────────────────────────────────────
   RETRIEVAL  — three-tier fallback, all fast
   1. Full-text search on tsvector column (instant if GIN index exists)
   2. ILIKE search on title + text (works even without tsvector)
   3. Fuzzy keyword scan (last resort, still < 500 ms on small tables)
───────────────────────────────────────────── */

/** Extract meaningful keywords from raw question */
function keywords(question) {
  const STOP = new Set([
    'what','when','where','which','who','how','does','can','the','and',
    'for','are','that','this','with','have','from','will','been','they',
    'also','into','its','not','but','any','all','more','must','their',
    'your','there','under','after','only','both','each','such','some',
    'than','then','been','made','make','same','most','other','may','is',
    'in','of','to','a','an','on','at','by','do','if','it','me','my',
    'no','or','so','up','us','we',
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

/**
 * Tier 1: native Postgres full-text search.
 * Requires a `text_search` tsvector column on the `laws` table.
 * If the column doesn't exist Supabase returns an error — we catch and fall through.
 */
async function ftsSearch(words) {
  if (!words.length) return [];

  // Use websearch_to_tsquery style: wrap each word, join with &
  // Supabase textSearch with type:'websearch' is safest across PG versions
  const query = words.slice(0, 8).join(' ');

  const { data, error } = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .textSearch('text_search', query, { type: 'websearch', config: 'english' })
    .limit(4);

  if (error) {
    // Column missing or index not set up — fall through to tier 2
    console.warn('FTS unavailable:', error.message);
    return null; // null = tier failed, not empty result
  }
  return data || [];
}

/**
 * Tier 2: ILIKE search across title and text.
 * Slower than FTS but works on any Supabase table with no extra setup.
 */
async function ilikeSearch(words) {
  if (!words.length) return [];

  // Use the most distinctive keyword only to keep it fast
  const primary = words[0];
  const { data, error } = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .or(`title.ilike.%${primary}%,text.ilike.%${primary}%`)
    .limit(4);

  if (error) {
    console.warn('ILIKE search error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Score a single law row against the question keywords.
 * Used to re-rank results from ILIKE (which only filters on one term).
 */
function score(row, words) {
  const haystack = `${row.title} ${row.text}`.toLowerCase();
  return words.reduce((acc, w) => acc + (haystack.includes(w) ? 1 : 0), 0);
}

async function retrieve(question) {
  const words = keywords(question);

  // --- Tier 1: FTS ---
  const ftsResults = await ftsSearch(words);
  if (ftsResults !== null && ftsResults.length > 0) {
    return { laws: ftsResults, method: 'fts' };
  }

  // --- Tier 2: ILIKE + re-rank ---
  const ilikeResults = await ilikeSearch(words);
  if (ilikeResults.length > 0) {
    const ranked = ilikeResults
      .map(r => ({ ...r, _score: score(r, words) }))
      .sort((a, b) => b._score - a._score);
    return { laws: ranked.slice(0, 4), method: 'ilike' };
  }

  // --- Tier 3: individual keyword fallback ---
  for (const word of words.slice(0, 4)) {
    const { data } = await supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .or(`title.ilike.%${word}%,text.ilike.%${word}%`)
      .limit(3);
    if (data?.length) {
      return { laws: data, method: 'keyword' };
    }
  }

  return { laws: [], method: 'none' };
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
───────────────────────────────────────────── */
function buildContext({ laws }) {
  const sections = laws.map((l, i) =>
    `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text.slice(0, 1000)}`
  );
  return ['===== SOMALI LEGAL CONTEXT =====', ...sections].join('\n\n');
}

/* ─────────────────────────────────────────────
   SYSTEM PROMPT
───────────────────────────────────────────── */
const SYSTEM = `You are XeerHub, Somalia's AI legal assistant.

STRICT RULES:
- Use ONLY the laws provided in the context below.
- Never invent article numbers or legal provisions.
- Always cite: Law name + Article number.
- Be concise and structured (2-4 short paragraphs max).
- If the context doesn't cover the question, say clearly: "The XeerHub database does not currently contain verified information on this specific question."
- Write in plain English for lawyers, NGOs, and business professionals in Somalia.`;

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
  res.setHeader('X-Accel-Buffering', 'no');  // disable Nginx buffering on Railway

  return function send(event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };
}

/* ─────────────────────────────────────────────
   ROOT
───────────────────────────────────────────── */
app.get('/', (_req, res) => res.json({ status: 'XeerHub API running', ok: true }));

/* ─────────────────────────────────────────────
   HEALTH / WARMUP
───────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ─────────────────────────────────────────────
   /ask  — handles both streaming and JSON
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  /* ── warmup ping from the frontend ── */
  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true });
  }

  const question = req.query.q?.trim();
  if (!question) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const cacheKey = question.toLowerCase();

  /* ══════════════════════════════════════════
     STREAMING PATH  (?stream=1)
  ══════════════════════════════════════════ */
  if (req.query.stream === '1') {
    const send = makeSSE(res);

    try {
      // Step 1: retrieve context (fast — Supabase, no embedding needed)
      send('status', { msg: 'Searching Somali legal database…' });
      const retrieved = await retrieve(question);
      const { laws } = retrieved;

      // Send citations immediately so the UI can render them
      send('citations', citationsFrom({ laws }));

      if (!laws.length) {
        send('answer_done', {
          answer: "The XeerHub database doesn't contain verified articles matching your question. Try rephrasing, or browse the Q&A library for related topics."
        });
        return res.end();
      }

      // Step 2: stream Groq response token-by-token
      send('status', { msg: 'Composing answer…' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',   // fastest Groq model
        temperature: 0.1,
        max_tokens: 450,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user',   content: `QUESTION: ${question}\n\n${buildContext({ laws })}` },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) { full += token; send('token', { token }); }
      }

      send('answer_done', { answer: full });
      res.end();

    } catch (err) {
      console.error('Stream error:', err.message);
      try { send('error', { msg: err.message }); res.end(); } catch (_) {}
    }

    return;
  }

  /* ══════════════════════════════════════════
     JSON PATH  (no stream param)
  ══════════════════════════════════════════ */
  try {
    // Cache hit
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    const { laws } = await retrieve(question);

    if (!laws.length) {
      return res.json({
        answer: "The XeerHub database doesn't contain verified articles matching your question. Try rephrasing.",
        citations: { laws: [], blogs: [] },
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 450,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `QUESTION: ${question}\n\n${buildContext({ laws })}` },
      ],
    });

    const responseData = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws }),
    };

    cacheSet(cacheKey, responseData);
    return res.json(responseData);

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, () => console.log(`XeerHub API ready on port ${PORT}`));
