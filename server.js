import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GROQ_API_KEY'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing ENV: ${key}`);
    process.exit(1);
  }
}

const app = express();

app.use(cors({
  origin: [
    'https://xeerhub.com',
    'https://www.xeerhub.com',
    'http://localhost:3000'
  ],
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/* ─────────────────────────────────────────────
   CACHE WITH TTL
   FIX: Previously Map() with no expiry — entries
   accumulated indefinitely. Now each entry stores
   a timestamp and expires after 24 hours.
───────────────────────────────────────────── */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict entries older than TTL to prevent unbounded growth
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

/* ─────────────────────────────────────────────
   LAW NAME MAP
   Maps the ?law= query param sent by the frontend
   to the exact law_name values stored in Supabase.
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  'Environmental Law':      'Environmental Protection and Management Act 2024',
  'Data Protection Law':    'Data Protection Act',
};

/* ─────────────────────────────────────────────
   STOP WORDS — excluded from search tokens
───────────────────────────────────────────── */
const STOP_WORDS = new Set([
  'what','when','where','which','who','how','does','can','the','and',
  'for','are','that','this','with','have','from','will','been','they',
  'also','into','its','not','but','any','all','more','must','their',
  'your','there','under','after','only','both','each','such','some',
  'than','then','made','make','same','most','other','may','somalia',
  'somali','law','legal','act','code'
]);

function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

/* ─────────────────────────────────────────────
   FAST TEXT SEARCH
   FIX: Previous version fell back from AND to OR
   search without law-area filtering when law='General',
   allowing cross-law article contamination.

   New strategy (3 tiers, law filter preserved throughout):
   1. AND full-text search (all tokens must match)
   2. ILIKE search on text column (partial keyword match)
   3. OR full-text search (at least one token matches)
      — but ONLY if a specific law is selected, preventing
        irrelevant cross-law results in General mode.
   If all tiers fail in General mode, return empty rather
   than contaminating the answer with unrelated law areas.
───────────────────────────────────────────── */
async function textSearch(question, lawArea) {

  const tokens = tokenise(question);

  if (!tokens.length) {
    return { laws: [], method: 'none' };
  }

  const andTerms = tokens.join(' & ');
  const orTerms  = tokens.join(' | ');

  // Resolve law_name filter (null = search all laws)
  const lawName = LAW_NAME_MAP[lawArea] || null;
  const isGeneral = !lawName;

  // ── Tier 1: AND full-text search ──────────────────────
  async function andSearch() {
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', andTerms, { type: 'plain', config: 'english' })
      .limit(4);
    if (lawName) q = q.eq('law_name', lawName);
    const { data, error } = await q;
    if (error) console.error('AND search error:', error.message);
    return data || [];
  }

  // ── Tier 2: ILIKE keyword search ──────────────────────
  // Searches the text column for any meaningful token.
  // Keeps law filter active so General mode still works safely.
  async function ilikeSearch() {
    // Use the two most distinctive tokens (longest words)
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    const primary = sorted[0];
    if (!primary) return [];

    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .ilike('text', `%${primary}%`)
      .limit(4);
    if (lawName) q = q.eq('law_name', lawName);
    const { data, error } = await q;
    if (error) console.error('ILIKE search error:', error.message);
    return data || [];
  }

  // ── Tier 3: OR full-text search ───────────────────────
  // ONLY used when a specific law is selected.
  // Skipped in General mode to prevent cross-law contamination.
  async function orSearch() {
    if (isGeneral) return []; // ← key fix
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', orTerms, { type: 'plain', config: 'english' })
      .limit(4);
    if (lawName) q = q.eq('law_name', lawName);
    const { data, error } = await q;
    if (error) console.error('OR search error:', error.message);
    return data || [];
  }

  // Run tiers in sequence, stop at first hit
  let results = await andSearch();
  let method = 'and';

  if (!results.length) {
    results = await ilikeSearch();
    method = 'ilike';
  }

  if (!results.length) {
    results = await orSearch();
    method = 'or';
  }

  return { laws: results, method };
}

/* ─────────────────────────────────────────────
   RETRIEVE
───────────────────────────────────────────── */
async function retrieve(question, lawArea) {
  return textSearch(question, lawArea);
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
───────────────────────────────────────────── */
function buildContext({ laws }) {
  return [
    '==================== LAWS ====================',
    laws.map((l, i) =>
      `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text.slice(0, 1200)}`
    ).join('\n\n')
  ].join('\n');
}

/* ─────────────────────────────────────────────
   SYSTEM PROMPT
───────────────────────────────────────────── */
const SYSTEM = `You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY the provided laws.
- Never invent facts or article numbers.
- Always cite law name and article number.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.
- End every answer with: "For your specific situation, consult a qualified Somali lawyer."`;

/* ─────────────────────────────────────────────
   CITATIONS
───────────────────────────────────────────── */
function cleanArticleNumber(raw) {
  if (!raw) return raw;
  return raw.replace(/^art\.?\s*/i, '').trim();
}

function citationsFrom({ laws }) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: cleanArticleNumber(l.article_number),
      title: l.title,
      similarity: l.similarity,
    })),
    blogs: [],
  };
}

/* ─────────────────────────────────────────────
   ROOT / HEALTH CHECK
───────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({
    status: 'XeerHub API running',
    cache_entries: cache.size,
    uptime_seconds: Math.round(process.uptime()),
  });
});

/* ─────────────────────────────────────────────
   ASK ENDPOINT
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  // Warmup ping — used by frontend to keep Railway hot
  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true, ts: Date.now() });
  }

  const question = req.query.q?.trim();
  const lawArea  = req.query.law?.trim() || 'General';

  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  // Cache key includes lawArea so different law filters never share results
  const cacheKey = `${lawArea}::${question}`;

  // Cache hit (with TTL check)
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  /* ══════════════════════════════════════════
     STREAMING PATH
  ══════════════════════════════════════════ */
  if (req.query.stream === '1') {

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (_) {}
    };

    try {

      send('status', { msg: 'Searching Somali laws...' });

      const retrieved = await retrieve(question, lawArea);
      const { laws } = retrieved;

      send('citations', citationsFrom({ laws }));

      if (!laws.length) {
        send('answer_done', {
          answer: "I couldn't find relevant legal content for that question in XeerHub's verified database. Try selecting a specific law area, or browse the Q&A library for related entries."
        });
        return res.end();
      }

      send('status', { msg: 'Composing answer...' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens: 400,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}` }
        ]
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
      res.end();

    } catch (err) {
      console.error('Stream error:', err);
      try {
        send('error', { msg: err.message });
        res.end();
      } catch (_) {}
    }

    return;
  }

  /* ══════════════════════════════════════════
     JSON PATH
  ══════════════════════════════════════════ */
  try {

    const { laws } = await retrieve(question, lawArea);

    if (!laws.length) {
      return res.json({
        answer: "I couldn't find relevant legal content for that question. Try selecting a specific law area or rephrasing.",
        citations: { laws: [], blogs: [] }
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}` }
      ]
    });

    const responseData = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws }),
    };

    cacheSet(cacheKey, responseData);

    return res.json(responseData);

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
