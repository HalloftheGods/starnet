/* test/model-tier.test.js — THE MODEL TIER channel (2026-11-10): a cheap triage step ends with `MODEL: haiku|sonnet|opus`
   and the chain runs the step it hands to (and that step again on a review loop-back) at that tier of its own family. */
'use strict';
const A = require('./_assert.js');
const MT = require('../sidecar/routing/model-tier.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');

// parse: tolerant of dressing, strict about the tail
A.eq(MT.parseModelTier('Job: fix the bug\nMODEL: sonnet'), 'sonnet', 'a plain tier line');
A.eq(MT.parseModelTier('ok\n**Model: Opus.**'), 'opus', 'markdown dressing and case');
A.eq(MT.parseModelTier('- model tier = cheap'), 'haiku', 'a synonym maps to its tier');
A.eq(MT.parseModelTier('MODEL: opus\n' + 'line\n'.repeat(8) + 'done'), null, 'a tier line outside the tail is not the signal');
A.eq(MT.parseModelTier('MODEL: gpt-9'), null, 'an unknown word is no tier');
A.eq(MT.parseModelTier(''), null, 'empty text');
// apply: swaps only a Claude family word, keeps prefix and version
A.eq(MT.applyTier('claude-opus-5-5', 'sonnet'), 'claude-sonnet-5-5', 'opus -> sonnet');
A.eq(MT.applyTier('claude-haiku-5-5', 'opus'), 'claude-opus-5-5', 'haiku -> opus');
A.eq(MT.applyTier('anthropic/claude-opus-4.8', 'haiku'), 'anthropic/claude-haiku-4.8', 'a vendor prefix survives');
A.eq(MT.applyTier('gpt-5', 'opus'), null, 'another family is never rewritten');
A.eq(MT.applyTier('claude-opus-5-5', 'giant'), null, 'an unknown tier is refused');

(async () => {
  // triage -> worker -> reviewer: each hop runs at the tier the stage before it named
  const calls = [];
  let reviews = 0;
  const c = makeChainRunner({
    nextAgent: (a) => ({ triage: 'worker', worker: 'reviewer' })[a] || null,
    runAgent: async (h) => {
      calls.push({ agentId: h.agentId, tier: h.modelTier || null });
      if (h.agentId === 'worker') return { text: 'the work\nMODEL: opus' };   // a worker naming a tier sizes the NEXT dock, not itself
      reviews++;
      return { text: 'looks fine' };
    },
    now: () => 0
  });
  await c.advance({ agentId: 'triage', text: 'Job: answer the Commander\nMODEL: sonnet', originalText: 'hello' });
  A.eq(calls.map(x => x.agentId + ':' + x.tier), ['worker:sonnet', 'reviewer:opus'], 'each hop runs at the tier the stage before it named: ' + JSON.stringify(calls));

  // no tier line: no tier (the exact old behaviour)
  calls.length = 0;
  const c2 = makeChainRunner({ nextAgent: (a) => ({ a: 'b' })[a] || null, runAgent: async (h) => { calls.push(h.modelTier || null); return { text: 'x' }; }, now: () => 0 });
  await c2.advance({ agentId: 'a', text: 'plain output' });
  A.eq(calls, [null], 'a stage with no tier line leaves the next one on its pinned model');
  A.report('model-tier.test');
})().catch(e => { console.error('FAIL: harness threw —', e); process.exit(1); });
