import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const app = express();
app.use(cors({
  origin: ['https://xeerhub.com', 'https://www.xeerhub.com', 'http://localhost:3000'],
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─────────────────────────────────────────────
   EMBEDDING  (HuggingFace — used only if warm)
───────────────────────────────────────────── */
const HF_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

async function getEmbedding(text, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(HF_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: false } }),
      // wait_for_model: FALSE — if model is cold, fail fast (503) instead of waiting 20s
    });
    clearTimeout(tid);
    if (!res.ok) return null; // cold or error — caller falls back to text search
    const data = await res.json();
    if (Array.isArray(data?.[0])) return data[0];
    if (Array.isArray(data)) return data;
    return null;
  } catch {
    clearTimeout(tid);
    return null; // timed out or network error
  }
}

/* ─────────────────────────────────────────────
   FAST PATH: Supabase full-text search
   No embedding needed. Responds in ~100-300ms.
   Uses PostgreSQL tsvector/tsquery under the hood.
───────────────────────────────────────────── */
async function textSearch(question) {
  // Convert question to tsquery: extract meaningful words, join with OR
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 8)
    .join(' | ');

  const [lawRes, blogRes] = await Promise.all([
    supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text', terms, { type: 'plain', config: 'english' })
      .limit(5),
    supabase
      .from('posts')
      .select('title, slug, excerpt, content')
      .textSearch('content', terms, { type: 'plain', config: 'english' })
      .limit(5),
  ]);

  return {
    laws:  (lawRes.data  || []).map(l => ({ ...l, similarity: null })),
    blogs: (blogRes.data || []).map(b => ({ ...b, similarity: null })),
    method: 'text',
  };
}

/* ─────────────────────────────────────────────
   QUALITY PATH: vector similarity search
   Better relevance but requires HF embedding.
───────────────────────────────────────────── */
async function vectorSearch(embedding) {
  const [lawRes, blogRes] = await Promise.all([
    supabase.rpc('match_laws',  { query_embedding: embedding, match_threshold: 0.45, match_count: 5 }),
    supabase.rpc('match_posts', { query_embedding: embedding, match_threshold: 0.45, match_count: 5 }),
  ]);
  return {
    laws:  lawRes.data  || [],
    blogs: blogRes.data || [],
    method: 'vector',
  };
}

/* ─────────────────────────────────────────────
   SMART RETRIEVE: try vector first (fast timeout),
   fall back to text search instantly
───────────────────────────────────────────── */
async function retrieve(question) {
  // Try embedding with a 4s timeout (only succeeds if HF model is already warm)
  const embedding = await getEmbedding(question, 4000);

  if (embedding) {
    try {
      const result = await vectorSearch(embedding);
      if (result.laws.length || result.blogs.length) return result;
    } catch { /* fall through */ }
  }

  // HF cold or returned nothing — use instant text search
  return textSearch(question);
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
───────────────────────────────────────────── */
function buildContext({ laws, blogs }) {
  return [
    '==================== LAWS ====================',
    laws.map((l, i) => `[LAW ${i+1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text}`).join('\n\n'),
    '==================== BLOG POSTS ====================',
    blogs.map((p, i) => `[BLOG ${i+1}]\nTitle: ${p.title}\nSlug: ${p.slug}\nExcerpt: ${p.excerpt}\nContent: ${p.content}`).join('\n\n'),
  ].join('\n');
}

const SYSTEM = `You are XeerHub, a Somali legal intelligence assistant.
RULES:
- Use ONLY the provided laws and blog content — never invent facts.
- Laws are primary authority; always cite law name and article number.
- Blogs provide explanatory context only.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

function citationsFrom({ laws, blogs }) {
  return {
    laws:  laws.map(l => ({ type:'law',  law: l.law_name, article: l.article_number, title: l.title, similarity: l.similarity })),
    blogs: blogs.map(b => ({ type:'blog', title: b.title, slug: b.slug, similarity: b.similarity })),
  };
}

/* ─────────────────────────────────────────────
   ROOT
───────────────────────────────────────────── */
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

/* ─────────────────────────────────────────────
   /ask  (warmup + streaming + JSON)
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  // WARMUP — instant, no processing
  if (req.query.warmup === '1') return res.json({ status: 'warm', ok: true });

  const question = req.query.q?.trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  /* ══════════════════════════════════════════
     STREAMING PATH  (?stream=1)
     Sends: status → citations → token… → answer_done
  ══════════════════════════════════════════ */
  if (req.query.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(_) {}
    };

    try {
      send('status', { msg: 'Searching legal database…' });

      let retrieved;
      try {
        retrieved = await retrieve(question);
      } catch(e) {
        send('error', { msg: 'Search unavailable. Please try again.' });
        return res.end();
      }

      const { laws, blogs } = retrieved;

      // Send citations right away — client renders them while text streams in
      send('citations', citationsFrom({ laws, blogs }));

      if (!laws.length && !blogs.length) {
        send('answer_done', {
          answer: "I couldn't find relevant legal content for that question in XeerHub's database. Try rephrasing, or browse the Q&A Library for verified answers.",
        });
        return res.end();
      }

      send('status', { msg: 'Composing AI answer…' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 700,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user',   content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}` },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) { full += token; send('token', { token }); }
      }

      send('answer_done', { answer: full });
      res.end();

    } catch(err) {
      console.error('Stream error:', err);
      try { send('error', { msg: err.message }); res.end(); } catch(_) {}
    }
    return;
  }

  /* ══════════════════════════════════════════
     JSON PATH  (fallback)
  ══════════════════════════════════════════ */
  try {
    const { laws, blogs } = await retrieve(question);

    if (!laws.length && !blogs.length) {
      return res.json({
        answer: "I couldn't find relevant legal content for that question. Try rephrasing, or browse the Q&A Library.",
        citations: { laws: [], blogs: [] },
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}` },
      ],
    });

    return res.json({
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws, blogs }),
    });

  } catch(err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, () => console.log(`XeerHub API running on port ${PORT}`));
