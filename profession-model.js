// profession-model.js — facts about profession names and tiers.
//
// Loaded as a plain <script> by both index.html and tests.html (no modules, no
// build step), so the tests exercise the shipped code rather than a copy.

// "Quantum Engineer T4" -> 4. Names without a tier suffix return 0.
function getTier(name) {
  const m = String(name).match(/ T(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// "Quantum Engineer T4" -> "Quantum Engineer".
function stripTier(name) {
  return String(name).replace(/ T\d+$/, '');
}

// How a matched profession sits against the target, by category and tier.
//
// Accounts of how the game resolves several simultaneous matches disagree, and
// the most-cited one degraded in transit: the wiki claim was introduced (2026-04-26,
// FerroCentric) as "favoring the highest matched tier of job PER CATEGORY", then
// silently reworded (2026-06-30, NCFFCN, no edit summary) to "favoring higher-tier
// matches" — dropping the qualifier and turning a per-category preference into a
// global one. Players also contest whether pinning a target overrides the pick.
//
// So this reports position only, and deliberately separates the two cases the
// readings disagree about. Callers decide what to make of it.
function collateralRisk(targetProfession, matchedProfession, targetCategory, matchedCategory) {
  if (targetProfession === matchedProfession) return 'target';
  if (targetCategory !== matchedCategory) return 'other-category';
  const t = getTier(targetProfession);
  const m = getTier(matchedProfession);
  if (m > t) return 'outranks';
  if (m < t) return 'below';
  return 'ties';
}

