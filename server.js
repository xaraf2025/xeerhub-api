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
   SIMPLE MEMORY CACHE
───────────────────────────────────────────── */
const cache = new Map();

/* ─────────────────────────────────────────────
   BASIC PER-IP RATE LIMITER
   /ask calls an LLM per uncached request and has no
   auth in front of it — without a limiter, a single
   client can burn unlimited Groq quota. This is a
   lightweight in-memory limiter (no new dependency).
   For multi-instance deployments (Railway can scale
   horizontally), swap this for a shared store (Redis)
   since in-memory counts don't share across instances.
───────────────────────────────────────────── */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20;              // 20 requests / IP / minute
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.'
    });
  }

  next();
}

// Periodically clear stale buckets so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS * 2).unref();

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
   FAST TEXT SEARCH
───────────────────────────────────────────── */
async function textSearch(question, lawArea) {

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6);

  const andTerms = words.join(' & ');
  const orTerms  = words.join(' | ');

  // Resolve law_name filter (null = search all laws)
  const lawName = LAW_NAME_MAP[lawArea] || null;

  async function runSearch(terms) {
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', terms, { type: 'plain', config: 'english' })
      .limit(3);

    if (lawName) q = q.eq('law_name', lawName);

    return q;
  }

  // Primary: AND search (all terms must match)
  let res = await runSearch(andTerms);

  // Fallback: OR search if AND returns nothing
  if (!res.data || res.data.length === 0) {
    res = await runSearch(orTerms);
  }

  return {
    laws: res.data || [],
    method: 'text',
  };
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
- Never invent facts.
- Always cite law name and article number.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

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
   ROOT
───────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'XeerHub API running' });
});

/* ─────────────────────────────────────────────
   ASK ENDPOINT
   Rate limiter applied here — warmup pings (query
   param warmup=1) are exempt so the frontend's
   keep-alive pings don't eat into a user's quota.
───────────────────────────────────────────── */
app.get('/ask', (req, res, next) => {
  if (req.query.warmup === '1') return next();
  return rateLimit(req, res, next);
}, async (req, res) => {

  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true });
  }

  const question = req.query.q?.trim();
  const lawArea  = req.query.law?.trim() || 'General';

  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  const cacheKey = `${lawArea}::${question}`;

  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
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
          answer: "I couldn't find relevant legal content for that question in XeerHub's database. Try rephrasing your question."
        });
        return res.end();
      }

      send('status', { msg: 'Preparing answer...' });

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
        answer: "I couldn't find relevant legal content for that question. Try rephrasing.",
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

    cache.set(cacheKey, responseData);
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
