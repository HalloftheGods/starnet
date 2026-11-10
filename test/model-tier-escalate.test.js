/* test/model-tier-escalate.test.js — a review loop's reviewer may RAISE the model tier of the work it sends back
   (never lower it): `VERDICT: revise` + `MODEL: opus` reruns the writer on opus. Same rig as loop-verdict.test.js. */
'use strict';
const A = require('./_assert.js');
const MT = require('../sidecar/routing/model-tier.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

A.eq([MT.tierRank('haiku'), MT.tierRank('Sonnet'), MT.tierRank('opus'), MT.tierRank('x')], [0, 1, 2, -1], 'tierRank orders the tiers');

const belt = (x, y, dir) => ({ x, y, dir });
let T = 0; const clock = () => (T += 10);
function floor() {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return { belts, props: [
    { id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'writer' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    { id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', maxIter: 5, when: 'approved' },
    { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' }] };
}
async function run(reviewerReplies, entryText) {
  const router = makeRouter();
  const plan = P.compileRoutingPlan(floor());
  if (!router.setPlan(plan).ok) throw new Error('plan refused');
  const calls = []; let n = 0;
  const c = makeChainRunner({
    nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx),
    fanSiblings: (a) => router.fanSiblings(a), lineOfAgent: (a) => router.lineOfAgent(a),
    loopGateAfter: (a, l) => router.loopGateAfter(a, l), getTag: () => 'general',
    runAgent: async (h) => {
      calls.push(h.agentId + ':' + (h.modelTier || '-'));
      if (h.agentId === 'reviewer') return { text: 'notes\n' + reviewerReplies[n++], usd: 0.01 };
      return { text: h.agentId + ' output', usd: 0.01 };
    }, emit: () => {}, now: clock, setTimer: () => 0 });
  const lineId = P.lineOf(plan, plan.bays[0].agentId);
  const res = await c.advance({ agentId: 'writer', text: entryText, originalText: 'go', lineId, runId: 'esc' });
  return { calls, res };
}

(async () => {
  // reviewer escalates: the writer's retry runs on opus
  let r = await run(['VERDICT: revise\nMODEL: opus', 'VERDICT: approved'], 'draft\nMODEL: sonnet');
  A.eq(r.res.stopped, null, 'ran to its end (' + r.res.stopped + ')');
  A.eq(r.calls, ['reviewer:sonnet', 'writer:opus', 'reviewer:-', 'publisher:-'], 'revise + MODEL: opus raises the retry: ' + JSON.stringify(r.calls));

  // a reviewer naming a LOWER tier never downgrades the retry
  r = await run(['VERDICT: revise\nMODEL: haiku', 'VERDICT: approved'], 'draft');
  A.eq(r.calls, ['reviewer:-', 'writer:-', 'reviewer:-', 'publisher:-'], 'no downgrade, and only opus escalates when nothing was routed: ' + JSON.stringify(r.calls));

  // a plain revise leaves the tier as it was
  r = await run(['VERDICT: revise', 'VERDICT: approved'], 'draft');
  A.eq(r.calls, ['reviewer:-', 'writer:-', 'reviewer:-', 'publisher:-'], 'a plain revise changes no tier');
  A.report('model-tier-escalate.test');
})().catch(e => { console.error('FAIL: harness threw —', e); process.exit(1); });
