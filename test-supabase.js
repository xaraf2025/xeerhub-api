import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LAW_NAME_MAP = {
  'Labor Law':              'Somalia Labour Code',
  'Foreign Investment Law': 'Foreign Investment Law',
  'Income Tax Law':         'Income Tax Act 2025',
  'Environmental Law':      'Environmental Protection and Management Act 2024',
  'Data Protection Law':    'Data Protection Act',
};

async function testConnection() {
  console.log('\n=== Testing Supabase Connection ===\n');
  
  try {
    // Test 1: Check if table exists and has data
    const { data, error, count } = await supabase
      .from('laws')
      .select('*', { count: 'exact' })
      .limit(1);
    
    if (error) {
      console.error('❌ Error querying laws table:', error);
      return;
    }
    
    console.log(`✅ Connected to Supabase`);
    console.log(`📊 Total laws in database: ${count}`);
    
    if (data.length > 0) {
      console.log('\n📋 Sample law record:');
      console.log(`   Law Name: ${data[0].law_name}`);
      console.log(`   Article: ${data[0].article_number}`);
      console.log(`   Title: ${data[0].title}`);
      console.log(`   Text (first 200 chars): ${data[0].text?.slice(0, 200) || 'N/A'}`);
      console.log(`   Columns available: ${Object.keys(data[0]).join(', ')}`);
    }
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    return;
  }
  
  // Test 2: Try text search with different queries
  console.log('\n=== Testing Text Search ===\n');
  
  const testQueries = [
    'labor rights',
    'employment',
    'tax',
    'what is labor',
    'xeer',
  ];
  
  for (const q of testQueries) {
    try {
      const words = q
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 6);
      
      const andTerms = words.join(' & ');
      
      const { data: results, error } = await supabase
        .from('laws')
        .select('law_name, article_number, title')
        .textSearch('text_search', andTerms, { config: 'english' })
        .limit(3);
      
      if (error) {
        console.log(`❌ Query "${q}": ${error.message}`);
      } else {
        console.log(`✅ Query "${q}" (terms: "${andTerms}"): ${results.length} results`);
        if (results.length > 0) {
          results.forEach((r, i) => {
            console.log(`   [${i+1}] ${r.law_name} - Article ${r.article_number}`);
          });
        }
      }
    } catch (err) {
      console.log(`❌ Query "${q}": ${err.message}`);
    }
  }
  
  // Test 3: Check if text_search column is populated
  console.log('\n=== Checking text_search Column ===\n');
  try {
    const { data } = await supabase
      .from('laws')
      .select('law_name, article_number, text_search')
      .limit(5);
    
    if (data && data.length > 0) {
      const hasTextSearch = data.some(r => r.text_search);
      console.log(`text_search column populated: ${hasTextSearch ? '✅ Yes' : '❌ No (empty or null)'}`);
      console.log(`Sample text_search values:`);
      data.forEach(r => {
        const tsValue = r.text_search ? `${String(r.text_search).slice(0, 50)}...` : 'NULL';
        console.log(`   ${r.law_name} (${r.article_number}): ${tsValue}`);
      });
    }
  } catch (err) {
    console.log(`❌ Error checking text_search: ${err.message}`);
  }
  
  // Test 4: Try OR fallback
  console.log('\n=== Testing OR Fallback ===\n');
  try {
    const orTerms = 'labor | employment | rights';
    const { data: results, error } = await supabase
      .from('laws')
      .select('law_name, article_number, title')
      .textSearch('text_search', orTerms, { config: 'english' })
      .limit(3);
    
    if (error) {
      console.log(`❌ OR fallback failed: ${error.message}`);
    } else {
      console.log(`✅ OR fallback: ${results.length} results`);
      results.forEach((r, i) => {
        console.log(`   [${i+1}] ${r.law_name} - Article ${r.article_number}`);
      });
    }
  } catch (err) {
    console.log(`❌ OR fallback error: ${err.message}`);
  }

  // Test 5: Try ILIKE fallback
  console.log('\n=== Testing ILIKE Fallback (substring match) ===\n');
  try {
    const { data: results, error } = await supabase
      .from('laws')
      .select('law_name, article_number, title, text')
      .or(`title.ilike.%labor%,text.ilike.%labor%`)
      .limit(3);
    
    if (error) {
      console.log(`❌ ILIKE fallback failed: ${error.message}`);
    } else {
      console.log(`✅ ILIKE fallback: ${results.length} results`);
      results.forEach((r, i) => {
        console.log(`   [${i+1}] ${r.law_name} - Article ${r.article_number}`);
      });
    }
  } catch (err) {
    console.log(`❌ ILIKE fallback error: ${err.message}`);
  }
}

testConnection().catch(console.error).finally(() => process.exit(0));

