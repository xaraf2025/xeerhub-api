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

/* ----------------------------
   ENV CHECK
---------------------------- */
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_SERVICE_ROLE_KEY =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log("GROQ_API_KEY =", !!process.env.GROQ_API_KEY);
console.log("HF_TOKEN =", !!process.env.HF_API_TOKEN);

/* ----------------------------
   SUPABASE
---------------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ----------------------------
   GROQ
---------------------------- */
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/* ----------------------------
   EMBEDDING FUNCTION (HF REST)
---------------------------- */
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const HF_API_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`;

async function getEmbedding(text) {
  const res = await fetch(HF_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: text,
      options: { wait_for_model: true },
    }),
  });

  const data = await res.json();
  return Array.isArray(data?.[0]) ? data[0] : data;
}

/* ----------------------------
   ROOT
---------------------------- */
app.get('/', (req, res) => {
  res.json({ status: 'XeerHub API running' });
});

/* ----------------------------
   MAIN ASK (UNIFIED RAG)
---------------------------- */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q?.trim();

    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    /* ----------------------------
       1. EMBEDDING
    ---------------------------- */
    const embedding = await getEmbedding(question);

    /* ----------------------------
       2. PARALLEL RETRIEVAL
    ---------------------------- */
    const [lawResults, blogResults] = await Promise.all([
      supabase.rpc('match_laws', {
        query_embedding: embedding,
        match_threshold: 0.45,
        match_count: 5,
      }),

      supabase.rpc('match_posts', {
        query_embedding: embedding,
        match_threshold: 0.45,
        match_count: 5,
      }),
    ]);

    const laws = lawResults.data || [];
    const blogs = blogResults.data || [];

    /* ----------------------------
       3. HANDLE EMPTY RESULTS
    ---------------------------- */
    if (!laws.length && !blogs.length) {
      return res.json({
        answer: 'No relevant legal or explanatory content found in the system.',
        citations: { laws: [], blogs: [] },
      });
    }

    /* ----------------------------
       4. BUILD CONTEXT
    ---------------------------- */
    const context = `
==================== LAWS ====================
${laws.map((law, i) => `
[LAW ${i + 1}]
Law: ${law.law_name}
Article: ${law.article_number}
Title: ${law.title}
Text: ${law.text}
`).join('\n')}

==================== BLOG POSTS ====================
${blogs.map((post, i) => `
[BLOG ${i + 1}]
Title: ${post.title}
Slug: ${post.slug}
Excerpt: ${post.excerpt}
Content: ${post.content}
`).join('\n')}
`;

    /* ----------------------------
       5. GROQ ANSWER
---------------------------- */
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content: `
You are XeerHub, a Somali legal intelligence assistant.

RULES:
- Use ONLY provided laws and blog content
- Laws are primary legal authority
- Blogs are explanatory context only
- Always cite law/article when available
- Be concise and accurate
- If insufficient data, say so clearly
          `,
        },
        {
          role: 'user',
          content: `QUESTION: ${question}\n\nCONTEXT:\n${context}`,
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
      citations: {
        laws: laws.map(l => ({
          type: 'law',
          law: l.law_name,
          article: l.article_number,
          title: l.title,
          similarity: l.similarity,
        })),

        blogs: blogs.map(b => ({
          type: 'blog',
          title: b.title,
          slug: b.slug,
          similarity: b.similarity,
        })),
      },
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
