// Runs bench/questions.json against the deployed retrieval pipeline via
// ?debug=1 (no Groq calls — free and fast, and it's the retrieval layer
// we're actually scoring, not the LLM's writing style).
//
// Usage:
//   node bench/run.js https://xeerhub-api-production.up.railway.app

import fs from 'fs';

const API_BASE = process.argv[2] || 'https://xeerhub-api-production.up.railway.app';
const questions = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url)));

// Expands "62-63" / "57–58" into 62,63 / 57,58 and keeps regulation-style
// tokens like "9-1" (where the second number is smaller) as-is.
function extractNumbers(raw) {
  if (!raw) return [];
  const out = new Set();
  for (const m of raw.matchAll(/(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    const a = parseInt(m[1], 10);
    out.add(m[1]);
    if (m[2]) {
      const b = parseInt(m[2], 10);
      out.add(`${m[1]}-${m[2]}`);
      if (b > a && b - a <= 20) for (let n = a; n <= b; n++) out.add(String(n));
    }
  }
  return [...out];
}

// A hit needs the right LAW as well as the right article number — otherwise
// e.g. Income Tax "Arts. 16, 17, 18, 19" would count as a hit for Foreign Investment Art. 18.
function matchesExpected(row, tc) {
  if (tc.expectedLaw && row.law_name !== tc.expectedLaw) return false;
  const nums = extractNumbers(row.article_number);
  return tc.expectedArticles.some(e => nums.includes(e));
}

const fmt = f => `${f.law_name} · ${f.article_number} (rrf ${f.score?.toFixed(4)}${typeof f.similarity === 'number' ? ', cos ' + f.similarity.toFixed(3) : ''}; ${(f.hitBy || []).join('+')})`;

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
  const signals = body.signals || {};
  const gateReason = body.gateReason || null;
  const modelLoaded = body.modelLoaded;

  if (tc.outOfScope) {
    // "weak" never calls Groq (the user sees the 'sources don't clearly cover this'
    // message), so for out-of-scope questions the real failure is gate=supported.
    // strictNone is tracked separately for calibration.
    const pass = gate !== 'supported';
    const strictNone = gate === 'none';
    return {
      id: tc.id, question: tc.question, expectedLaw: null, expectedArticles: [],
      retrieved: fused.map(fmt),
      gate, gateReason, signals, modelLoaded, pass, strictNone,
      reason: pass ? (strictNone ? 'correctly returned no match' : 'not answered (gate=weak)') : `out-of-scope question was ANSWERED (gate=supported: ${gateReason})`,
    };
  }

  let hitRank = -1;
  fused.forEach((f, i) => {
    if (hitRank === -1 && matchesExpected(f, tc)) hitRank = i;
  });

  const hit1 = hitRank === 0;
  const hit3 = hitRank >= 0 && hitRank < 3;
  const mrr = hitRank >= 0 ? 1 / (hitRank + 1) : 0;
  const pass = gate === 'supported' && hit3;

  let reason = 'ok';
  if (gate === 'none') reason = `gate=none — ${gateReason}`;
  else if (gate === 'weak') reason = `gate=weak — ${gateReason}`;
  else if (hitRank === -1) reason = 'expected article not in top results';
  else if (!hit1) reason = `correct article present but ranked #${hitRank + 1}`;

  return {
    id: tc.id, cluster: tc.cluster || null, question: tc.question,
    expectedLaw: tc.expectedLaw, expectedArticles: tc.expectedArticles,
    retrieved: fused.map(fmt),
    gate, gateReason, signals, modelLoaded, hitRank, hit1, hit3, mrr, pass, reason,
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
  const oosStrictRate = oos.filter(r => r.strictNone).length / oos.length;

  console.log('\n──────────── SUMMARY ────────────');
  console.log(`In-scope questions : ${inScope.length}`);
  console.log(`hit@1              : ${(hit1Rate * 100).toFixed(1)}%`);
  console.log(`hit@3              : ${(hit3Rate * 100).toFixed(1)}%`);
  console.log(`MRR                : ${mrrAvg.toFixed(3)}`);
  console.log(`Out-of-scope guard : ${(oosPassRate * 100).toFixed(1)}% not answered (${oos.length} cases)  |  strict gate=none: ${(oosStrictRate * 100).toFixed(1)}%`);

  // ── Signal diagnostics: is the vector path alive, and where do the similarities sit?
  const vecDead = results.filter(r => r.signals && r.signals.vectorAvailable === false).length;
  const modelDown = results.filter(r => r.modelLoaded === false).length;
  console.log('\n──────────── SIGNALS (for calibrating the gate) ────────────');
  console.log(`Vector returned 0 rows : ${vecDead} / ${results.length}`);
  console.log(`Model not loaded       : ${modelDown} / ${results.length}`);
  if (vecDead === results.length) {
    console.log('!! Vector retrieval contributed NOTHING to any question. Fix that first —');
    console.log('!! run:  curl "' + API_BASE + '/ask?q=test&debug=1"  and read the "vector" step in trace.');
  }
  const stats = arr => {
    const v = arr.filter(x => typeof x === 'number').sort((a, b) => a - b);
    if (!v.length) return 'n/a';
    const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(3);
    return `min ${v[0].toFixed(3)} | p25 ${q(0.25)} | median ${q(0.5)} | p75 ${q(0.75)} | max ${v[v.length - 1].toFixed(3)}`;
  };
  const inScopeTop = inScope.filter(r => r.hit3).map(r => r.signals?.vecTop);
  const inScopeMiss = inScope.filter(r => !r.hit3).map(r => r.signals?.vecTop);
  const oosTop = oos.map(r => r.signals?.vecTop);
  console.log(`vecTop, in-scope, article found (hit@3) : ${stats(inScopeTop)}`);
  console.log(`vecTop, in-scope, article NOT found     : ${stats(inScopeMiss)}`);
  console.log(`vecTop, out-of-scope                    : ${stats(oosTop)}`);
  console.log('Set VEC_SUPPORTED just below the low end of the first row, VEC_WEAK just above the high end of the last row.');

  const failing = results.filter(r => !r.pass);
  if (failing.length) {
    console.log('\nFailure reasons:');
    const byReason = {};
    failing.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v} × ${k}`));
  }

  fs.writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify({ summary: { hit1Rate, hit3Rate, mrrAvg, oosPassRate, oosStrictRate }, results }, null, 2)
  );
  console.log('\nFull results written to bench/results.json');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
