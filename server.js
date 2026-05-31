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

/* ----------------------------
   ENV CHECK
---------------------------- */
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_SERVICE_ROLE_KEY =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("GROQ_API_KEY =", !!process.env.GROQ_API_KEY);
console.log("HF_TOKEN =", !!process.env.HF_API_TOKEN);

/* ----------------------------
   SUPABASE
---------------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ----------------------------
   GROQ
---------------------------- */
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ----------------------------
   EMBEDDING (HuggingFace)
---------------------------- */
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const HF_API_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`;

async function getEmbedding(text) {
  const res = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
  });
  if (!res.ok) throw new Error(`HF embedding failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (Array.isArray(data?.[0])) return data[0];
  if (Array.isArray(data)) return data;
  throw new Error('Unexpected HF embedding response shape');
}

/* ----------------------------
   SHARED: embed + retrieve
---------------------------- */
async function embedAndRetrieve(question) {
  const embedding = await getEmbedding(question);
  const [lawResults, blogResults] = await Promise.all([
    supabase.rpc('match_laws', { query_embedding: embedding, match_threshold: 0.45, match_count: 5 }),
    supabase.rpc('match_posts', { query_embedding: embedding, match_threshold: 0.45, match_count: 5 }),
  ]);
  if (lawResults.error)  console.error('match_laws error:', lawResults.error);
  if (blogResults.error) console.error('match_posts error:', blogResults.error);
  return { laws: lawResults.data || [], blogs: blogResults.data || [] };
}

function buildContext({ laws, blogs }) {
  return `
==================== LAWS ====================
${laws.map((l, i) => `[LAW ${i+1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text}`).join('\n\n')}

==================== BLOG POSTS ====================
${blogs.map((p, i) => `[BLOG ${i+1}]\nTitle: ${p.title}\nSlug: ${p.slug}\nExcerpt: ${p.excerpt}\nContent: ${p.content}`).join('\n\n')}`;
}

const SYSTEM_PROMPT = `You are XeerHub, a Somali legal intelligence assistant.
RULES:
- Use ONLY the provided laws and blog content — never invent facts.
- Laws are primary authority; always cite law name and article number.
- Blogs are explanatory context only.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

/* ----------------------------
   ROOT
---------------------------- */
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

/* ----------------------------
   WARMUP
---------------------------- */
app.get('/ask', async (req, res) => {
  if (req.query.warmup === '1') return res.json({ status: 'warm', ok: true });

  const question = req.query.q?.trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  /* ── STREAMING PATH ── */
  if (req.query.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering on Railway

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // 1. Embed + retrieve
      send('status', { msg: 'Searching legal database…' });
      let retrieved;
      try {
        retrieved = await embedAndRetrieve(question);
      } catch (e) {
        send('error', { msg: 'Embedding service unavailable. Showing local result.' });
        res.end();
        return;
      }

      const { laws, blogs } = retrieved;

      // Send citations immediately — client can render them while text streams
      send('citations', {
        laws:  laws.map(l => ({ type:'law', law: l.law_name, article: l.article_number, title: l.title, similarity: l.similarity })),
        blogs: blogs.map(b => ({ type:'blog', title: b.title, slug: b.slug, similarity: b.similarity })),
      });

      if (!laws.length && !blogs.length) {
        send('answer_done', { answer: "I couldn't find relevant legal content for that question. Try rephrasing, or browse the Q&A Library." });
        res.end();
        return;
      }

      // 2. Stream Groq answer token by token
      send('status', { msg: 'Composing AI answer…' });
      const stream = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 700,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}` },
        ],
      });

      let fullAnswer = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          fullAnswer += token;
          send('token', { token });
        }
      }

      send('answer_done', { answer: fullAnswer });
      res.end();

    } catch (err) {
      console.error('Stream error:', err);
      try { send('error', { msg: err.message }); res.end(); } catch (_) {}
    }
    return;
  }

  /* ── JSON PATH (fallback, kept for compatibility) ── */
  try {
    let retrieved;
    try {
      retrieved = await embedAndRetrieve(question);
    } catch (e) {
      return res.status(502).json({ error: 'Embedding service unavailable.', detail: e.message });
    }

    const { laws, blogs } = retrieved;

    if (!laws.length && !blogs.length) {
      return res.json({
        answer: "I couldn't find relevant legal content for that question. Try rephrasing, or browse the Q&A Library.",
        citations: { laws: [], blogs: [] },
      });
    }

    let completion;
    try {
      completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}` },
        ],
      });
    } catch (e) {
      return res.status(502).json({ error: 'AI service temporarily unavailable.', detail: e.message });
    }

    return res.json({
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: {
        laws:  laws.map(l => ({ type:'law', law: l.law_name, article: l.article_number, title: l.title, similarity: l.similarity })),
        blogs: blogs.map(b => ({ type:'blog', title: b.title, slug: b.slug, similarity: b.similarity })),
      },
    });

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ----------------------------
   START
---------------------------- */
app.listen(PORT, () => console.log(`XeerHub API running on port ${PORT}`));
