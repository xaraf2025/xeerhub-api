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
    'http://localhost:3000',   // for local dev testing
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
   SAFE SUPABASE INIT
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
  res.json({
    status: 'XeerHub API running',
  });
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
   MAIN ASK ROUTE (IMPROVED)
---------------------------- */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;

    if (!question) {
      return res.status(400).json({
        error: 'Missing question',
      });
    }

    // Embedding
    const queryEmbedding = await hf.featureExtraction({
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      inputs: question,
    });

    // Supabase search
    const client = initSupabase();

    const { data: laws, error } = await client.rpc('match_laws', {
      query_embedding: queryEmbedding,
      match_count: 3, // reduced for precision
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

    // 🧠 Use ONLY best match (critical fix)
    const bestLaw = laws[0];

    // Confidence filter (prevents weak matches)
    if (bestLaw.similarity < 0.5) {
      return res.json({
        answer: "No strong legal match found in the database.",
        citations: [],
      });
    }

    const context = `
SIMILARITY: ${bestLaw.similarity}

LAW: ${bestLaw.law_name}
ARTICLE: ${bestLaw.article_number}
TITLE: ${bestLaw.title}

TEXT:
${bestLaw.text}
`;

    // Groq response
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
2. Do NOT combine multiple laws
3. Do NOT invent legal information
4. Always cite law name, article number, and title
5. Be concise and legally precise
6. Respond in the user's language when possible
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

    return res.json({
      answer,
      citations: [
        {
          law: bestLaw.law_name,
          article: bestLaw.article_number,
          title: bestLaw.title,
          similarity: bestLaw.similarity,
        },
      ],
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
