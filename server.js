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
   LAW NAME MAP
   Maps the ?law= query param sent by the frontend
   to the exact law_name values stored in Supabase.
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  // FIX: these two previously mapped to values that don't exist in the
  // `laws` table (confirmed via direct query of distinct law_name values).
  // Any filtered search on these two areas was matching zero rows.
  'Environmental Law':      'Environmental Law',
  'Data Protection Law':    'Data Protection Law',
};

/* ─────────────────────────────────────────────
   FAST TEXT SEARCH
   FIX (this patch):
   - Removed `{ type: 'plain' }`. Supabase's default
     textSearch type is `to_tsquery`, which is what
     actually respects the `&` (AND) and `|` (OR)
     operators we build below. With `type: 'plain'`,
     Postgres used `plainto_tsquery`, which strips
     `&`/`|` as ordinary characters and ALWAYS ANDs
     the remaining words — so the "OR fallback" was
     silently running the same AND query a second
     time and never actually broadening the search.
   - Filters by law_name when a specific law is
     provided, so "fire without notice" never
     surfaces Foreign Investment Law articles.
   - Falls back to broader OR search if AND yields
     no results (handles short / sparse queries).
   - Guards against an empty `words` array, which
     would otherwise throw inside to_tsquery('').
───────────────────────────────────────────── */
async function textSearch(question, lawArea, trace) {

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6);

  if (trace) trace.push({ step: 'tokenize', words });

  if (words.length === 0) {
    if (trace) trace.push({ step: 'textSearch', skipped: true, reason: 'no usable words' });
    return { laws: [], method: 'text' };
  }

  const andTerms = words.join(' & ');
  const orTerms  = words.join(' | ');

  // Resolve law_name filter (null = search all laws)
  const lawName = LAW_NAME_MAP[lawArea] || null;

  async function runSearch(terms) {
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      // Default type is `to_tsquery`, which respects & and | operators.
      // Do NOT pass { type: 'plain' } here — see note above.
      .textSearch('text_search', terms, { config: 'english' })
      .limit(3);

    if (lawName) q = q.eq('law_name', lawName);

    return q;
  }

  // Primary: AND search (all terms must match)
  let res = await runSearch(andTerms);

  if (res.error && trace) {
    trace.push({ step: 'textSearch:AND:error', error: res.error.message, terms: andTerms });
  }
  if (trace) trace.push({ step: 'textSearch:AND', terms: andTerms, resultCount: res.data?.length || 0 });

  // Fallback: OR search if AND returns nothing
  if (!res.data || res.data.length === 0) {
    res = await runSearch(orTerms);

    if (res.error && trace) {
      trace.push({ step: 'textSearch:OR:error', error: res.error.message, terms: orTerms });
    }
    if (trace) trace.push({ step: 'textSearch:OR', terms: orTerms, resultCount: res.data?.length || 0 });
  }

  if (res.error) {
    console.error('Supabase textSearch error:', res.error);
  }

  return {
    laws: res.data || [],
    method: 'text',
  };
}

/* ─────────────────────────────────────────────
   RETRIEVE
───────────────────────────────────────────── */
async function retrieve(question, lawArea, trace) {
  return textSearch(question, lawArea, trace);
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
   Strip any leading "Art. " / "art. " from
   article_number — the frontend template already
   prepends "Art. " so we must not duplicate it.
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
  res.json({
    status: 'XeerHub API running'
  });
});

/* ─────────────────────────────────────────────
   ASK ENDPOINT
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  // Warmup
  if (req.query.warmup === '1') {
    return res.json({
      status: 'warm',
      ok: true
    });
  }

  const question = req.query.q?.trim();
  const lawArea  = req.query.law?.trim() || 'General';
  const debug    = req.query.debug === '1';
  const trace    = debug ? [] : null;

  if (!question) {
    return res.status(400).json({
      error: 'Missing question'
    });
  }

  // Cache key includes lawArea so different law filters don't share cached results
  const cacheKey = `${lawArea}::${question}`;

  // Cache hit (skip cache entirely in debug mode so trace is always fresh)
  if (!debug && cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey));
  }

  /* ══════════════════════════════════════════
     DEBUG PATH — returns raw retrieval trace,
     never calls Groq. Use to diagnose empty
     answers: /ask?q=...&law=...&debug=1
  ══════════════════════════════════════════ */
  if (debug) {
    try {
      const retrieved = await retrieve(question, lawArea, trace);
      return res.json({
        question,
        lawArea,
        resolvedLawName: LAW_NAME_MAP[lawArea] || null,
        trace,
        laws: retrieved.laws,
      });
    } catch (err) {
      trace.push({ step: 'error', message: err.message, stack: err.stack });
      return res.status(500).json({ trace, error: err.message });
    }
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

      send('status', {
        msg: 'Searching Somali laws...'
      });

      const retrieved = await retrieve(question, lawArea);

      const { laws } = retrieved;

      send('citations', citationsFrom({ laws }));

      if (!laws.length) {

        send('answer_done', {
          answer: "I couldn't find relevant legal content for that question in XeerHub's database. Try rephrasing your question."
        });

        return res.end();
      }

      send('status', {
        msg: 'Preparing answer...'
      });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens: 400,
        stream: true,
        messages: [
          {
            role: 'system',
            content: SYSTEM
          },
          {
            role: 'user',
            content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}`
          }
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

      send('answer_done', {
        answer: full
      });

      res.end();

    } catch (err) {

      console.error('Stream error:', err);

      try {
        send('error', {
          msg: err.message
        });

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
        citations: {
          laws: [],
          blogs: []
        }
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: SYSTEM
        },
        {
          role: 'user',
          content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}`
        }
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

    return res.status(500).json({
      error: err.message || 'Internal server error'
    });
  }
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
