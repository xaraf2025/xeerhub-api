import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY'];
for (const key of required) {
  if (!process.env[key]) { console.error(`Missing ENV: ${key}`); process.exit(1); }
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://xeerhub.com', 'https://www.xeerhub.com', 'http://localhost:3000'],
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq     = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Cache ─────────────────────────────────────────────────────
const cache = new Map();

// ── HuggingFace embedding for query ──────────────────────────
async function embedQuery(text) {
  if (!process.env.HF_TOKEN) throw new Error('No HF_TOKEN');
  
  const { InferenceClient } = await import('@huggingface/inference');
  const hf = new InferenceClient(process.env.HF_TOKEN);
  
  const result = await hf.featureExtraction({
    model: 'sentence-transformers/all-MiniLM-L6-v2',
    inputs: text
  });
  return result;
}

// ── Vector search ─────────────────────────────────────────────
async function vectorSearch(question) {
  const embedding = await embedQuery(question);
  const { data, error } = await supabase.rpc('match_laws', {
    query_embedding: embedding,
    match_count: 5
  });
  if (error) throw new Error(`Vector search error: ${error.message}`);
  return data || [];
}

// ── Text search — improved to handle phrases ──────────────────
async function textSearch(question) {
  // Build smarter query: keep meaningful phrases together
  const cleaned = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  // Try phrase search first (exact word sequence)
  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  
  // Use websearch format which supports phrases with quotes
  const phraseQuery = words.length > 1 
    ? `"${words.slice(0,3).join(' ')}"` // try as phrase first
    : words.join(' | ');

  let { data } = await supabase
    .from('laws')
    .select('law_name, article_number, title, text')
    .textSearch('text_search', phraseQuery, { type: 'websearch', config: 'english' })
    .limit(5);

  // If phrase search returns nothing, fall back to OR search
  if (!data || data.length === 0) {
    const orQuery = words.slice(0, 6).join(' | ');
    const res = await supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .textSearch('text_search', orQuery, { type: 'plain', config: 'english' })
      .limit(5);
    data = res.data || [];
  }

  return data || [];
}

// ── Main retrieve — vector first, text fallback ───────────────
async function retrieve(question) {
  // Try vector search
  try {
    const results = await vectorSearch(question);
    if (results.length > 0) {
      console.log(`✓ Vector search → ${results.length} results`);
      return { laws: results, method: 'vector' };
    }
    console.log('Vector search returned 0 results, trying text...');
  } catch (err) {
    console.warn(`Vector search failed: ${err.message}, trying text...`);
  }

  // Fallback to text search
  const results = await textSearch(question);
  console.log(`✓ Text search → ${results.length} results`);
  return { laws: results, method: 'text' };
}

// ── Context builder ───────────────────────────────────────────
function buildContext({ laws }) {
  return laws.map((l, i) =>
    `[LAW ${i + 1}]\nLaw: ${l.law_name}\nArticle: ${l.article_number}\nTitle: ${l.title || ''}\nText: ${(l.text || '').slice(0, 1500)}`
  ).join('\n\n');
}

// ── Citations ─────────────────────────────────────────────────
function buildCitations({ laws }) {
  return {
    laws: laws.map(l => ({
      law: l.law_name,
      article: l.article_number,
      title: l.title,
      similarity: l.similarity
    })),
    blogs: []
  };
}

// ── System prompt ─────────────────────────────────────────────
const SYSTEM = `You are XeerHub, Somalia's AI legal assistant.

RULES:
- Answer ONLY from the provided legal context. Never invent facts.
- Always cite the exact law name and article number.
- Be concise, clear, and professional.
- If the context does not contain the answer, say exactly: "The provided articles do not define this term. Please consult Article 1 of the Foreign Investment Law or browse the Q&A Library."
- Write for lawyers, NGOs, and business professionals in Somalia.`;

// ── Root ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

// ── Ask endpoint ──────────────────────────────────────────────
app.get('/ask', async (req, res) => {

  if (req.query.warmup === '1') return res.json({ status: 'warm', ok: true });

  const question = req.query.q?.trim();
  if (!question) return res.status(400).json({ error: 'Missing question' });

  if (cache.has(question)) return res.json(cache.get(question));

  // ── STREAMING ──────────────────────────────────────────────
  if (req.query.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    try {
      send('status', { msg: 'Searching Somali laws...' });

      const { laws, method } = await retrieve(question);
      console.log(`Search: ${method}, ${laws.length} results for: "${question}"`);

      send('citations', buildCitations({ laws }));

      if (!laws.length) {
        send('answer_done', { 
          answer: "I couldn't find relevant legal content for that question in the XeerHub database. Try browsing the Q&A Library or rephrasing your question." 
        });
        return res.end();
      }

      send('status', { msg: 'Composing answer...' });

      const stream = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        max_tokens: 500,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `QUESTION: ${question}\n\nLEGAL CONTEXT:\n${buildContext({ laws })}` }
        ]
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
      try { send('error', { msg: err.message }); res.end(); } catch (_) {}
    }
    return;
  }

  // ── JSON ───────────────────────────────────────────────────
  try {
    const { laws } = await retrieve(question);

    if (!laws.length) {
      return res.json({ 
        answer: "I couldn't find relevant legal content. Try rephrasing.", 
        citations: { laws: [], blogs: [] } 
      });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `QUESTION: ${question}\n\nLEGAL CONTEXT:\n${buildContext({ laws })}` }
      ]
    });

    const result = {
      answer: completion?.choices?.[0]?.message?.content?.trim() || 'No answer generated.',
      citations: buildCitations({ laws })
    };

    cache.set(question, result);
    return res.json(result);

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`XeerHub API running on port ${PORT}`));
