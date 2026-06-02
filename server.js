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
   CACHE
───────────────────────────────────────────── */
const cache = new Map();
function cacheSet(k, v) {
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

/* ─────────────────────────────────────────────
   LAW NAME MAP
   Maps the frontend dropdown value → exact law_name
   values stored in your Supabase laws table.

   HOW TO FIND YOUR EXACT LAW NAMES:
   Call GET /debug/laws — it returns every distinct
   law_name in your table so you can update this map.
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law': [
    'Somali Labour Code',
    'Labour Code',
    'Somalia Labour Code',
    'Labor Law',
  ],
  'Foreign Investment Law': [
    'Foreign Investment Law',
    'Somalia Foreign Investment Law',
    'Investment Law',
  ],
  'Income Tax Law': [
    'Income Tax Act 2025',
    'ITA 2025',
    'Income Tax Law',
    'Income Tax Regulation 2025',
    'ITR 2025',
  ],
  'Environmental Law': [
    'Environmental Protection and Management Act 2024',
    'EPMA 2024',
    'Environmental Law',
    'Environmental Protection Act',
  ],
  'Data Protection Law': [
    'Data Protection Act',
    'Somalia Data Protection Act',
    'Data Protection Law',
  ],
};

/**
 * Returns the list of law names to filter on,
 * or null if "General" (search all laws).
 */
function getLawFilter(lawArea) {
  if (!lawArea || lawArea === 'General' || lawArea === 'All areas / General') return null;
  return LAW_NAME_MAP[lawArea] || null;
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
  'required','need','legal','law','somali','somalia',
]);

function extractKeywords(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

/* ─────────────────────────────────────────────
   RETRIEVAL — always filtered by law area first
───────────────────────────────────────────── */

function applyLawFilter(query, lawNames) {
  if (!lawNames || !lawNames.length) return query;
  // Supabase OR filter across multiple law_name values
  const orClause = lawNames.map(n => `law_name.ilike.%${n}%`).join(',');
  return query.or(orClause);
}

/**
 * Tier 1 — Full-text search via tsvector column.
 * Returns null if column doesn't exist.
 */
async function tier1_fts(keywords, lawNames) {
  if (!keywords.length) return null;
  const queryStr = keywords.slice(0, 8).join(' ');

  let q = supabase
    .from('laws')
    .select('id, law_name, article_number, title, text')
    .textSearch('text_search', queryStr, { type: 'websearch', config: 'english' })
    .limit(6);

  q = applyLawFilter(q, lawNames);

  const { data, error } = await q;
  if (error) { console.warn('[FTS] unavailable:', error.message); return null; }
  return data || [];
}

/**
 * Tier 2 — ILIKE on title, filtered by law area.
 */
async function tier2_ilike_title(keywords, lawNames) {
  if (!keywords.length) return [];
  const results = new Map();

  for (const kw of keywords.slice(0, 4)) {
    let q = supabase
      .from('laws')
      .select('id, law_name, article_number, title, text')
      .ilike('title', `%${kw}%`)
      .limit(5);

    q = applyLawFilter(q, lawNames);
    const { data } = await q;
    (data || []).forEach(r => results.set(r.id, r));
  }
  return [...results.values()];
}

/**
 * Tier 3 — ILIKE on text body, filtered by law area.
 */
async function tier3_ilike_body(keywords, lawNames) {
  if (!keywords.length) return [];
  const results = new Map();

  for (const kw of keywords.slice(0, 3)) {
    let q = supabase
      .from('laws')
      .select('id, law_name, article_number, title, text')
      .ilike('text', `%${kw}%`)
      .limit(4);

    q = applyLawFilter(q, lawNames);
    const { data } = await q;
    (data || []).forEach(r => results.set(r.id, r));
  }
  return [...results.values()];
}

/**
 * Score a row against keywords — title match weighted higher.
 */
function scoreRow(row, keywords) {
  const title = (row.title || '').toLowerCase();
  const body  = (row.text  || '').toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (title.includes(kw)) score += 4;
    else if (body.includes(kw)) score += 1;
  }
  return score;
}

async function retrieve(question, lawArea) {
  const keywords = extractKeywords(question);
  const lawNames = getLawFilter(lawArea);

  console.log(`[retrieve] q="${question.slice(0,60)}" area="${lawArea}" filter=${JSON.stringify(lawNames)} keywords=${keywords.join(',')}`);

  // Tier 1 — FTS
  const fts = await tier1_fts(keywords, lawNames);
  if (fts && fts.length >= 2) {
    console.log(`[retrieve] tier1 FTS → ${fts.length} results`);
    return { laws: fts.slice(0, 5), method: 'fts' };
  }

  // Tier 2 — ILIKE title
  const byTitle = await tier2_ilike_title(keywords, lawNames);
  if (byTitle.length >= 1) {
    const ranked = byTitle
      .map(r => ({ ...r, _score: scoreRow(r, keywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 5);
    console.log(`[retrieve] tier2 title ILIKE → ${ranked.length} results`);
    return { laws: ranked, method: 'ilike_title' };
  }

  // Tier 3 — ILIKE body
  const byBody = await tier3_ilike_body(keywords, lawNames);
  if (byBody.length >= 1) {
    const ranked = byBody
      .map(r => ({ ...r, _score: scoreRow(r, keywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 5);
    console.log(`[retrieve] tier3 body ILIKE → ${ranked.length} results`);
    return { laws: ranked, method: 'ilike_body' };
  }

  // If FTS returned exactly 1, use it
  if (fts && fts.length === 1) return { laws: fts, method: 'fts_single' };

  // Last resort: no law filter, try all laws
  if (lawNames) {
    console.log('[retrieve] no results with filter — retrying without law filter');
    return retrieve(question, 'General');
  }

  console.log('[retrieve] no results found');
  return { laws: [], method: 'none' };
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
───────────────────────────────────────────── */
function buildContext({ laws }) {
  const blocks = laws.map((l, i) => [
    `--- ARTICLE ${i + 1} ---`,
    `Law:     ${l.law_name}`,
    `Article: ${l.article_number}`,
    `Title:   ${l.title}`,
    `Text:    ${(l.text || '').slice(0, 800)}`,
  ].join('\n'));

  return ['=== VERIFIED SOMALI LEGAL SOURCES ===', ...blocks, '=== END ==='].join('\n\n');
}

/* ─────────────────────────────────────────────
   SYSTEM PROMPT
───────────────────────────────────────────── */
const SYSTEM = `You are XeerHub, Somalia's AI legal assistant.

STRICT ANTI-HALLUCINATION RULES:
1. Answer ONLY using the legal articles in the context provided below.
2. NEVER invent article numbers, penalties, or provisions not in the context.
3. ALWAYS cite the exact Law name and Article number from the context.
4. If the context articles do not contain enough information to answer, respond ONLY with:
   "The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer."
5. Do NOT use general knowledge about Somali law — only what is in the context.
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
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };
}

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */
app.get('/', (_req, res) => res.json({ status: 'XeerHub API running', ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * DEBUG ENDPOINT — GET /debug/laws
 * Returns every distinct law_name in your Supabase table
 * and how many articles each has.
 * Use this to verify what's actually in your database
 * and update LAW_NAME_MAP above if needed.
 * Remove or password-protect this in production.
 */
app.get('/debug/laws', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('laws')
      .select('law_name, id')
      .order('law_name');

    if (error) return res.status(500).json({ error: error.message });

    // Count by law_name
    const counts = {};
    (data || []).forEach(r => {
      counts[r.law_name] = (counts[r.law_name] || 0) + 1;
    });

    const summary = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ law_name: name, article_count: count }));

    return res.json({
      total_articles: data.length,
      laws: summary,
      note: 'Use these exact law_name values to update LAW_NAME_MAP in server.js',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   /ask  — main endpoint
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  if (req.query.warmup === '1') return res.json({ status: 'warm', ok: true });

  const question = req.query.q?.trim();
  const lawArea  = req.query.area?.trim() || 'General';

  if (!question) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const cacheKey = `${lawArea}::${question.toLowerCase().replace(/\s+/g, ' ')}`;

  /* ══════════════════════════════════════════
     STREAMING PATH
  ══════════════════════════════════════════ */
  if (req.query.stream === '1') {
    const send = makeSSE(res);
    const hardDeadline = setTimeout(() => {
      try { send('error', { msg: 'timeout' }); res.end(); } catch (_) {}
    }, 20_000);

    try {
      send('status', { msg: 'Searching Somali legal database…' });
      const { laws, method } = await retrieve(question, lawArea);
      console.log(`[stream] method=${method} laws=${laws.length}`);

      send('citations', citationsFrom({ laws }));

      if (!laws.length) {
        send('answer_done', {
          answer: 'The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer.',
        });
        clearTimeout(hardDeadline);
        return res.end();
      }

      send('status', { msg: 'Composing answer…' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.0,
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
     JSON PATH
  ══════════════════════════════════════════ */
  try {
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    const { laws } = await retrieve(question, lawArea);

    if (!laws.length) {
      return res.json({
        answer: 'The XeerHub database does not currently have a verified article covering this specific question. Please browse the Q&A Library or consult a qualified Somali lawyer.',
        citations: { laws: [], blogs: [] },
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 450,
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

app.listen(PORT, () => console.log(`XeerHub API ready on port ${PORT}`));
