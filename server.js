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
  'Environmental Law':      'Environmental Protection and Management Act 2024',
  'Data Protection Law':    'Data Protection Act',
};

/* ─────────────────────────────────────────────
   FAST TEXT SEARCH — LAWS TABLE
   - Uses AND (plain) search so all key terms must
     match, avoiding false positives from loose OR.
   - Filters by law_name when a specific law is
     provided, so "fire without notice" never
     surfaces Foreign Investment Law articles.
   - Falls back to broader OR search if AND yields
     no results (handles short / sparse queries).
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
   LANGUAGE DETECTION
   Cheap heuristic: count common Somali function
   words vs. the question text. Good enough to pick
   which qa_library columns/tsvector config to use —
   this is NOT meant to be a full language detector.
───────────────────────────────────────────── */
const SOMALI_MARKERS = [
  'maxay','maxaa','waa','sidee','ma','ku','iyo','ee','oo','ka','ah',
  'kartaa','leeyahay','shaqaale','shaqada','xeerka','loo-shaqeeye',
  'qodobka','waajib','xaq','miyaan','haddii'
];

function isSomali(question) {
  const lower = question.toLowerCase();
  const hits = SOMALI_MARKERS.filter(w =>
    new RegExp(`\\b${w}\\b`).test(lower)
  ).length;
  return hits >= 2;
}

/* ─────────────────────────────────────────────
   FAST TEXT SEARCH — QA_LIBRARY TABLE
   Real schema (confirmed via information_schema):
     id, law_name, article_ref_raw, question_en,
     answer_en, question_so, answer_so, tier,
     verified, needs_review, review_notes,
     created_at, updated_at
   Branches on detected language:
     - Somali questions  -> text_search_so (simple config), question_so/answer_so
     - English questions -> text_search (english config), question_en/answer_en
   Requires the text_search / text_search_so generated
   columns from import_labour_qa_somali.sql STEP 1.
───────────────────────────────────────────── */
async function qaLibrarySearch(question, lawArea) {

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6);

  const andTerms = words.join(' & ');
  const orTerms  = words.join(' | ');

  const lawName = LAW_NAME_MAP[lawArea] || null;
  const somali  = isSomali(question);

  const searchCol  = somali ? 'text_search_so' : 'text_search';
  const tsConfig   = somali ? 'simple' : 'english';
  const selectCols = somali
    ? 'id, law_name, article_ref_raw, question_so, answer_so'
    : 'id, law_name, article_ref_raw, question_en, answer_en';

  async function runSearch(terms) {
    let q = supabase
      .from('qa_library')
      .select(selectCols)
      .textSearch(searchCol, terms, { type: 'plain', config: tsConfig })
      .limit(3);

    if (lawName) q = q.eq('law_name', lawName);

    return q;
  }

  let res = await runSearch(andTerms);

  if (!res.data || res.data.length === 0) {
    res = await runSearch(orTerms);
  }

  // If the text_search / text_search_so columns don't exist yet,
  // this throws — catch it so the whole /ask request doesn't 500.
  if (res.error) {
    console.error('qa_library search error:', res.error.message);
    return { qa: [] };
  }

  // Normalise field names so buildContext/citationsFrom don't need
  // to know which language branch was used.
  const normalised = (res.data || []).map(row => ({
    id: row.id,
    law_name: row.law_name,
    ref: row.article_ref_raw,
    question: somali ? row.question_so : row.question_en,
    answer: somali ? row.answer_so : row.answer_en,
  }));

  return { qa: normalised };
}

/* ─────────────────────────────────────────────
   RETRIEVE — now pulls from BOTH laws and qa_library
   in parallel and merges the results.
───────────────────────────────────────────── */
async function retrieve(question, lawArea) {
  const [lawsResult, qaResult] = await Promise.all([
    textSearch(question, lawArea),
    qaLibrarySearch(question, lawArea),
  ]);

  return {
    laws: lawsResult.laws,
    qa: qaResult.qa,
  };
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
   Feeds both raw article text AND verified Q&A
   pairs to Groq. The verified Q&A block is listed
   first since it's the highest-confidence, already
   fact-checked source.
───────────────────────────────────────────── */
function buildContext({ laws, qa }) {

  const sections = [];

  if (qa && qa.length) {
    sections.push(
      '================ VERIFIED Q&A ================\n' +
      qa.map((item, i) =>
        `[QA ${i + 1}]\nLaw: ${item.law_name}\nQ: ${item.question}\nA: ${item.answer}\nRef: ${item.ref}`
      ).join('\n\n')
    );
  }

  sections.push(
    '==================== LAWS ====================\n' +
    laws.map((l, i) =>
      `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text.slice(0, 1200)}`
    ).join('\n\n')
  );

  return sections.join('\n\n');
}

/* ─────────────────────────────────────────────
   SYSTEM PROMPT
───────────────────────────────────────────── */
const SYSTEM = `You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY the provided laws and verified Q&A.
- Prefer the VERIFIED Q&A block when it directly answers the question — it has already been checked against the source legislation.
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

function citationsFrom({ laws, qa }) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: cleanArticleNumber(l.article_number),
      title: l.title,
      similarity: l.similarity,
    })),
    qa: (qa || []).map(item => ({
      type: 'qa',
      law: item.law_name,
      ref: item.ref,
      question: item.question,
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

  if (!question) {
    return res.status(400).json({
      error: 'Missing question'
    });
  }

  // Cache key includes lawArea so different law filters don't share cached results
  const cacheKey = `${lawArea}::${question}`;

  // Cache hit
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

      send('status', {
        msg: 'Searching Somali laws...'
      });

      const retrieved = await retrieve(question, lawArea);

      const { laws, qa } = retrieved;

      send('citations', citationsFrom({ laws, qa }));

      if (!laws.length && !qa.length) {

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
            content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, qa })}`
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

    const { laws, qa } = await retrieve(question, lawArea);

    if (!laws.length && !qa.length) {
      return res.json({
        answer: "I couldn't find relevant legal content for that question. Try rephrasing.",
        citations: {
          laws: [],
          qa: [],
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
          content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, qa })}`
        }
      ]
    });

    const responseData = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws, qa }),
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
