import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import { pipeline } from '@huggingface/transformers';

const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing ENV: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(cors({
  origin: ['https://xeerhub.com', 'https://www.xeerhub.com', 'http://localhost:3000'],
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─────────────────────────────────────────────
   EMBEDDING MODEL — loaded once at boot.
   In-process, so query vectors and the embedding_v2
   document vectors come from the same pipeline —
   this is required, not optional: embedding_hf
   (produced by the HF hosted API) was confirmed to
   NOT reproduce with this in-process model on the
   same text (mean cos ~0.88), so mixing them would
   silently produce wrong rankings.
   If the model fails to load, the service degrades
   to FTS + exact-match only and says so in responses
   — it never fails silently.
───────────────────────────────────────────── */
let embedder = null;
let embedderError = null;
(async () => {
  try {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
    console.log('Embedding model loaded.');
  } catch (err) {
    embedderError = err;
    console.error('Embedding model failed to load — degrading to FTS + exact-match only:', err.message);
  }
})();

async function embedQuery(text) {
  if (!embedder) return null;
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/* ─────────────────────────────────────────────
   CACHE
───────────────────────────────────────────── */
const cache = new Map();

/* ─────────────────────────────────────────────
   LAW NAME MAP — must match the exact law_name
   values in Supabase (confirmed via direct query).
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  'Environmental Law':      'Environmental Law',
  'Data Protection Law':    'Data Protection Law',
};

/* ─────────────────────────────────────────────
   QUERY NORMALIZATION
───────────────────────────────────────────── */
const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','is','are','was','were',
  'be','been','being','my','your','their','his','her','its','our','do','does',
  'did','can','could','should','would','will','shall','may','might','must',
  'what','when','where','which','who','how','with','from','that','this','it',
  'as','at','by','if','so','than','then','also','into','have','has','had',
]);

// Small curated glossary to bridge everyday phrasing to statutory vocabulary.
// This does NOT replace semantic search — it's a cheap, auditable boost for
// the FTS side specifically, where lexical overlap is everything.
const SYNONYMS = {
  fire: ['terminate', 'dismiss', 'dismissal'],
  fired: ['terminated', 'dismissed'],
  boss: ['employer'],
  salary: ['wage', 'wages', 'remuneration'],
  pay: ['wage', 'wages', 'remuneration'],
  paycheck: ['wage', 'wages'],
  cut: ['reduce', 'reduction', 'deduction', 'deductions'],
  quit: ['resign', 'resignation'],
  sick: ['illness', 'medical'],
  maternity: ['pregnancy', 'pregnant'],
  invest: ['investment', 'investor'],
  tax: ['taxation', 'taxable'],
};

function tokenize(question) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 14); // generous cap — just a sanity limit, not a truncation bug
}

function expandWithSynonyms(words) {
  const expanded = new Set(words);
  for (const w of words) {
    if (SYNONYMS[w]) SYNONYMS[w].forEach(s => expanded.add(s));
  }
  return [...expanded];
}

// Detects an explicit article/regulation reference in the question, e.g.
// "article 85", "art. 18", "regulation 9-1". Used for the exact-match
// retriever — this is the one retriever that should behave like a lookup,
// not a ranked search.
function extractArticleRef(question) {
  const m = question.match(/\b(?:art(?:icle)?\.?|reg(?:ulation)?\.?)\s*(\d+(?:-\d+)?)/i);
  return m ? m[1] : null;
}

// Normalizes messy article_number formats ("Art. 6", "ITA 2025 · Art. 12",
// "79, 84") down to the set of bare numbers they contain, for comparison.
function extractNumbers(raw) {
  if (!raw) return [];
  return [...raw.matchAll(/\d+(?:-\d+)?/g)].map(m => m[0]);
}

/* ─────────────────────────────────────────────
   RETRIEVERS
   Each returns an array of { id, law_name, article_number, title, text, _rank }
   in best-first order. Ranks are 0-indexed for RRF.
───────────────────────────────────────────── */

async function retrieveVector(question, lawName, trace) {
  if (!embedder) {
    if (trace) trace.push({ step: 'vector', skipped: true, reason: embedderError?.message || 'model not loaded' });
    return [];
  }
  const vec = await embedQuery(question);
  const { data, error } = await supabase.rpc('match_laws_v2', {
    query_embedding: vec,
    match_count: 8,
    law_filter: lawName,
  });
  if (error) {
    if (trace) trace.push({ step: 'vector:error', error: error.message });
    return [];
  }
  if (trace) trace.push({ step: 'vector', resultCount: data?.length || 0, top: data?.[0] && { article: data[0].article_number, similarity: data[0].similarity } });
  return data || [];
}

async function retrieveFTS(question, lawName, trace) {
  const words = tokenize(question);
  if (words.length === 0) {
    if (trace) trace.push({ step: 'fts', skipped: true, reason: 'no usable words' });
    return { rows: [], mode: null, wordCount: 0 };
  }
  const expanded = expandWithSynonyms(words);

  async function run(terms) {
    return supabase.rpc('search_laws_fts', {
      tsquery_text: terms,
      match_count: 8,
      law_filter: lawName,
    });
  }

  // AND first (precise), OR fallback with synonym expansion (broad).
  // `mode` is returned because it is a real relevance signal: an AND hit means
  // every query term occurs in the same article; an OR hit only means "some word overlapped".
  let res = await run(words.join(' & '));
  if (trace) trace.push({ step: 'fts:AND', terms: words.join(' & '), resultCount: res.data?.length || 0, error: res.error?.message });
  if (res.data && res.data.length > 0) return { rows: res.data, mode: 'and', wordCount: words.length };

  res = await run(expanded.join(' | '));
  if (trace) trace.push({ step: 'fts:OR', terms: expanded.join(' | '), resultCount: res.data?.length || 0, error: res.error?.message });
  return { rows: res.data || [], mode: res.data?.length ? 'or' : null, wordCount: words.length };
}

async function retrieveExact(question, lawName, trace) {
  const ref = extractArticleRef(question);
  if (!ref) {
    if (trace) trace.push({ step: 'exact', skipped: true, reason: 'no article reference detected' });
    return [];
  }
  let q = supabase
    .from('laws')
    .select('id, law_name, article_number, title, text')
    .ilike('article_number', `%${ref}%`)
    .limit(5);
  if (lawName) q = q.eq('law_name', lawName);
  const { data, error } = await q;
  if (trace) trace.push({ step: 'exact', ref, resultCount: data?.length || 0, error: error?.message });
  return data || [];
}

/* ─────────────────────────────────────────────
   FUSION (Reciprocal Rank Fusion) — ordering only.

   RRF scores are rank-based: a single retriever's #1 hit is always
   1/60 = 0.0167 no matter how irrelevant it is. They can order results
   but they CANNOT say whether the results are relevant. The gate below
   therefore uses absolute signals (exact match, vector cosine
   similarity, FTS AND-vs-OR), never the RRF score.
───────────────────────────────────────────── */
const RRF_K = 60;
const EXACT_MATCH_BOOST = 1.0;

function fuse({ vectorResults, ftsResults, exactResults }) {
  const scores = new Map(); // id -> { row, score, hitBy: Set, sim }

  function addList(list, label) {
    list.forEach((row, rank) => {
      const entry = scores.get(row.id) || { row, score: 0, hitBy: new Set(), sim: null };
      entry.score += 1 / (RRF_K + rank);
      entry.hitBy.add(label);
      if (label === 'vector' && typeof row.similarity === 'number') entry.sim = row.similarity;
      scores.set(row.id, entry);
    });
  }

  addList(vectorResults, 'vector');
  addList(ftsResults, 'fts');

  exactResults.forEach(row => {
    const entry = scores.get(row.id) || { row, score: 0, hitBy: new Set(), sim: null };
    entry.score += EXACT_MATCH_BOOST;
    entry.hitBy.add('exact');
    scores.set(row.id, entry);
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(e => ({ ...e.row, _score: e.score, _hitBy: [...e.hitBy], _sim: e.sim }));
}

/* Gate thresholds. Cosine similarity for MiniLM question-vs-article is
   typically 0.3–0.6, so these are PROVISIONAL starting points — calibrate
   from `node bench/run.js` (it prints the vecTop distribution for in-scope
   vs out-of-scope questions) and override via env without redeploying code. */
const VEC_SUPPORTED = parseFloat(process.env.VEC_SUPPORTED || '0.50');
const VEC_WEAK      = parseFloat(process.env.VEC_WEAK || '0.35');

// Three-state gate. "supported" calls Groq; "weak" and "none" never do.
function gate(fused, signals) {
  if (fused.length === 0) return { state: 'none', reason: 'nothing retrieved' };

  const { exact, vecTop, ftsMode, ftsWordCount, vectorAvailable } = signals;
  const top = fused[0];

  if (exact) return { state: 'supported', reason: 'explicit article reference' };

  if (vecTop !== null && vecTop >= VEC_SUPPORTED)
    return { state: 'supported', reason: `vector similarity ${vecTop.toFixed(3)} >= ${VEC_SUPPORTED}` };

  // Every query term co-occurs in the top article, and it is the FTS #1 hit.
  // Needs >= 2 terms so a single generic word cannot pass on its own.
  if (ftsMode === 'and' && ftsWordCount >= 2 && top._hitBy.includes('fts'))
    return { state: 'supported', reason: 'FTS AND match (all query terms present)' };

  if (vecTop !== null && vecTop >= VEC_WEAK)
    return { state: 'weak', reason: `vector similarity ${vecTop.toFixed(3)} in weak band` };

  // Vector is down/empty: OR-only lexical overlap is all we have. Say "weak"
  // rather than "none" so a real question is not discarded just because the
  // vector path failed — but the trace/`vectorAvailable:false` makes that visible.
  if (!vectorAvailable && ftsMode === 'or')
    return { state: 'weak', reason: 'vector unavailable; OR-only lexical overlap' };

  return { state: 'none', reason: 'no strong lexical or semantic signal' };
}

async function retrieve(question, lawArea, trace) {
  const lawName = LAW_NAME_MAP[lawArea] || null;
  const [vectorResults, fts, exactResults] = await Promise.all([
    retrieveVector(question, lawName, trace),
    retrieveFTS(question, lawName, trace),
    retrieveExact(question, lawName, trace),
  ]);
  const fused = fuse({ vectorResults, ftsResults: fts.rows, exactResults });
  const signals = {
    exact: exactResults.length > 0,
    vectorAvailable: vectorResults.length > 0,
    vectorCount: vectorResults.length,
    vecTop: vectorResults.length ? (vectorResults[0].similarity ?? null) : null,
    ftsMode: fts.mode,
    ftsWordCount: fts.wordCount,
    ftsCount: fts.rows.length,
  };
  const g = gate(fused, signals);
  if (trace) trace.push({ step: 'fuse', fusedCount: fused.length, gate: g.state, gateReason: g.reason, signals });
  return { fused: fused.slice(0, 5), gate: g.state, gateReason: g.reason, signals };
}

/* ─────────────────────────────────────────────
   CONTEXT + CITATIONS
   Citations are built ONLY from fused `laws` rows —
   never from qa_library (0% verified — see project
   notes) and never invented by the model.
───────────────────────────────────────────── */
function buildContext(fused) {
  return [
    '==================== LAWS ====================',
    fused.map((l, i) =>
      `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text}`
    ).join('\n\n'),
  ].join('\n');
}

function cleanArticleNumber(raw) {
  if (!raw) return raw;
  return raw.replace(/^art\.?\s*/i, '').trim();
}

function citationsFrom(fused) {
  return {
    laws: fused.map(l => ({
      type: 'law',
      law: l.law_name,
      article: cleanArticleNumber(l.article_number),
      title: l.title,
      similarity: l._sim, // cosine similarity (null if not found by vector) — RRF score is rank-only and not meaningful to show
      matchedBy: l._hitBy,
    })),
    blogs: [],
  };
}

// Lightweight post-hoc check: flags (does not block) if the model's
// answer cites an article number that isn't among the retrieved rows.
// An 8B model's citation habits vary in format, so this is a warning
// signal for you to review, not a hard filter.
function checkCitationDrift(answerText, fused) {
  const retrievedNumbers = new Set(fused.flatMap(l => extractNumbers(l.article_number)));
  const mentioned = [...answerText.matchAll(/art(?:icle)?\.?\s*(\d+(?:-\d+)?)/gi)].map(m => m[1]);
  const unmatched = mentioned.filter(n => !retrievedNumbers.has(n));
  return unmatched.length ? { drift: true, unmatched } : { drift: false };
}

const SYSTEM = `You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY the provided laws.
- Never invent facts or article numbers not present in the provided context.
- Always cite law name and article number exactly as given in the context.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

const INSUFFICIENT_MSG =
  "XeerHub's verified sources don't clearly cover this question yet. Try rephrasing, or browse the Q&A library for related topics.";

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

app.get('/ask', async (req, res) => {
  if (req.query.warmup === '1') return res.json({ status: 'warm', ok: true, modelLoaded: !!embedder });

  const question = req.query.q?.trim();
  const lawArea = req.query.law?.trim() || 'General';
  const debug = req.query.debug === '1';
  const trace = debug ? [] : null;

  if (!question) return res.status(400).json({ error: 'Missing question' });

  const cacheKey = `v2::${lawArea}::${question}`;
  if (!debug && cache.has(cacheKey)) return res.json(cache.get(cacheKey));

  if (debug) {
    try {
      const { fused, gate: gateState, gateReason, signals } = await retrieve(question, lawArea, trace);
      return res.json({
        question, lawArea,
        resolvedLawName: LAW_NAME_MAP[lawArea] || null,
        modelLoaded: !!embedder,
        trace,
        gate: gateState,
        gateReason,
        signals,
        thresholds: { VEC_SUPPORTED, VEC_WEAK },
        fused: fused.map(f => ({ id: f.id, law_name: f.law_name, article_number: f.article_number, title: f.title, score: f._score, similarity: f._sim, hitBy: f._hitBy })),
      });
    } catch (err) {
      trace.push({ step: 'error', message: err.message, stack: err.stack });
      return res.status(500).json({ trace, error: err.message });
    }
  }

  if (req.query.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };

    try {
      send('status', { msg: 'Searching Somali laws...' });
      const { fused, gate: gateState } = await retrieve(question, lawArea);

      if (gateState === 'none') {
        send('citations', { laws: [], blogs: [] });
        send('answer_done', { answer: INSUFFICIENT_MSG });
        return res.end();
      }
      if (gateState === 'weak') {
        send('citations', citationsFrom(fused));
        send('answer_done', { answer: INSUFFICIENT_MSG + ' Closest matches are listed as citations below.' });
        return res.end();
      }

      send('citations', citationsFrom(fused));
      send('status', { msg: 'Preparing answer...' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens: 500,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext(fused)}` },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) { full += token; send('token', { token }); }
      }
      const drift = checkCitationDrift(full, fused);
      if (drift.drift) console.warn('Citation drift detected:', question, drift.unmatched);

      send('answer_done', { answer: full });
      res.end();
    } catch (err) {
      console.error('Stream error:', err);
      try { send('error', { msg: err.message }); res.end(); } catch (_) {}
    }
    return;
  }

  // JSON path
  try {
    const { fused, gate: gateState } = await retrieve(question, lawArea);

    if (gateState === 'none') {
      return res.json({ answer: INSUFFICIENT_MSG, citations: { laws: [], blogs: [] } });
    }
    if (gateState === 'weak') {
      return res.json({
        answer: INSUFFICIENT_MSG + ' Closest matches are listed as citations below.',
        citations: citationsFrom(fused),
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext(fused)}` },
      ],
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.';
    const drift = checkCitationDrift(answer, fused);
    if (drift.drift) console.warn('Citation drift detected:', question, drift.unmatched);

    const responseData = { answer, citations: citationsFrom(fused) };
    cache.set(cacheKey, responseData);
    return res.json(responseData);
  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
