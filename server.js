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
   STOP WORDS — excluded from search terms
───────────────────────────────────────────── */
const STOP = new Set([
  'who','what','when','where','which','how','does','can','the',
  'and','for','are','that','this','with','have','from','will',
  'not','but','any','all','was','were','its','their','there',
  'under','after','only','both','each','than','then','been',
  'made','make','same','most','other','may','is','a','an',
  'in','of','to','do','did','has','had','him','his','her',
  'they','them','our','your','my','we','us','me','he','she',
  'define','defined','definition','meaning','mean','means',
  'tell','explain','describe','about','give','get','find'
]);

/* ─────────────────────────────────────────────
   SMART TEXT SEARCH
   1. Try AND search on key terms (most precise)
   2. Fall back to websearch if no results
   3. Fall back to OR search as last resort
───────────────────────────────────────────── */
async function textSearch(question) {

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));

  // No meaningful words — return empty
  if (!words.length) return { laws: [], method: 'text' };

  // 1. AND search — all key terms must appear (most precise)
  const andQuery = words.slice(0, 5).join(' & ');
  let { data } = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .textSearch('text_search', andQuery, { type: 'plain', config: 'english' })
    .limit(5);

  if (data?.length) {
    console.log(`AND search "${andQuery}" → ${data.length} results`);
    return { laws: data, method: 'text-and' };
  }

  // 2. Websearch — handles phrases naturally
  const wsQuery = words.slice(0, 5).join(' ');
  const ws = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .textSearch('text_search', wsQuery, { type: 'websearch', config: 'english' })
    .limit(5);

  if (ws.data?.length) {
    console.log(`Websearch "${wsQuery}" → ${ws.data.length} results`);
    return { laws: ws.data, method: 'text-web' };
  }

  // 3. OR search — broadest fallback (least precise)
  const orQuery = words.slice(0, 4).join(' | ');
  const or = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .textSearch('text_search', orQuery, { type: 'plain', config: 'english' })
    .limit(5);

  console.log(`OR search "${orQuery}" → ${or.data?.length || 0} results`);
  return { laws: or.data || [], method: 'text-or' };
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
function citationsFrom({ laws }) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: l.article_number,
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

    const { laws } = await retrieve(question);

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
   START SERVER
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
