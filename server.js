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
   CLIENTS
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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
   
   NOTE: Groq does NOT offer an embeddings API.
   Strategy: use Supabase full-text search (fast, 
   built-in, no external embedding call needed).
   Then pass top results straight to Groq LLaMA.
   
   Expected total time: ~0.8–2s
   - Supabase full-text search: ~100–400ms
   - Groq LLaMA answer:        ~500–1500ms
------------------------------------------------ */
app.get('/ask', async (req, res) => {
  try {
    const question = req.query.q;

    // warmup ping — respond instantly, no DB call
    if (!question || question === 'ping' || question === 'warmup=1') {
      return res.json({ status: 'warm' });
    }

    const client = initSupabase();

    /* Step 1: Full-text search in Supabase
       Build a query from the most meaningful words
       in the question (strip short/common words).    */
    const stopWords = new Set([
      'what','when','where','which','who','how','does','can','the','and',
      'for','are','that','this','with','have','from','will','they','also',
      'into','its','not','but','any','all','more','must','their','your',
      'there','under','after','only','both','each','such','some','than',
      'then','made','make','same','most','other','may','about','would',
      'should','could','need','want','like','just','even','still','very',
      'much','many','well','also','here','there','then','than','these',
      'those','them','they','been','being','have','has','had','were','was',
    ]);

    const keywords = question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
      .slice(0, 6);

    if (!keywords.length) {
      return res.json({
        answer: 'Please ask a more specific legal question.',
        citations: [],
      });
    }

    // Use websearch format: words joined by & for AND logic
    const searchQuery = keywords.join(' & ');

    const { data: laws, error } = await client
      .from('laws')
      .select('id, law_name, article_number, title, text')
      .textSearch('text', searchQuery, { type: 'plain' })
      .limit(6);

    if (error) {
      console.error('Supabase search error:', error);
      // Fallback: simpler OR search if AND search errors
      const { data: fallback, error: err2 } = await client
        .from('laws')
        .select('id, law_name, article_number, title, text')
        .textSearch('text', keywords.join(' | '), { type: 'plain' })
        .limit(6);
      if (err2 || !fallback?.length) {
        return res.json({
          answer: 'Unable to search the legal database at this time. Please try again.',
          citations: [],
        });
      }
      laws = fallback;
    }

    if (!laws || !laws.length) {
      return res.json({
        answer: 'No relevant provision found in Somali law for this question. Try rephrasing or browsing the Q&A library.',
        citations: [],
      });
    }

    /* Step 2: Build context from top 3 results */
    const topLaws = laws.slice(0, 3);
    const context = topLaws.map((law, i) => `
[SOURCE ${i + 1}]
Law: ${law.law_name}
Article: ${law.article_number}
Title: ${law.title}
Text: ${law.text}
`).join('\n');

    /* Step 3: Groq LLaMA answer — fast, no embedding needed */
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `You are XeerHub, a Somali legal research assistant.
Rules:
1. Answer using ONLY the provided legal sources
2. Always cite the exact law name and article number
3. Be concise — 3 to 5 sentences maximum
4. Never invent provisions not in the sources
5. If the sources don't answer the question, say so clearly`,
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nLegal sources:\n${context}`,
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
        similarity: 1.0,
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
