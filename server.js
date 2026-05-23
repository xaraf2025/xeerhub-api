import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { InferenceClient } from '@huggingface/inference';
import Groq from 'groq-sdk';

const app = express();

app.use(cors());
app.use(express.json());

// Railway requires dynamic port
const PORT = process.env.PORT || 3000;

/* ----------------------------
   ENV DEBUG (IMPORTANT)
---------------------------- */
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("HF_TOKEN exists =", !!process.env.HF_TOKEN);
console.log("GROQ_KEY exists =", !!process.env.GROQ_API_KEY);

/* ----------------------------
   SAFETY CHECK (prevents crash)
---------------------------- */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables");
}

/* ----------------------------
   CLIENTS
---------------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// DEBUG ENV (THIS IS WHAT YOU NEED NOW)
app.get('/debug-env', (req, res) => {
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL || null,
    SUPABASE_KEY_EXISTS: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    HF_TOKEN_EXISTS: !!process.env.HF_TOKEN,
    GROQ_KEY_EXISTS: !!process.env.GROQ_API_KEY,
  });
});

// MAIN ASK ROUTE
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;

    if (!question) {
      return res.status(400).json({
        error: 'Missing question',
      });
    }

    // Create embedding
    const queryEmbedding = await hf.featureExtraction({
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      inputs: question,
    });

    // Vector search
    const { data: laws, error } = await supabase.rpc('match_laws', {
      query_embedding: queryEmbedding,
      match_count: 5,
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

    // Build context
    const context = laws.map((law) => `
SIMILARITY: ${law.similarity}

LAW: ${law.law_name}
ARTICLE: ${law.article_number}
TITLE: ${law.title}

TEXT:
${law.text}
`).join('\n-------------------------\n');

    // Groq call
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `
You are XeerHub, a Somali legal research assistant.

Rules:
1. Use ONLY provided legal context
2. Do not invent laws
3. Always cite law name, article number, title
4. Be concise and professional
5. Respond in user language when possible
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
      citations: laws.map((law) => ({
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
