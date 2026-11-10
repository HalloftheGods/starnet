/* sidecar/routing/model-tier.js — THE MODEL TIER channel (2026-11-10).

   A cheap first step (a triage bay on a small model) may end its output with one line:

       MODEL: haiku | sonnet | opus

   The chain runner carries that word to the NEXT step it hands to (and to that same step again when a review loop
   sends the work back), and the host runs that step on the same model family at the named tier instead of the
   agent's pinned model. So a Discord message is sized by a cheap model, and only the work that needs the big model
   pays for it. The line's $ budget still governs every hop; a step with no tier line runs exactly as before.

   parseModelTier() is the ONLY reader of that line: tolerant of dressing (**MODEL: Sonnet**, a bullet, a trailing
   period), strict about WHERE (among the last few non-empty lines, so a step quoting the format in its reasoning
   does not trip it). applyTier() swaps the family word inside a Claude model id and refuses anything else, so a
   tier never invents a model the provider does not serve. PURE: strings in, strings or null out. */
'use strict';

const TIERS = ['haiku', 'sonnet', 'opus'];
const SYN = { haiku: 'haiku', small: 'haiku', cheap: 'haiku', fast: 'haiku', light: 'haiku',
              sonnet: 'sonnet', medium: 'sonnet', mid: 'sonnet', standard: 'sonnet',
              opus: 'opus', large: 'opus', big: 'opus', heavy: 'opus', max: 'opus' };
const TAIL_LINES = 4;   // how many trailing non-empty lines may carry the tier (room for a VERDICT line beside it)

/* parseModelTier(text) -> 'haiku' | 'sonnet' | 'opus' | null. The LAST tier line within the tail wins. */
function parseModelTier(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i].replace(/^[\s>*\-_`#]+/, '').replace(/[\s*_`.!]+$/, '');
    const m = /^(?:model|model[ _-]?tier|tier)\s*[:=\-–—]\s*\**\s*([A-Za-z]+)/i.exec(l);
    if (!m) continue;
    const w = SYN[m[1].toLowerCase()];
    if (w) return w;
  }
  return null;
}

/* applyTier(model, tier) -> the same model id with its Claude family word swapped to `tier`, or null when the id has
   no Claude family word (another provider's model) or the tier is unknown. Keeps any vendor prefix and version:
   claude-opus-5-5 + sonnet -> claude-sonnet-5-5 · anthropic/claude-opus-4.8 + haiku -> anthropic/claude-haiku-4.8. */
function applyTier(model, tier) {
  const t = typeof tier === 'string' ? tier.toLowerCase() : '';
  if (TIERS.indexOf(t) < 0 || typeof model !== 'string' || !model) return null;
  const re = /(^|[/:])claude-(haiku|sonnet|opus)(?=[-.]|$)/i;
  if (!re.test(model)) return null;
  return model.replace(re, (all, pre) => pre + 'claude-' + t);
}

/* tierBrief(): the sentence a triage step's brief carries so the model knows the line exists and its format. */
function tierBrief() {
  return 'End your reply with one line saying which model the next step needs: MODEL: haiku (a quick answer, a lookup, a short chat reply), '
    + 'MODEL: sonnet (ordinary work: drafting, research, routine code) or MODEL: opus (hard work: architecture, tricky debugging, strategy, anything high-stakes). Pick the cheapest that will do it well.';
}

/* tierRank(tier) -> 0 haiku, 1 sonnet, 2 opus, -1 unknown: lets a reviewer escalate a tier but never lower it. */
function tierRank(tier) { return TIERS.indexOf(String(tier || '').toLowerCase()); }

module.exports = { TIERS, parseModelTier, applyTier, tierBrief, tierRank };
