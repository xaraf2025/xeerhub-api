import 'dotenv/config';
import { InferenceClient } from '@huggingface/inference';
import { createClient } from '@supabase/supabase-js';

console.log(
  'HF TOKEN:',
  process.env.HF_TOKEN ? 'LOADED' : 'MISSING'
);

const hf = new InferenceClient(process.env.HF_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 10;
const MAX_RETRIES = 3;

function buildEmbeddingText(law) {
  return `
LAW NAME: ${law.law_name}

ARTICLE NUMBER: ${law.article_number}

TITLE: ${law.title}

TEXT:
${law.text}
  `.trim();
}

async function getLaws() {
  const { data, error } = await supabase
    .from('laws')
    .select('id, law_name, article_number, title, text')
    .is('embedding_hf', null)
    .not('text', 'is', null)
    .order('id', { ascending: true })
    .limit(1000);

  if (error) throw error;

  return data || [];
}

async function generateEmbedding(
  text,
  retries = MAX_RETRIES
) {
  try {
    const result = await hf.featureExtraction({
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      inputs: text
    });

    if (
      !Array.isArray(result) ||
      result.length !== 384
    ) {
      throw new Error(
        `Invalid embedding length: ${result?.length}`
      );
    }

    return result;
  } catch (error) {
    if (retries > 0) {
      console.log(
        `Retrying embedding (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`
      );

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );

      return generateEmbedding(
        text,
        retries - 1
      );
    }

    throw error;
  }
}

async function updateEmbedding(id, embedding) {
  const { error } = await supabase
    .from('laws')
    .update({
      embedding_hf: embedding
    })
    .eq('id', id);

  if (error) throw error;
}

async function main() {
  const laws = await getLaws();

  console.log(
    `Found ${laws.length} records needing embeddings`
  );

  let success = 0;
  let failed = 0;

  for (
    let i = 0;
    i < laws.length;
    i += BATCH_SIZE
  ) {
    const batch = laws.slice(
      i,
      i + BATCH_SIZE
    );

    console.log(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}`
    );

    for (const law of batch) {
      try {
        if (!law.text?.trim()) {
          console.log(
            `Skipping ID ${law.id} (empty text)`
          );
          continue;
        }

        console.log(
          `Embedding ID ${law.id} - ${law.article_number}`
        );

        const text =
          buildEmbeddingText(law);

        const embedding =
          await generateEmbedding(text);

        await updateEmbedding(
          law.id,
          embedding
        );

        success++;

        console.log(
          `✓ Saved embedding for ID ${law.id} (${success + failed}/${laws.length})`
        );

        // Prevent HF rate limiting
        await new Promise(resolve =>
          setTimeout(resolve, 500)
        );
      } catch (err) {
        failed++;

        console.error(
          `✗ Failed ID ${law.id}:`,
          err.message
        );
      }
    }

    console.log(
      `Batch completed (${success} success, ${failed} failed)`
    );
  }

  console.log('--------------------------------');
  console.log('Embedding complete');
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);
  console.log('--------------------------------');
}

main().catch(error => {
  console.error(
    'Fatal error:',
    error
  );
});
