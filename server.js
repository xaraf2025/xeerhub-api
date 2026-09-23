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

const cache = new Map();

const LAW_NAME_MAP = {
  'Labor Law': 'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law': 'Income Tax Act 2025',
  'Environmental Law': 'Environmental Law',
  'Data Protection Law': 'Data Protection Law',
};

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','is','are','was','were',
  'be','been','being','my','your','their','his','her','its','our','do','does',
  'did','can','could','should','would','will','shall','may','might','must',
  'what','when','where','which','who','how','with','from','that','this','it',
  'as','at','by','if','so','than','then','also','into','have','has','had',
]);

// Explicit scope protection prevents generic vector similarities from treating
// unrelated questions as weak legal matches.
const OUT_OF_SCOPE_PATTERNS = [
  /\bweather\b/i,
  /\bpassport\b/i,
  /\bdivorce\b/i,
  /\bspeed limit\b/i,
  /\btraffic\b/i,
  /\bcapital gains tax\b.*\b(united states|usa|us)\b/i,
  /\b(united states|usa|us)\b.*\bcapital gains tax\b/i,
];

const LEGAL_DOMAIN_PATTERNS = [
  /\b(employer|employee|worker|salary|wage|wages|pay|paycheck|deduction|deductions|labou?r|maternity|dismiss|dismissal|terminate|termination|contract|working hours|payslip)\b/i,
  /\b(investment|investor|invest|expropriation|nationali[sz]ation|foreign capital|profits out of Somalia)\b/i,
  /\b(tax|taxable|taxation|tax resident|tax residence|rental income|withholding|presumptive)\b/i,
  /\b(environment|environmental|charcoal|impact assessment|pollution|conservation)\b/i,
  /\b(data protection|personal data|data breach|privacy|automated decision|controller|processor)\b/i,
];

function isOutOfScope(question) {
  return OUT_OF_SCOPE_PATTERNS.some(pattern => pattern.test(question));
}

function hasLegalDomainHint(question) {
  return LEGAL_DOMAIN_PATTERNS.some(pattern => pattern.test(question));
}

const SYNONYMS = {
  fire: ['terminate', 'dismiss', 'dismissal'],
  fired: ['terminated', 'dismissed'],
  boss: ['employer'],
  salary: ['wage', 'wages', 'remuneration'],
  pay: ['wage', 'wages', 'remuneration'],
  paycheck: ['wage', 'wages'],
  cut: ['reduce', 'reduction', 'deduction', 'deductions'],
  deduction: ['deductions', 'withholding', 'withhold'],
  deductions: ['deduction', 'withholding', 'withhold'],
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
    .slice(0, 14);
}

function expandWithSynonyms(words) {
  const expanded = new Set(words);
  for (const w of words) {
    if (SYNONYMS[w]) SYNONYMS[w].forEach(s => expanded.add(s));
  }
  return [...expanded];
}

function extractArticleRef(question) {
  const m = question.match(/\b(?:art(?:icle)?\.?|reg(?:ulation)?\.?)\s*(\d+(?:-\d+)?)/i);
  return m ? m[1] : null;
}

function extractNumbers(raw) {
  if (!raw) return [];
  return [...raw.matchAll(/\d+(?:-\d+)?/g)].map(m => m[0]);
}

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
    return [];
  }
  const expanded = expandWithSynonyms(words);

  async function run(terms) {
    return supabase.rpc('search_laws_fts', {
      tsquery_text: terms,
      match_count: 8,
      law_filter: lawName,
    });
  }

  let res = await run(words.join(' & '));
  if (trace) trace.push({ step: 'fts:AND', terms: words.join(' & '), resultCount: res.data?.length || 0, error: res.error?.message });

  if (!res.data || res.data.length === 0) {
    res = await run(expanded.join(' | '));
    if (trace) trace.push({ step: 'fts:OR', terms: expanded.join(' | '), resultCount: res.data?.length || 0, error: res.error?.message });
  }
  return res.data || [];
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

const RRF_K = 60;
const EXACT_MATCH_BOOST = 1.0;

function fuse({ vectorResults, ftsResults, exactResults }) {
  const scores = new Map();

  function addList(list, label) {
    list.forEach((row, rank) => {
      const key = row.id;
      const entry = scores.get(key) || { row, score: 0, hitBy: new Set() };
      entry.score += 1 / (RRF_K + rank);
      entry.hitBy.add(label);
      scores.set(key, entry);
    });
  }

  addList(vectorResults, 'vector');
  addList(ftsResults, 'fts');

  exactResults.forEach(row => {
    const key = row.id;
    const entry = scores.get(key) || { row, score: 0, hitBy: new Set() };
    entry.score += EXACT_MATCH_BOOST;
    entry.hitBy.add('exact');
    scores.set(key, entry);
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(e => ({ ...e.row, _score: e.score, _hitBy: [...e.hitBy] }));
}

function gate(fused) {
  if (fused.length === 0) return { state: 'none', top: null };
  const top = fused[0];
  const multiRetriever = top._hitBy.length >= 2;
  const hasExact = top._hitBy.includes('exact');
  if (hasExact || multiRetriever || top._score >= 0.03) return { state: 'supported', top };
  if (top._score >= 0.012) return { state: 'weak', top };
  return { state: 'none', top };
}

async function retrieve(question, lawArea, trace) {
  if (isOutOfScope(question) || !hasLegalDomainHint(question)) {
    if (trace) trace.push({
      step: 'scope',
      gate: 'none',
      reason: isOutOfScope(question)
        ? 'explicitly out-of-scope question'
        : 'no supported legal-domain keyword detected',
    });
    return { fused: [], gate: 'none' };
  }

  const lawName = LAW_NAME_MAP[lawArea] || null;
  const [vectorResults, ftsResults, exactResults] = await Promise.all([
    retrieveVector(question, lawName, trace),
    retrieveFTS(question, lawName, trace),
    retrieveExact(question, lawName, trace),
  ]);
  const fused = fuse({ vectorResults, ftsResults, exactResults });
  const gateResult = gate(fused);
  if (trace) trace.push({ step: 'fuse', fusedCount: fused.length, gate: gateResult.state, topScore: fused[0]?._score });
  return { fused: fused.slice(0, 5), gate: gateResult.state };
}

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
      similarity: l._score,
      matchedBy: l._hitBy,
    })),
    blogs: [],
  };
}

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
      const { fused, gate: gateState } = await retrieve(question, lawArea, trace);
      return res.json({
        question, lawArea,
        resolvedLawName: LAW_NAME_MAP[lawArea] || null,
        modelLoaded: !!embedder,
        trace,
        gate: gateState,
        fused: fused.map(f => ({ id: f.id, law_name: f.law_name, article_number: f.article_number, title: f.title, score: f._score, hitBy: f._hitBy })),
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
