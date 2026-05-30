import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const app = express();

app.use(cors({
  origin: [
    'https://xeerhub.com',
    'https://www.xeerhub.com',
    'http://localhost:3000',
  ],
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("GROQ_KEY exists =", !!process.env.GROQ_API_KEY);
console.log("HF_TOKEN exists =", !!process.env.HF_API_TOKEN);

/* ------------------------------------------------
   CLIENTS
------------------------------------------------ */
let supabase;
function initSupabase() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase environment variables");
    }
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ------------------------------------------------
   HUGGING FACE EMBEDDING
   Model: sentence-transformers/all-MiniLM-L6-v2
   Returns a 384-dim float array.
   Falls back gracefully if HF_API_TOKEN is missing
   or the API is temporarily unavailable.
------------------------------------------------ */
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const HF_API_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`;

async function getEmbedding(text) {
  const token = process.env.HF_API_TOKEN;
  if (!token) throw new Error('HF_API_TOKEN not set');

  const res = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: text,
      options: { wait_for_model: true },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HF embedding error ${res.status}: ${msg}`);
  }

  const data = await res.json();
  // HF returns [[...embedding]] for a single string
  return Array.isArray(data[0]) ? data[0] : data;
}

/* ------------------------------------------------
   KEYWORD HELPERS  (reused by fallback search)
------------------------------------------------ */
const STOP_WORDS = new Set([
  'what','when','where','which','who','how','does','can','the','and',
  'for','are','that','this','with','have','from','will','they','also',
  'into','its','not','but','any','all','more','must','their','your',
  'there','under','after','only','both','each','such','some','than',
  'then','made','make','same','most','other','may','about','would',
  'should','could','need','want','like','just','even','still','very',
  'much','many','well','also','here','there','then','than','these',
  'those','them','they','been','being','have','has','had','were','was',
]);

function extractKeywords(text, max = 6) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, max);
}

/* ------------------------------------------------
   ROUTES
------------------------------------------------ */
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

app.get('/debug-env', (req, res) => res.json({
  SUPABASE_URL: process.env.SUPABASE_URL || null,
  SUPABASE_KEY_EXISTS: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  GROQ_KEY_EXISTS: !!process.env.GROQ_API_KEY,
  HF_TOKEN_EXISTS: !!process.env.HF_API_TOKEN,
}));

/* ------------------------------------------------
   MAIN ASK ROUTE

   Strategy (fast path — target ~1–2 s total):
   ① Kick off HF embedding request immediately
   ② While embedding is in-flight, also run a
      full-text search in parallel (covers the
      case where embedding is slow/unavailable)
   ③ Prefer vector results; fall back to FTS
   ④ Pass top results to Groq LLaMA for the answer

   Timing breakdown:
   - HF embedding:           ~300–800 ms
   - Supabase vector/FTS:    ~100–400 ms  (parallel)
   - Groq LLaMA answer:      ~500–1 500 ms
   Total (happy path):       ~800–2 000 ms
------------------------------------------------ */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;

    // warmup ping — respond instantly
    if (!question || question === 'ping' || question === 'warmup=1') {
      return res.json({ status: 'warm' });
    }

    const client = initSupabase();
    const keywords = extractKeywords(question);

    if (!keywords.length) {
      return res.json({
        answer: 'Please ask a more specific legal question.',
        citations: [],
      });
    }

    /* ── Launch embedding + FTS in parallel ── */
    const embeddingPromise = getEmbedding(question).catch(err => {
      console.warn('[XeerHub] HF embedding failed, will use FTS only:', err.message);
      return null;
    });

    const ftsPromise = (async () => {
      const searchQuery = keywords.join(' & ');
      const { data, error } = await client
        .from('laws')
        .select('id, law_name, article_number, title, text')
        .textSearch('text', searchQuery, { type: 'plain' })
        .limit(6);

      if (error || !data?.length) {
        // OR-fallback
        const { data: fallback, error: err2 } = await client
          .from('laws')
          .select('id, law_name, article_number, title, text')
          .textSearch('text', keywords.join(' | '), { type: 'plain' })
          .limit(6);
        if (err2) console.error('[XeerHub] FTS fallback error:', err2);
        return fallback || [];
      }
      return data;
    })();

    /* ── Await embedding, then try vector search ── */
    const embedding = await embeddingPromise;

    let laws = null;

    if (embedding) {
      /* Vector similarity search via pgvector.
         Requires a match_laws RPC in Supabase:

         create or replace function match_laws(
           query_embedding vector(384),
           match_threshold float default 0.5,
           match_count int default 6
         )
         returns table (
           id bigint, law_name text, article_number text,
           title text, text text, similarity float
         )
         language sql stable as $$
           select id, law_name, article_number, title, text,
                  1 - (embedding <=> query_embedding) as similarity
           from laws
           where 1 - (embedding <=> query_embedding) > match_threshold
           order by similarity desc
           limit match_count;
         $$;
      */
      const { data: vectorData, error: vecErr } = await client.rpc('match_laws', {
        query_embedding: embedding,
        match_threshold: 0.45,
        match_count: 6,
      });

      if (!vecErr && vectorData?.length) {
        laws = vectorData;
        console.log(`[XeerHub] Vector search returned ${laws.length} results`);
      } else {
        if (vecErr) console.warn('[XeerHub] Vector search error:', vecErr.message);
        console.log('[XeerHub] Falling back to FTS results');
      }
    }

    // If vector search didn't produce results, use FTS
    if (!laws?.length) {
      laws = await ftsPromise;
    }

    if (!laws?.length) {
      return res.json({
        answer: 'No relevant provision found in Somali law for this question. Try rephrasing or browsing the Q&A library.',
        citations: [],
      });
    }

    /* ── Build context from top 3 results ── */
    const topLaws = laws.slice(0, 3);
    const context = topLaws.map((law, i) => `
[SOURCE ${i + 1}]
Law: ${law.law_name}
Article: ${law.article_number}
Title: ${law.title}
Text: ${law.text}
`).join('\n');

    /* ── Groq LLaMA answer ── */
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `You are XeerHub, a Somali legal research assistant.
Rules:
1. Answer using ONLY the provided legal sources
2. Always cite the exact law name and article number
3. Be concise — 3 to 5 sentences maximum
4. Never invent provisions not in the sources
5. If the sources don't answer the question, say so clearly`,
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nLegal sources:\n${context}`,
        },
      ],
    });

    const answer = completion?.choices?.[0]?.message?.content || 'No answer generated.';

    return res.json({
      answer,
      citations: topLaws.map(law => ({
        law: law.law_name,
        article: law.article_number,
        title: law.title,
        similarity: law.similarity ?? 1.0,
      })),
    });

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ------------------------------------------------
   START
------------------------------------------------ */
app.listen(PORT, () => console.log(`XeerHub API running on port ${PORT}`));
