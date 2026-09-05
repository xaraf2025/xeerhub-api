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

// GEMINI_API_KEY is optional at boot — if absent, Somali queries fall
// back to Groq with an English-language system prompt override, so the
// service never hard-fails just because the Somali path isn't configured
// yet. Log it clearly so it's obvious in Railway logs during setup.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY not set — Somali-language queries will fall back to Groq (English).');
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
───────────────────────────────────────────── */
const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  'Environmental Law':      'Environmental Protection and Management Act 2024',
  'Data Protection Law':    'Data Protection Act',
};

/* ─────────────────────────────────────────────
   LANGUAGE DETECTION — Somali stop-word heuristic
   No API call, no added latency. Two-hit threshold
   avoids false positives from a single loanword or
   Somali place name inside an otherwise-English query.
───────────────────────────────────────────── */
const SOMALI_STOPWORDS = new Set([
  'iyo', 'waa', 'ma', 'maxaa', 'maxay', 'sidee', 'sidaa', 'goorma',
  'halkee', 'waxaan', 'waxay', 'waxa', 'wuxuu', 'ayaa', 'oo', 'ku',
  'ka', 'la', 'in', 'uu', 'ay', 'miyaa', 'sow', 'immisa', 'kee', 'tee',
  'markii', 'haddii', 'iyada', 'isaga', 'anaga', 'idinka', 'iyaga',
  'sharci', 'sharciga', 'xeer', 'xeerka', 'shaqaale', 'shaqaalaha',
  'shirkad', 'shirkadda', 'canshuur', 'howlaha', 'xuquuq', 'qofka',
]);

function detectLanguage(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let hits = 0;
  for (const w of words) {
    if (SOMALI_STOPWORDS.has(w)) hits++;
    if (hits >= 2) return 'so';
  }
  return 'en';
}

/* ─────────────────────────────────────────────
   FAST TEXT SEARCH
   NOTE: text_search / text_search_so are separate
   tsvector columns (English config vs 'simple' config,
   since Postgres has no Somali stemmer). We search
   the matching column based on detected language so
   Somali queries aren't run against an English-stemmed
   index and silently return nothing.
───────────────────────────────────────────── */
async function textSearch(question, lawArea, lang) {

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ') // keep Latin + Arabic-script ranges just in case
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6);

  const andTerms = words.join(' & ');
  const orTerms  = words.join(' | ');

  const lawName = LAW_NAME_MAP[lawArea] || null;
  const column = lang === 'so' ? 'text_search_so' : 'text_search';
  const tsConfig = lang === 'so' ? 'simple' : 'english';

  async function runSearch(terms) {
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch(column, terms, { type: 'plain', config: tsConfig })
      .limit(3);

    if (lawName) q = q.eq('law_name', lawName);
    return q;
  }

  let res = await runSearch(andTerms);

  // Fallback 1: OR search on the same-language column
  if (!res.data || res.data.length === 0) {
    res = await runSearch(orTerms);
  }

  // Fallback 2: if a Somali query still yields nothing (e.g. the Somali
  // column isn't populated for this law yet — extraction is in progress
  // per the roadmap), fall back to the English column so the user still
  // gets an answer rather than silence, and we flag that in the response.
  let usedFallbackColumn = false;
  if (lang === 'so' && (!res.data || res.data.length === 0)) {
    usedFallbackColumn = true;
    let q = supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', andTerms, { type: 'plain', config: 'english' })
      .limit(3);
    if (lawName) q = q.eq('law_name', lawName);
    res = await q;
    if (!res.data || res.data.length === 0) {
      q = supabase
        .from('laws')
        .select('law_name, article_number, title, text')
        .textSearch('text_search', orTerms, { type: 'plain', config: 'english' })
        .limit(3);
      if (lawName) q = q.eq('law_name', lawName);
      res = await q;
    }
  }

  return {
    laws: res.data || [],
    method: 'text',
    usedFallbackColumn,
  };
}

/* ─────────────────────────────────────────────
   RETRIEVE
───────────────────────────────────────────── */
async function retrieve(question, lawArea, lang) {
  return textSearch(question, lawArea, lang);
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
   SYSTEM PROMPTS
───────────────────────────────────────────── */
const SYSTEM_EN = `You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY the provided laws.
- Never invent facts.
- Always cite law name and article number.
- Be concise, structured, and accurate.
- If context is insufficient, say so clearly.
- Write in plain English for lawyers, NGOs, and business professionals.`;

const SYSTEM_SO = `Waxaad tahay XeerHub, kaaliye caqli-gal oo ku takhasusay sharciyada Soomaaliya.

XERAYADA:
- Isticmaal KALIYA sharciyada la siiyay.
- Ha been-abuurin xaqiiqooyin.
- Had iyo jeer sheeg magaca sharciga iyo lambarka qodobka (Article).
- Noqo mid kooban, habaysan, oo sax ah.
- Haddii macluumaadku ku filnayn, si cad u sheeg.
- Ku qor Af-Soomaali oo fudud, si ay u fahmaan qareenno, hay'ado bulsho, iyo ganacsato.`;

/* ─────────────────────────────────────────────
   MODEL CALLS
   callGroq  → llama-3.1-8b-instant (English default)
   callGemini → gemini-2.5-flash via REST (Somali path)
   Both expose the same shape: { text, stream? }
   Gemini is called non-streaming and then chunked for
   the SSE path — true token-level streaming from Gemini's
   streamGenerateContent endpoint is a follow-up item, not
   required for the current demo.
───────────────────────────────────────────── */
async function callGeminiNonStreaming(question, context) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_SO }]
    },
    contents: [{
      role: 'user',
      parts: [{ text: `SU'AAL: ${question}\n\nCONTEXT:\n${context}` }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 500,
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

async function callGroqNonStreaming(question, context) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.1,
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_EN },
      { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${context}` }
    ]
  });
  return completion?.choices?.[0]?.message?.content?.trim() || '';
}

/* ─────────────────────────────────────────────
   CITATIONS
───────────────────────────────────────────── */
function cleanArticleNumber(raw) {
  if (!raw) return raw;
  return raw.replace(/^art\.?\s*/i, '').trim();
}

function citationsFrom({ laws }, engine, usedFallbackColumn) {
  return {
    laws: laws.map(l => ({
      type: 'law',
      law: l.law_name,
      article: cleanArticleNumber(l.article_number),
      title: l.title,
      similarity: l.similarity,
    })),
    blogs: [],
    engine,              // 'groq' | 'gemini' — surfaced for demo transparency
    usedFallbackColumn,  // true if a Somali query had to fall back to the English index
  };
}

/* ─────────────────────────────────────────────
   ROOT
───────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'XeerHub API running' });
});

/* ─────────────────────────────────────────────
   ASK ENDPOINT
───────────────────────────────────────────── */
app.get('/ask', async (req, res) => {

  if (req.query.warmup === '1') {
    return res.json({ status: 'warm', ok: true });
  }

  const question = req.query.q?.trim();
  const lawArea  = req.query.law?.trim() || 'General';

  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  const lang = detectLanguage(question);
  const useGemini = lang === 'so' && !!GEMINI_API_KEY;
  const engine = useGemini ? 'gemini' : 'groq';

  const cacheKey = `${engine}::${lawArea}::${question}`;

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
      send('status', { msg: lang === 'so' ? 'Baadhaya sharciyada...' : 'Searching Somali laws...' });

      const retrieved = await retrieve(question, lawArea, lang);
      const { laws, usedFallbackColumn } = retrieved;

      send('citations', citationsFrom({ laws }, engine, usedFallbackColumn));

      if (!laws.length) {
        send('answer_done', {
          answer: lang === 'so'
            ? "Ma helin macluumaad sharci ah oo la xiriira su'aashaada. Fadlan isku day inaad si kale u qorto su'aasha."
            : "I couldn't find relevant legal content for that question in XeerHub's database. Try rephrasing your question."
        });
        return res.end();
      }

      send('status', { msg: lang === 'so' ? 'Diyaarinaya jawaabta...' : 'Preparing answer...' });

      if (useGemini) {
        // Gemini path: non-streaming call, then chunk the result so the
        // frontend's token-by-token rendering still works identically.
        const full = await callGeminiNonStreaming(question, buildContext({ laws }));
        const words = full.split(/(\s+)/); // keep whitespace tokens so spacing is preserved
        for (const w of words) {
          if (w) send('token', { token: w });
          // tiny delay to simulate streaming cadence without adding real latency cost
          await new Promise(r => setTimeout(r, 12));
        }
        send('answer_done', { answer: full });
      } else {
        // Groq path: real token streaming, as before.
        const stream = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          temperature: 0.1,
          max_tokens: 400,
          stream: true,
          messages: [
            { role: 'system', content: SYSTEM_EN },
            { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${buildContext({ laws })}` }
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
        send('answer_done', { answer: full });
      }

      res.end();

    } catch (err) {
      console.error('Stream error:', err);
      // If Gemini fails mid-request (e.g. bad key, quota), fall back to
      // Groq rather than leaving the user with a dead stream.
      if (useGemini) {
        try {
          send('status', { msg: 'Switching engine...' });
          const retrieved = await retrieve(question, lawArea, 'en');
          const groqAnswer = await callGroqNonStreaming(question, buildContext(retrieved));
          send('answer_done', { answer: groqAnswer || 'No answer generated.' });
          return res.end();
        } catch (fallbackErr) {
          console.error('Gemini fallback also failed:', fallbackErr);
        }
      }
      try {
        send('error', { msg: err.message });
        res.end();
      } catch (_) {}
    }

    return;
  }

  /* ══════════════════════════════════════════
     JSON PATH
  ══════════════════════════════════════════ */
  try {
    const { laws, usedFallbackColumn } = await retrieve(question, lawArea, lang);

    if (!laws.length) {
      return res.json({
        answer: lang === 'so'
          ? "Ma helin macluumaad sharci ah oo la xiriira su'aashaada."
          : "I couldn't find relevant legal content for that question. Try rephrasing.",
        citations: { laws: [], blogs: [], engine, usedFallbackColumn: false }
      });
    }

    const context = buildContext({ laws });
    let answerText;

    try {
      answerText = useGemini
        ? await callGeminiNonStreaming(question, context)
        : await callGroqNonStreaming(question, context);
    } catch (modelErr) {
      // Same fallback logic as the streaming path.
      if (useGemini) {
        console.error('Gemini error, falling back to Groq:', modelErr);
        answerText = await callGroqNonStreaming(question, context);
      } else {
        throw modelErr;
      }
    }

    const responseData = {
      answer: answerText || 'No answer generated.',
      citations: citationsFrom({ laws }, engine, usedFallbackColumn),
    };

    cache.set(cacheKey, responseData);
    return res.json(responseData);

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
