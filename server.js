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
   FAST TEXT SEARCH ONLY
───────────────────────────────────────────── */
async function textSearch(question) {

  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6)
    .join(' | ');

  const [lawRes, blogRes] = await Promise.all([
    supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', terms, { type: 'plain', config: 'english' })
      .limit(3),
    supabase
      .from('blogs')
      .select('slug, title, body')
      .textSearch('text_search', terms, { type: 'plain', config: 'english' })
      .limit(2),
  ]);

  return {
    laws:  lawRes.data  || [],
    blogs: blogRes.data || [],
    method: 'text',
  };
}

/* ─────────────────────────────────────────────
   RETRIEVE
───────────────────────────────────────────── */
async function retrieve(question) {
  return textSearch(question);
}

/* ─────────────────────────────────────────────
   CONTEXT BUILDER
───────────────────────────────────────────── */
function buildContext({ laws, blogs = [] }) {

  const parts = ['==================== LAWS ===================='];

  parts.push(
    laws.map((l, i) =>
      `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text.slice(0, 1200)}`
    ).join('\n\n')
  );

  if (blogs.length) {
    parts.push('==================== BLOG ARTICLES ====================');
    parts.push(
      blogs.map((b, i) => {
        // strip HTML tags for LLM context
        const plain = b.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 800);
        return `[BLOG ${i + 1}]\nSlug: ${b.slug}\nTitle: ${b.title}\nExcerpt: ${plain}`;
      }).join('\n\n')
    );
  }

  return parts.join('\n');
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
function citationsFrom({ laws, blogs = [] }) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: l.article_number,
      title: l.title,
      similarity: l.similarity,
    })),
    blogs: blogs.map(b => ({
      type: 'blog',
      slug: b.slug,
      title: b.title,
    })),
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

  if (!question) {
    return res.status(400).json({
      error: 'Missing question'
    });
  }

  // Cache hit
  if (cache.has(question)) {
    return res.json(cache.get(question));
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

      const retrieved = await retrieve(question);

      const { laws, blogs = [] } = retrieved;

      send('citations', citationsFrom({ laws, blogs }));

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
            content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}`
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

    const { laws, blogs = [] } = await retrieve(question);

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
          content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws, blogs })}`
        }
      ]
    });

    const responseData = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws, blogs }),
    };

    cache.set(question, responseData);

    return res.json(responseData);

  } catch (err) {

    console.error('Server Error:', err);

    return res.status(500).json({
      error: err.message || 'Internal server error'
    });
  }
});

/* ─────────────────────────────────────────────
   BLOG ROUTES
───────────────────────────────────────────── */

// GET /blogs — list all articles (no body, just metadata)
app.get('/blogs', async (req, res) => {
  const { data, error } = await supabase
    .from('blogs')
    .select('id, slug, title, category, date_label, read_time, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /blogs/:slug — single article with full body
app.get('/blogs/:slug', async (req, res) => {
  const { data, error } = await supabase
    .from('blogs')
    .select('*')
    .eq('slug', req.params.slug)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Article not found' });
  res.json(data);
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
