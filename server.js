import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { InferenceClient } from '@huggingface/inference';
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
   ENV DEBUG
---------------------------- */
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("HF_TOKEN exists =", !!process.env.HF_TOKEN);
console.log("GROQ_KEY exists =", !!process.env.GROQ_API_KEY);

/* ----------------------------
   SUPABASE INIT
---------------------------- */
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

/* ----------------------------
   CLIENTS
---------------------------- */
const hf = new InferenceClient(process.env.HF_TOKEN);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/* ----------------------------
   ROUTES
---------------------------- */

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'XeerHub API running' });
});

// Debug env
app.get('/debug-env', (req, res) => {
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL || null,
    SUPABASE_KEY_EXISTS: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    HF_TOKEN_EXISTS: !!process.env.HF_TOKEN,
    GROQ_KEY_EXISTS: !!process.env.GROQ_API_KEY,
  });
});

/* ----------------------------
   MAIN ASK ROUTE (FIXED RAG)
---------------------------- */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;

    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    /* ----------------------------
       1. CREATE EMBEDDING
    ---------------------------- */
    const queryEmbedding = await hf.featureExtraction({
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      inputs: question,
    });

    const client = initSupabase();

    /* ----------------------------
       2. VECTOR SEARCH (EXPANDED)
    ---------------------------- */
    const { data: laws, error } = await client.rpc('match_laws', {
      query_embedding: queryEmbedding,
      match_count: 8, // increased recall
    });

    if (error) {
      console.error('Supabase Error:', error);
      throw error;
    }

    if (!laws || laws.length === 0) {
      return res.json({
        answer: 'I could not find a relevant provision in the available laws.',
        citations: [],
      });
    }

    /* ----------------------------
       3. TAKE TOP 3 RESULTS
    ---------------------------- */
    const topLaws = laws.slice(0, 3);

    /* ----------------------------
       4. BUILD MULTI-LAW CONTEXT
    ---------------------------- */
    const context = topLaws.map((law, index) => `
[LAW ${index + 1}]
SIMILARITY: ${law.similarity}

LAW: ${law.law_name}
ARTICLE: ${law.article_number}
TITLE: ${law.title}

TEXT:
${law.text}
`).join("\n\n");

    /* ----------------------------
       5. GROQ RESPONSE
    ---------------------------- */
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `
You are XeerHub, a Somali legal research assistant.

Rules:
1. Use ONLY the provided legal context
2. Do NOT combine unrelated legal rules incorrectly
3. Always cite law name, article number, and title
4. Be precise and legally accurate
5. Do not hallucinate missing legal content
          `,
        },
        {
          role: 'user',
          content: `QUESTION:\n${question}\n\nLEGAL CONTEXT:\n${context}`,
        },
      ],
    });

    const answer =
      completion?.choices?.[0]?.message?.content ||
      'No answer generated.';

    /* ----------------------------
       6. RESPONSE
    ---------------------------- */
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

    return res.status(500).json({
      error: err.message || 'Internal server error',
    });
  }
});

/* ----------------------------
   START SERVER
---------------------------- */
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
