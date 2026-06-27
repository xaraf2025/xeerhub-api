import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import https from 'https';
import crypto from 'crypto';

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

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://xeerhub.com',
    'https://www.xeerhub.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ─────────────────────────────────────────────
   MAILCHIMP CONFIG
   Set MAILCHIMP_API_KEY and MAILCHIMP_LIST_ID
   as Railway environment variables.
───────────────────────────────────────────── */
const MC_API_KEY  = process.env.MAILCHIMP_API_KEY  || 
const MC_LIST_ID  = process.env.MAILCHIMP_LIST_ID  || 
const MC_DC       = MC_API_KEY.includes('-') ? MC_API_KEY.split('-').pop() : 'us13';

/* ─────────────────────────────────────────────
   SIMPLE MEMORY CACHE
───────────────────────────────────────────── */
const cache = new Map();

/* ─────────────────────────────────────────────
   LAW NAME MAP
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  'Environmental Law':      'Environmental Protection and Management Act 2024',
  'Data Protection Law':    'Data Protection Act',
};

/* ─────────────────────────────────────────────
   TEXT SEARCH
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
  const lawName  = LAW_NAME_MAP[lawArea] || null;

  async function runSearch(terms) {
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', terms, { type: 'plain', config: 'english' })
      .limit(3);
    if (lawName) q = q.eq('law_name', lawName);
    return q;
  }

  let res = await runSearch(andTerms);
  if (!res.data || res.data.length === 0) res = await runSearch(orTerms);
  return { laws: res.data || [], method: 'text' };
}

async function retrieve(question, lawArea) {
  return textSearch(question, lawArea);
}

function buildContext({ laws }) {
  return [
    '==================== LAWS ====================',
    laws.map((l, i) =>
      `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title}\nText: ${l.text.slice(0, 1200)}`
    ).join('\n\n'),
  ].join('\n');
}

const SYSTEM = `You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY the provided laws.
- Never invent facts.
- Always cite law name and article number.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

function cleanArticleNumber(raw) {
  if (!raw) return raw;
  return raw.replace(/^art\.?\s*/i, '').trim();
}

function citationsFrom({ laws }) {
  return {
    laws: laws.map(l => ({
      type:       'law',
      law:        l.law_name,
      article:    cleanArticleNumber(l.article_number),
      title:      l.title,
      similarity: l.similarity,
    })),
    blogs: [],
  };
}

/* ─────────────────────────────────────────────
   ROOT
───────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'XeerHub API running' });
});

/* ─────────────────────────────────────────────
   SUBSCRIBE ENDPOINT
   POST /subscribe  { email: string }
───────────────────────────────────────────── */
app.post('/subscribe', async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const emailHash = crypto.createHash('md5').update(email).digest('hex');
  const hostname  = `${MC_DC}.api.mailchimp.com`;
  const path      = `/3.0/lists/${MC_LIST_ID}/members/${emailHash}`;
  const body      = JSON.stringify({ email_address: email, status_if_new: 'pending', status: 'pending' });
  const auth      = Buffer.from(`anystring:${MC_API_KEY}`).toString('base64');

  const options = {
    hostname,
    path,
    method:  'PUT',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request(options, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end',  ()    => resolve({ status: r.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.setTimeout(15000, () => { req2.destroy(new Error('timeout')); });
      req2.write(body);
      req2.end();
    });

    console.log(`[subscribe] ${email} → ${result.status}: ${result.body.slice(0, 200)}`);

    let parsed = {};
    try { parsed = JSON.parse(result.body); } catch (_) {}

    if (result.status === 200 || result.status === 201) {
      return res.json({ status: parsed.status || 'pending' });
    }
    if (result.status === 400 && ['Member Exists', 'Forgotten Email Not Subscribed'].includes(parsed.title)) {
      return res.json({ status: 'subscribed' });
    }
    // Any other Mailchimp error — return pending so UX doesn't break
    return res.json({ status: 'pending' });

  } catch (err) {
    console.error('[subscribe] error:', err.message);
    // Still return 200/pending — network error shouldn't block the user
    return res.json({ status: 'pending' });
  }
});

/* ─────────────────────────────────────────────
   ASK ENDPOINT  GET /ask
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true });
  }

  const question = req.query.q?.trim();
  const lawArea  = req.query.law?.trim() || 'General';

  if (!question) return res.status(400).json({ error: 'Missing question' });

  const cacheKey = `${lawArea}::${question}`;
  if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

  /* ── STREAMING ── */
  if (req.query.stream === '1') {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    try {
      send('status', { msg: 'Searching Somali laws...' });
      const retrieved = await retrieve(question, lawArea);
      const { laws }  = retrieved;

      send('citations', citationsFrom({ laws }));

      if (!laws.length) {
        send('answer_done', { answer: "I couldn't find relevant legal content for that question in XeerHub's database. Try rephrasing your question." });
        return res.end();
      }

      send('status', { msg: 'Preparing answer...' });

      const stream = await groq.chat.completions.create({
        model:       'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens:  400,
        stream:      true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user',   content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}` },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) { full += token; send('token', { token }); }
      }

      send('answer_done', { answer: full });
      res.end();

    } catch (err) {
      console.error('Stream error:', err);
      try { res.write(`event: error\ndata: ${JSON.stringify({ msg: err.message })}\n\n`); res.end(); } catch (_) {}
    }
    return;
  }

  /* ── JSON ── */
  try {
    const { laws } = await retrieve(question, lawArea);

    if (!laws.length) {
      return res.json({
        answer: "I couldn't find relevant legal content for that question. Try rephrasing.",
        citations: { laws: [], blogs: [] },
      });
    }

    const completion = await groq.chat.completions.create({
      model:       'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens:  400,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}` },
      ],
    });

    const responseData = {
      answer:    completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: citationsFrom({ laws }),
    };

    cache.set(cacheKey, responseData);
    return res.json(responseData);

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
