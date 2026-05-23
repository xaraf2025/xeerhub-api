import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { InferenceClient } from '@huggingface/inference';
import Groq from 'groq-sdk';
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY exists =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// Railway requires dynamic port
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const hf = new InferenceClient(process.env.HF_TOKEN);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
    const context = laws
      .map(
        (law) => `
SIMILARITY: ${law.similarity}

LAW: ${law.law_name}
ARTICLE: ${law.article_number}
TITLE: ${law.title}

TEXT:
${law.text}
`
      )
      .join('\n-------------------------\n');

    // Ask Groq
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `
You are XeerHub, a Somali legal research assistant.

Rules:

1. Use ONLY the legal articles provided in LEGAL CONTEXT.
2. Prefer the article with the HIGHEST SIMILARITY score.
3. Do NOT combine unrelated articles.
4. Always cite:
   - Law name
   - Article number
   - Article title
5. If not found, respond exactly:
"I could not find a relevant provision in the available laws."
6. Never invent legal content.
7. Quote legal text only when necessary.
8. Keep answers concise and professional.
9. Respond in the user's language when possible.
          `,
        },
        {
          role: 'user',
          content: `
QUESTION:
${question}

LEGAL CONTEXT:
${context}
          `,
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

// Health check route
app.get('/', (req, res) => {
  res.json({
    status: 'XeerHub API running',
  });
});

// Railway-compatible port
app.listen(PORT, () => {
  console.log(`XeerHub API running on port ${PORT}`);
});
