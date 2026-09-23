// Runs bench/questions.json against the deployed retrieval pipeline via
// ?debug=1 (no Groq calls — free and fast, and it's the retrieval layer
// we're actually scoring, not the LLM's writing style).
//
// Usage:
//   node bench/run.js https://xeerhub-api-production.up.railway.app

import fs from 'fs';

const API_BASE = process.argv[2] || 'https://xeerhub-api-production.up.railway.app';
const questions = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url)));

function extractNumbers(raw) {
  if (!raw) return [];
  return [...raw.matchAll(/\d+(?:-\d+)?/g)].map(m => m[0]);
}

function matchesExpected(articleNumberRaw, expectedArticles) {
  const nums = extractNumbers(articleNumberRaw);
  return expectedArticles.some(e => nums.includes(e));
}

async function runOne(tc) {
  const url = `${API_BASE}/ask?q=${encodeURIComponent(tc.question)}&debug=1`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ...tc, error: err.message, pass: false, reason: `network error: ${err.message}` };
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    return { ...tc, error: `HTTP ${res.status}`, pass: false, reason: `HTTP ${res.status} — ${bodyText.slice(0, 200)}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ...tc, error: err.message, pass: false, reason: `response was not valid JSON: ${err.message}` };
  }
  const fused = body.fused || [];
  const gate = body.gate;

  if (tc.outOfScope) {
    const pass = gate === 'none';
    return {
      id: tc.id, question: tc.question, expectedLaw: null, expectedArticles: [],
      retrieved: fused.map(f => `${f.law_name} · ${f.article_number}`),
      gate, pass,
      reason: pass ? 'correctly returned no match' : `expected gate=none but got gate=${gate}`,
    };
  }

  let hitRank = -1;
  fused.forEach((f, i) => {
    if (hitRank === -1 && matchesExpected(f.article_number, tc.expectedArticles)) hitRank = i;
  });

  const hit1 = hitRank === 0;
  const hit3 = hitRank >= 0 && hitRank < 3;
  const mrr = hitRank >= 0 ? 1 / (hitRank + 1) : 0;
  const pass = gate === 'supported' && hit3;

  let reason = 'ok';
  if (gate === 'none') reason = 'gate=none — nothing retrieved';
  else if (gate === 'weak') reason = 'gate=weak — below supported threshold';
  else if (hitRank === -1) reason = 'expected article not in top results';
  else if (!hit1) reason = `correct article present but ranked #${hitRank + 1}`;

  return {
    id: tc.id, cluster: tc.cluster || null, question: tc.question,
    expectedLaw: tc.expectedLaw, expectedArticles: tc.expectedArticles,
    retrieved: fused.map(f => `${f.law_name} · ${f.article_number} (score ${f.score?.toFixed(4)})`),
    gate, hitRank, hit1, hit3, mrr, pass, reason,
  };
}

async function main() {
  const results = [];
  for (const tc of questions) {
    const r = await runOne(tc);
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${tc.id.padEnd(10)} ${tc.question}`);
    if (!r.pass) console.log(`        reason: ${r.reason}`);
    await new Promise(res => setTimeout(res, 150)); // be polite to Railway
  }

  const inScope = results.filter(r => !questions.find(q => q.id === r.id)?.outOfScope);
  const oos = results.filter(r => questions.find(q => q.id === r.id)?.outOfScope);

  const hit1Rate = inScope.filter(r => r.hit1).length / inScope.length;
  const hit3Rate = inScope.filter(r => r.hit3).length / inScope.length;
  const mrrAvg = inScope.reduce((s, r) => s + (r.mrr || 0), 0) / inScope.length;
  const oosPassRate = oos.filter(r => r.pass).length / oos.length;

  console.log('\n──────────── SUMMARY ────────────');
  console.log(`In-scope questions : ${inScope.length}`);
  console.log(`hit@1              : ${(hit1Rate * 100).toFixed(1)}%`);
  console.log(`hit@3              : ${(hit3Rate * 100).toFixed(1)}%`);
  console.log(`MRR                : ${mrrAvg.toFixed(3)}`);
  console.log(`Out-of-scope guard : ${(oosPassRate * 100).toFixed(1)}% correctly returned no match (${oos.length} cases)`);

  fs.writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify({ summary: { hit1Rate, hit3Rate, mrrAvg, oosPassRate }, results }, null, 2)
  );
  console.log('\nFull results written to bench/results.json');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
