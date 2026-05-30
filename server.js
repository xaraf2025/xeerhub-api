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

/* ------------------------------------------------
   SUPABASE
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

/* ------------------------------------------------
   GROQ CLIENT
------------------------------------------------ */
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ------------------------------------------------
   EMBEDDING — using Groq's own embedding model
   (same API key, no HuggingFace cold-start, ~200ms)
   Falls back to keyword search if embedding fails.
------------------------------------------------ */
async function getEmbedding(text) {
  try {
    const resp = await groq.embeddings.create({
      model: 'nomic-embed-text-v1_5',   // Groq's fast embedding model
      input: text,
    });
    return resp.data[0].embedding;
  } catch (err) {
    console.warn('[embed] Groq embedding failed, will skip vector search:', err.message);
    return null;
  }
}

/* ------------------------------------------------
   ROUTES
------------------------------------------------ */
app.get('/', (req, res) => res.json({ status: 'XeerHub API running' }));

app.get('/debug-env', (req, res) => res.json({
  SUPABASE_URL: process.env.SUPABASE_URL || null,
  SUPABASE_KEY_EXISTS: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  GROQ_KEY_EXISTS: !!process.env.GROQ_API_KEY,
}));

/* ------------------------------------------------
   MAIN ASK ROUTE
   Flow: embed question → vector search Supabase →
         Groq LLM → return answer + citations
   All three steps run as fast as possible:
   - Groq embedding: ~200 ms (vs HuggingFace ~2–4 s)
   - Supabase vector search: ~100–300 ms
   - Groq LLaMA answer: ~500–1500 ms
   Total expected: ~1–2 s (was 5–10 s with HuggingFace)
------------------------------------------------ */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;
    if (!question || question === 'ping') {
      // warmup ping — respond instantly
      return res.json({ status: 'warm' });
    }

    const client = initSupabase();

    /* Step 1: embed the question */
    const queryEmbedding = await getEmbedding(question);

    let laws = [];

    if (queryEmbedding) {
      /* Step 2a: vector search */
      const { data, error } = await client.rpc('match_laws', {
        query_embedding: queryEmbedding,
        match_count: 8,
      });
      if (error) {
        console.error('Supabase vector search error:', error);
      } else {
        laws = data || [];
      }
    }

    /* Step 2b: if vector search returned nothing, fall back to keyword search */
    if (!laws.length) {
      const keywords = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5)
        .join(' | ');

      if (keywords) {
        const { data, error } = await client
          .from('laws')
          .select('id, law_name, article_number, title, text')
          .textSearch('text', keywords, { type: 'websearch' })
          .limit(8);
        if (!error && data) laws = data.map(r => ({ ...r, similarity: 0.5 }));
      }
    }

    if (!laws.length) {
      return res.json({
        answer: 'No relevant provision found in the available laws for this question.',
        citations: [],
      });
    }

    /* Step 3: build context from top 3 results */
    const topLaws = laws.slice(0, 3);
    const context = topLaws.map((law, i) => `
[LAW ${i + 1}]
LAW: ${law.law_name}
ARTICLE: ${law.article_number}
TITLE: ${law.title}

TEXT:
${law.text}
`).join('\n\n');

    /* Step 4: Groq LLM answer */
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content: `You are XeerHub, a Somali legal research assistant.
Rules:
1. Use ONLY the provided legal context
2. Always cite the law name and article number
3. Be concise and legally precise
4. Never invent provisions not in the context`,
        },
        {
          role: 'user',
          content: `QUESTION:\n${question}\n\nLEGAL CONTEXT:\n${context}`,
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
        similarity: law.similarity,
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
