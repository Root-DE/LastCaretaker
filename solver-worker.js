// solver-worker.js — Specificity-optimized parallel solver for Web Workers
// Ported from the Rust IDA* specificity solver

let shouldStop = false;
let shouldPause = false;
let ecoMode = false;
let availArr = null;

// ── WebAssembly kernel for countValid (the hottest per-node operation) ──
// The kernel source lives in wasm/solver-kernel.wat (reviewable) and is compiled
// to solver-kernel.wasm by `npm run build:wasm`; CI verifies the two stay in sync.
// The worker fetches that .wasm from the same origin at startup. Measured ~2.3x
// faster than the JS loop on the real dataset; per-call marshalling of the
// 15-float `total` vector is negligible next to the comparison loop. If the
// fetch or instantiation fails for any reason (offline, missing file, bad MIME),
// a JS fallback runs and behaviour is identical either way.
let wasmCountFn = null;     // exported countValid(ho,hstat,hval,n,cap)
let wasmMemF64 = null;      // Float64 view of wasm linear memory
let wasmMemI32 = null;      // Int32 view of the same buffer
let wasmHO = 0, wasmHSTAT = 0, wasmHVAL = 0, wasmNHumans = 0, wasmReady = false;

// Kick off loading at worker startup. `solve` awaits this before running so the
// first search already has the kernel; later searches reuse the loaded instance.
const wasmInitPromise = (async function initWasm() {
  try {
    const url = new URL('solver-kernel.wasm', self.location.href).href;
    let inst;
    try {
      const res = await WebAssembly.instantiateStreaming(fetch(url), {});
      inst = res.instance;
    } catch (streamErr) {
      // Fallback for servers that don't send application/wasm MIME type.
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('fetch ' + resp.status);
      const bytes = await resp.arrayBuffer();
      const res = await WebAssembly.instantiate(bytes, {});
      inst = res.instance;
    }
    wasmCountFn = inst.exports.countValid;
    wasmMemF64 = new Float64Array(inst.exports.mem.buffer);
    wasmMemI32 = new Int32Array(inst.exports.mem.buffer);
  } catch (e) {
    wasmCountFn = null; // fall back to the JS implementation
  }
})();

// Load the static human data into wasm linear memory once per solve.
// Returns true if the kernel is usable for this dataset, false to force JS.
function wasmLoadHumans(humanSparse, humanOffsets, nHumans) {
  wasmReady = false;
  if (!wasmCountFn) return false;
  const nEntries = humanOffsets[nHumans] / 2; // humanOffsets is in flat (pair) units
  // Layout: total[0..14] f64 at byte 0; then HO (i32), HSTAT (i32), HVAL (f64).
  const HO = 128;
  const HSTAT = HO + (nHumans + 1) * 4;
  let HVAL = HSTAT + nEntries * 4;
  HVAL = (HVAL + 7) & ~7; // 8-byte align for the f64 values
  const need = HVAL + nEntries * 8;
  if (need > wasmMemF64.byteLength) return false; // dataset too large; use JS
  for (let h = 0; h <= nHumans; h++) wasmMemI32[(HO >> 2) + h] = humanOffsets[h] / 2;
  for (let e = 0; e < nEntries; e++) {
    wasmMemI32[(HSTAT >> 2) + e] = humanSparse[e * 2];     // stat index
    wasmMemF64[(HVAL >> 3) + e] = humanSparse[e * 2 + 1];  // required value
  }
  wasmHO = HO; wasmHSTAT = HSTAT; wasmHVAL = HVAL; wasmNHumans = nHumans;
  wasmReady = true;
  return true;
}

// Count professions satisfied by `total` via the wasm kernel. cap>0 enables
// early-exit pruning: it returns cap as soon as cap matches are found.
function wasmCount(total, cap) {
  const f = wasmMemF64;
  f[0] = total[0]; f[1] = total[1]; f[2] = total[2]; f[3] = total[3]; f[4] = total[4];
  f[5] = total[5]; f[6] = total[6]; f[7] = total[7]; f[8] = total[8]; f[9] = total[9];
  f[10] = total[10]; f[11] = total[11]; f[12] = total[12]; f[13] = total[13]; f[14] = total[14];
  return wasmCountFn(wasmHO, wasmHSTAT, wasmHVAL, wasmNHumans, cap);
}

self.onmessage = function (e) {
  if (e.data.type === 'stop') {
    shouldStop = true;
    shouldPause = false;
  } else if (e.data.type === 'pause') {
    shouldPause = true;
  } else if (e.data.type === 'resume') {
    shouldPause = false;
  } else if (e.data.type === 'solve') {
    shouldStop = false;
    shouldPause = false;
    // Ensure the wasm kernel has finished loading (or failed to a JS fallback)
    // before the search starts, so the very first solve gets the fast path too.
    wasmInitPromise.then(() => solve(e.data));
  }
};

// Count how many professions a stat total satisfies
// humanSparse: Float64Array of [statIdx, value, ...] pairs, humanOffsets: Int32Array[nHumans+1]
function countValid(total, humanSparse, humanOffsets, nHumans) {
  if (wasmReady) return wasmCount(total, 0);
  let count = 0;
  for (let h = 0; h < nHumans; h++) {
    let valid = true;
    const start = humanOffsets[h], end = humanOffsets[h + 1];
    for (let k = start; k < end; k += 2) {
      if (total[humanSparse[k]] < humanSparse[k + 1]) {
        valid = false;
        break;
      }
    }
    if (valid) count++;
  }
  return count;
}

function computeResourceCost(chosen, chosenLen, avail) {
  if (!avail) return 0;
  const counts = new Int32Array(avail.length);
  for (let i = 0; i < chosenLen; i++) counts[chosen[i]]++;
  let cost = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0 && avail[i] > 0) cost += counts[i] / avail[i];
  }
  return cost;
}

// Total overshoot: sum of stats provided beyond the target's own requirement
// (reqVec[s] is the target profession's requirement for stat s, 0 if it needs none).
// Zero overshoot means the build matches the target's stat vector exactly, which
// drives collateral down to its inherent floor. Used as the secondary objective.
function computeOvershoot(total, reqVec) {
  let over = 0;
  for (let s = 0; s < 15; s++) {
    const ex = total[s] - reqVec[s];
    if (ex > 0) over += ex;
  }
  return over;
}

// Exact lower bound on the minimum item count via the LP relaxation
//   minimize  sum_i x_i   subject to  sum_i A[i,s]*x_i >= b_s  (required stats), x_i >= 0
// Its dual is   maximize sum_s y_s*b_s  s.t.  sum_s y_s*A[i,s] <= 1 (each usable item), y_s >= 0.
// By weak duality, ANY dual-feasible y gives  sum_s y_s*b_s <= LP* <= (integer optimum),
// so ceil(sum_s y_s*b_s) is an admissible lower bound on the optimal item count.
// We find a good y with a feasibility-preserving greedy dual ascent (rows raised in
// descending standalone-bound order), then scale y to be strictly feasible so the
// returned bound is provably valid despite floating-point drift. Items with
// maxCounts <= 0 are unusable and excluded (tightens the bound while staying valid).
// Returns Infinity when a required stat cannot be supplied by any usable item (infeasible).
function computeLpLowerBound(itemFlat, nItems, reqs, nReqs, maxCounts) {
  if (nReqs === 0) return 1;

  // Per-row max single-item contribution among usable items, and standalone bound.
  const rowOrder = [];
  for (let r = 0; r < nReqs; r++) {
    const si = reqs[r * 2];
    let mx = 0;
    for (let i = 0; i < nItems; i++) {
      if (maxCounts[i] <= 0) continue;
      const a = itemFlat[i * 15 + si];
      if (a > mx) mx = a;
    }
    if (mx <= 0) return Infinity; // no usable item supplies this required stat
    rowOrder.push({ r, standalone: reqs[r * 2 + 1] / mx });
  }
  rowOrder.sort((a, b) => b.standalone - a.standalone);

  const y = new Float64Array(nReqs);
  const slack = new Float64Array(nItems);
  for (let i = 0; i < nItems; i++) slack[i] = maxCounts[i] > 0 ? 1 : Infinity;

  const EPS = 1e-12;
  let improvedAny = true;
  let guard = 0;
  while (improvedAny && guard < 5000) {
    improvedAny = false;
    for (let o = 0; o < rowOrder.length; o++) {
      const r = rowOrder[o].r;
      const si = reqs[r * 2];
      let maxDelta = Infinity;
      for (let i = 0; i < nItems; i++) {
        if (maxCounts[i] <= 0) continue;
        const a = itemFlat[i * 15 + si];
        if (a > 0) {
          const d = slack[i] / a;
          if (d < maxDelta) maxDelta = d;
        }
      }
      if (maxDelta > EPS && maxDelta < Infinity) {
        y[r] += maxDelta;
        for (let i = 0; i < nItems; i++) {
          if (maxCounts[i] <= 0) continue;
          const a = itemFlat[i * 15 + si];
          if (a > 0) slack[i] -= maxDelta * a;
        }
        improvedAny = true;
        guard++;
      }
    }
  }

  // Scale y to be strictly dual-feasible (guards against float accumulation).
  let maxLhs = 0;
  for (let i = 0; i < nItems; i++) {
    if (maxCounts[i] <= 0) continue;
    let lhs = 0;
    for (let r = 0; r < nReqs; r++) lhs += y[r] * itemFlat[i * 15 + reqs[r * 2]];
    if (lhs > maxLhs) maxLhs = lhs;
  }
  let scale = 1;
  if (maxLhs > 1) scale = 1 / maxLhs;

  let bound = 0;
  for (let r = 0; r < nReqs; r++) bound += y[r] * scale * reqs[r * 2 + 1];
  return Math.max(1, Math.ceil(bound - 1e-9));
}

function considerSolution(chosen, chosenLen, total, state,
                         humanSparse, humanOffsets, nHumans,
                         allowPerfectStop) {
  const coll = countValid(total, humanSparse, humanOffsets, nHumans);
  const over = computeOvershoot(total, state.reqVec);
  const resCost = computeResourceCost(chosen, chosenLen, availArr);
  // Objective order: (1) minimize collateral — the user-facing metric, kept primary
  // so result quality can never regress; (2) minimize overshoot — the user's
  // "zero overshoot" goal, which also pushes collateral toward its floor;
  // (3) the cost/size tie-break (eco resourceCost, else item count).
  const tieCost = ecoMode ? resCost : chosenLen;
  const bestTie = ecoMode ? state.bestCost : state.bestLen;
  if (coll < state.bestColl
      || (coll === state.bestColl && (over < state.bestOver
      || (over === state.bestOver && tieCost < bestTie)))) {
    state.bestColl = coll;
    state.bestOver = over;
    state.bestLen = chosenLen;
    state.bestCost = resCost;
    state.bestSol = {
      items: Array.from(chosen.subarray(0, chosenLen)),
      total: Array.from(total),
      collateral: coll,
      overshoot: over,
      resourceCost: resCost,
    };
    self.postMessage({ type: 'newBest', solution: state.bestSol, nodes: state.nodes });
    if (allowPerfectStop && coll <= state.inherentCount && !ecoMode) {
      state.perfect = true;
      state.provenPerfect = true;
    }
    return true;
  }
  return false;
}

function scoreItemForDeficits(itemFlat, reqs, nReqs, total, itemIdx, deficitMask, itemBaseScore) {
  if ((deficitMask | 0) === 0) return itemBaseScore[itemIdx];

  const base = itemIdx * 15;
  let closers = 0;
  let cover = 0;
  let gain = 0;
  for (let r = 0; r < nReqs; r++) {
    if ((deficitMask & (1 << r)) === 0) continue;
    const si = reqs[r * 2];
    const deficit = reqs[r * 2 + 1] - total[si];
    if (deficit <= 0) continue;
    const value = itemFlat[base + si];
    if (value <= 0) continue;
    cover++;
    gain += value < deficit ? value : deficit;
    if (value >= deficit) closers++;
  }

  let ecoPenalty = 0;
  if (ecoMode && availArr && availArr[itemIdx] > 0) ecoPenalty = 1 / availArr[itemIdx];
  return closers * 1e9 + cover * 1e6 + gain * 1e3 + itemBaseScore[itemIdx] - ecoPenalty;
}

function orderFirstItems(firstItems, itemFlat, reqs, nReqs, itemBaseScore) {
  const zeroTotal = new Float64Array(15);
  let deficitMask = 0;
  for (let r = 0; r < nReqs; r++) deficitMask |= (1 << r);

  return Array.from(firstItems).sort((a, b) => {
    const diff = scoreItemForDeficits(itemFlat, reqs, nReqs, zeroTotal, b, deficitMask, itemBaseScore)
      - scoreItemForDeficits(itemFlat, reqs, nReqs, zeroTotal, a, deficitMask, itemBaseScore);
    return diff || (a - b);
  });
}

function seedGreedySolutions(firstItems, itemFlat, nItems, reqs, nReqs,
                             humanSparse, humanOffsets, nHumans,
                             state, maxCounts, itemReqMask, itemBaseScore, maxSearchDepth) {
  if (!firstItems.length) return;

  const maxSeedStarts = Math.min(firstItems.length, 24);
  const chosen = new Int32Array(maxSearchDepth);
  const total = new Float64Array(15);
  const used = new Int32Array(nItems);

  for (let startIdx = 0; startIdx < maxSeedStarts; startIdx++) {
    if (shouldStop || performance.now() > state.deadline) return;

    const first = firstItems[startIdx];
    if (maxCounts[first] <= 0) continue;

    total.fill(0);
    used.fill(0);
    chosen[0] = first;
    used[first] = 1;
    const firstBase = first * 15;
    for (let s = 0; s < 15; s++) total[s] = itemFlat[firstBase + s];

    let chosenLen = 1;
    let minI = first;

    while (chosenLen <= maxSearchDepth) {
      let deficitMask = 0;
      let satisfied = true;
      for (let r = 0; r < nReqs; r++) {
        if (total[reqs[r * 2]] < reqs[r * 2 + 1]) {
          satisfied = false;
          deficitMask |= (1 << r);
        }
      }

      if (satisfied) {
        considerSolution(chosen, chosenLen, total, state, humanSparse, humanOffsets, nHumans, false);
        break;
      }

      if (chosenLen >= maxSearchDepth) break;

      let bestItem = -1;
      let bestScore = -Infinity;
      for (let i = minI; i < nItems; i++) {
        if (used[i] >= maxCounts[i]) continue;
        if ((itemReqMask[i] & deficitMask) === 0) continue;
        const score = scoreItemForDeficits(itemFlat, reqs, nReqs, total, i, deficitMask, itemBaseScore);
        if (score > bestScore) {
          bestScore = score;
          bestItem = i;
        }
      }

      if (bestItem < 0) break;

      const base = bestItem * 15;
      chosen[chosenLen] = bestItem;
      used[bestItem]++;
      for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];
      minI = bestItem;
      chosenLen++;
    }
  }
}

// Core DFS — tight inner loop, optimized for V8 JIT
// itemFlat: Float64Array[nItems*15], reqs: Float64Array[nReqs*2] as [si,val,si,val,...]
// suffMax: Float64Array[nItems*nReqs] — suffMax[i*nReqs+r] = max single-item value for req r among items[i..end]
// suffJoint: Uint8Array[nItems*nReqs*nReqs] — suffJoint[i*nReqs*nReqs+r1*nReqs+r2] = 1 if any item j>=i covers both req r1 and r2
function dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d, minI,
             bps, humanSparse, humanOffsets, nHumans, state, maxCounts, used, suffMax, suffJoint, itemReqMask, parentDeficitMask) {
  state.nodes++;

  // Periodic checks (every ~131K nodes via bitmask)
  if ((state.nodes & 0x1FFFF) === 0) {
    if (shouldStop) return;
    if (performance.now() > state.deadline) { shouldStop = true; return; }
    // Send progress every ~524K nodes
    if ((state.nodes & 0x7FFFF) === 0) {
      self.postMessage({
        type: 'progress',
        nodes: state.nodes,
        bestCollateral: state.bestColl,
        bestItems: state.bestLen,
      });
    }
  }

  const remaining = maxD - d;

  // Lower-bound pruning on target deficits (>=: need total >= req)
  for (let r = 0; r < nReqs; r++) {
    const si = reqs[r * 2];
    const deficit = reqs[r * 2 + 1] - total[si];
    if (deficit > 0) {
      if (Math.ceil(deficit / bps[si]) > remaining) return;
    }
  }

  // Suffix-max pruning: can remaining items even close each deficit?
  if (minI < nItems) {
    const suffOff = minI * nReqs;
    for (let r = 0; r < nReqs; r++) {
      const si = reqs[r * 2];
      const deficit = reqs[r * 2 + 1] - total[si];
      if (deficit > 0 && suffMax[suffOff + r] * remaining < deficit) return;
    }

    // Pairwise additive lower-bound: if no remaining item covers both req r1 and r2
    // simultaneously, their item-count lower bounds are additive (not max).
    if (nReqs > 1) {
      const suffJOff = minI * nReqs * nReqs;
      for (let r1 = 0; r1 < nReqs - 1; r1++) {
        const si1 = reqs[r1 * 2];
        const d1 = reqs[r1 * 2 + 1] - total[si1];
        if (d1 <= 0) continue;
        const lb1 = Math.ceil(d1 / bps[si1]);
        for (let r2 = r1 + 1; r2 < nReqs; r2++) {
          const si2 = reqs[r2 * 2];
          const d2 = reqs[r2 * 2 + 1] - total[si2];
          if (d2 <= 0) continue;
          if (!suffJoint[suffJOff + r1 * nReqs + r2]) {
            // No remaining item covers both — lower bounds add instead of max
            if (lb1 + Math.ceil(d2 / bps[si2]) > remaining) return;
          }
        }
      }
    }
  }

  // Collateral lower-bound: adding items can only increase stats, so a partial
  // state that already matches >= bestColl professions cannot lead to improvement.
  if (state.bestColl < Infinity) {
    if (wasmReady) {
      // wasm counts with early-exit at the incumbent; >= means no improvement possible.
      if (wasmCount(total, state.bestColl) >= state.bestColl) return;
    } else {
      let nc = 0;
      outer: for (let h = 0; h < nHumans; h++) {
        const start = humanOffsets[h], end = humanOffsets[h + 1];
        for (let k = start; k < end; k += 2) {
          if (total[humanSparse[k]] < humanSparse[k + 1]) continue outer;
        }
        if (++nc >= state.bestColl) return;
      }
    }
  }

  // Check if target is satisfied (>=: total must meet or exceed req)
  let satisfied = true;
  for (let r = 0; r < nReqs; r++) {
    if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { satisfied = false; break; }
  }

  if (satisfied) {
    considerSolution(chosen, d, total, state, humanSparse, humanOffsets, nHumans, true);
    if (state.perfect) return;
  }

  if (d >= maxD || state.perfect || shouldStop) return;

  for (let i = minI; i < nItems; i++) {
    if (state.perfect || shouldStop) return;
    if (used[i] >= maxCounts[i]) continue;

    // Skip items that don't help with any remaining deficit (bitmask check)
    if ((itemReqMask[i] & parentDeficitMask) === 0) continue;

    const base = i * 15;
    chosen[d] = i;
    used[i]++;
    for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];

    // Compute child deficit mask: only check bits that were unsatisfied
    let childMask = 0;
    for (let r = 0; r < nReqs; r++) {
      if ((parentDeficitMask & (1 << r)) && total[reqs[r * 2]] < reqs[r * 2 + 1]) {
        childMask |= (1 << r);
      }
    }

    dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d + 1, i,
    bps, humanSparse, humanOffsets, nHumans, state, maxCounts, used, suffMax, suffJoint, itemReqMask, childMask);

    for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
    used[i]--;
  }
}

function solve(data) {
  const { items, humans, targetReqs, bestPerStat, inherentCount,
          firstItems, initialLb, maxSearchDepth, maxCounts, timeoutSec } = data;
  ecoMode = data.ecoMode || false;
  availArr = data.availability || null;

  const nItems = items.length;
  const nHumans = humans.length;
  const nReqs = targetReqs.length;

  // Flatten items into contiguous Float64Array for cache-friendly access
  const itemFlat = new Float64Array(nItems * 15);
  for (let i = 0; i < nItems; i++)
    for (let s = 0; s < 15; s++)
      itemFlat[i * 15 + s] = items[i][s];

  // Flatten humans
  const humanFlat = new Float64Array(nHumans * 15);
  for (let h = 0; h < nHumans; h++)
    for (let s = 0; s < 15; s++)
      humanFlat[h * 15 + s] = humans[h][s];

  // Build sparse human representation: only store non-zero stat requirements
  // humanSparse: [statIdx, value, statIdx, value, ...] for all humans concatenated
  // humanOffsets: start offset into humanSparse for each human (length nHumans+1)
  let sparseLen = 0;
  for (let h = 0; h < nHumans; h++)
    for (let s = 0; s < 15; s++)
      if (humanFlat[h * 15 + s] > 0) sparseLen++;
  const humanSparse = new Float64Array(sparseLen * 2);
  const humanOffsets = new Int32Array(nHumans + 1);
  let sparseIdx = 0;
  for (let h = 0; h < nHumans; h++) {
    humanOffsets[h] = sparseIdx;
    const base = h * 15;
    for (let s = 0; s < 15; s++) {
      if (humanFlat[base + s] > 0) {
        humanSparse[sparseIdx] = s;
        humanSparse[sparseIdx + 1] = humanFlat[base + s];
        sparseIdx += 2;
      }
    }
  }
  humanOffsets[nHumans] = sparseIdx;

  // Load the static human data into the wasm kernel once for this solve. If this
  // returns false (no wasm, or dataset too large for the kernel's memory), every
  // countValid/collateral check transparently uses the JS path instead.
  wasmLoadHumans(humanSparse, humanOffsets, nHumans);

  // Flatten requirements: [si0, val0, si1, val1, ...]
  const reqs = new Float64Array(nReqs * 2);
  for (let r = 0; r < nReqs; r++) {
    reqs[r * 2] = targetReqs[r][0];
    reqs[r * 2 + 1] = targetReqs[r][1];
  }

  const bps = new Float64Array(bestPerStat);
  const mc = new Int32Array(maxCounts);

  // Suffix-max array: for each starting item i, the max contribution per requirement
  // among items[i..nItems-1]. Used for pruning branches where remaining items
  // can't possibly close the deficit.
  const suffMax = new Float64Array(nItems * nReqs);
  for (let r = 0; r < nReqs; r++) {
    const si = reqs[r * 2];
    let mx = 0;
    for (let i = nItems - 1; i >= 0; i--) {
      const v = itemFlat[i * 15 + si];
      if (v > mx) mx = v;
      suffMax[i * nReqs + r] = mx;
    }
  }

  // Pairwise joint suffix: suffJoint[i*nReqs*nReqs + r1*nReqs + r2] = 1 if any
  // item j >= i contributes to BOTH req r1 and req r2 simultaneously.
  // Enables the additive lower-bound pruning in dfs().
  const suffJoint = new Uint8Array(nItems * nReqs * nReqs);
  for (let r1 = 0; r1 < nReqs; r1++) {
    const s1 = reqs[r1 * 2];
    for (let r2 = 0; r2 < nReqs; r2++) {
      const s2 = reqs[r2 * 2];
      let joint = false;
      for (let i = nItems - 1; i >= 0; i--) {
        if (itemFlat[i * 15 + s1] > 0 && itemFlat[i * 15 + s2] > 0) joint = true;
        suffJoint[i * nReqs * nReqs + r1 * nReqs + r2] = joint ? 1 : 0;
      }
    }
  }

  // Precompute per-item requirement contribution bitmask.
  // Bit r is set if item i contributes (>0) to the stat targeted by requirement r.
  // Used for O(1) relevance check in dfs() instead of O(nReqs) loop.
  const itemReqMask = new Int32Array(nItems);
  const itemBaseScore = new Float64Array(nItems);
  for (let i = 0; i < nItems; i++) {
    let mask = 0;
    let reqGain = 0;
    let extraGain = 0;
    for (let r = 0; r < nReqs; r++) {
      const value = itemFlat[i * 15 + reqs[r * 2]];
      if (value > 0) {
        mask |= (1 << r);
        reqGain += value;
      }
    }
    for (let s = 0; s < 15; s++) {
      let isReqStat = false;
      for (let r = 0; r < nReqs; r++) {
        if (reqs[r * 2] === s) {
          isReqStat = true;
          break;
        }
      }
      if (!isReqStat && itemFlat[i * 15 + s] > 0) extraGain += itemFlat[i * 15 + s];
    }
    itemReqMask[i] = mask;
    itemBaseScore[i] = reqGain / (1 + extraGain);
  }

  const orderedFirstItems = orderFirstItems(firstItems, itemFlat, reqs, nReqs, itemBaseScore);

  // Dense target requirement vector (reqVec[s] = target's requirement for stat s,
  // 0 if it needs none). Used to score overshoot — the secondary objective.
  const targetReqVec = new Float64Array(15);
  for (let r = 0; r < nReqs; r++) targetReqVec[reqs[r * 2]] = reqs[r * 2 + 1];

  const state = {
    nodes: 0,
    bestColl: Infinity,
    bestOver: Infinity,
    bestLen: Infinity,
    bestCost: Infinity,
    bestSol: null,
    perfect: false,
    provenPerfect: false,
    inherentCount,
    reqVec: targetReqVec,
    deadline: performance.now() + timeoutSec * 1000,
  };

  // Async iterative deepening — yields to event loop between first-item DFS
  // runs so that pause/stop messages can be processed via onmessage

  // Strengthen the starting lower bound with the LP relaxation (admissible).
  // max() keeps it no weaker than the per-stat bound computed in app.js.
  const lpLb = computeLpLowerBound(itemFlat, nItems, reqs, nReqs, mc);
  let curDepth = Math.max(initialLb, lpLb, 1);

  // ── Anytime LNS (Large Neighborhood Search) incumbent improver ──
  // Runs interleaved with the exact search. It only ever *records* a solution
  // through considerSolution(..., allowPerfectStop=false), which accepts a
  // candidate solely when it is strictly better than the best so far. It can
  // therefore never reduce result quality, and it never sets perfect/exhaustive
  // (those remain owned by the exact search). It respects maxCounts and the
  // maxSearchDepth item cap, so it cannot return out-of-bounds solutions.
  const lnsCnt = new Int32Array(nItems);     // current working solution (counts)
  const lnsTotal = new Float64Array(15);
  const wCnt = new Int32Array(nItems);       // candidate scratch
  const wTotal = new Float64Array(15);
  let lnsHasCur = false;
  let lnsCurColl = Infinity, lnsCurOver = Infinity, lnsCurLen = Infinity, lnsCurCost = Infinity;
  let lnsSinceImprove = 0;

  // Per-worker xorshift RNG (seeded from its first item so workers diverge).
  let rngState = (((firstItems && firstItems.length ? firstItems[0] : 0) + 1) * 2654435761) >>> 0;
  rngState = (rngState ^ 0x9e3779b9) >>> 0;
  function rnd() {
    rngState ^= rngState << 13; rngState >>>= 0;
    rngState ^= rngState >> 17;
    rngState ^= rngState << 5; rngState >>>= 0;
    return rngState / 4294967296;
  }
  function rndInt(n) { return (rnd() * n) | 0; }

  function lnsSum(cnt) { let s = 0; for (let i = 0; i < nItems; i++) s += cnt[i]; return s; }
  function lnsCost(cnt) {
    if (!availArr) return 0;
    let c = 0;
    for (let i = 0; i < nItems; i++) if (cnt[i] > 0 && availArr[i] > 0) c += cnt[i] / availArr[i];
    return c;
  }
  function lnsFeasible(total) {
    for (let r = 0; r < nReqs; r++) if (total[reqs[r * 2]] < reqs[r * 2 + 1]) return false;
    return true;
  }
  // Greedily add items until feasible. Respects maxCounts and the maxSearchDepth
  // item cap. Returns true only if a feasible solution within the cap is reached.
  function lnsRepairFast(cnt, total) {
    let count = lnsSum(cnt);
    let guard = 0;
    while (guard++ < 100000) {
      let deficitMask = 0, sat = true;
      for (let r = 0; r < nReqs; r++) {
        if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { sat = false; deficitMask |= (1 << r); }
      }
      if (sat) return true;
      if (count >= maxSearchDepth) return false;
      let bestItem = -1, bestScore = -Infinity;
      for (let i = 0; i < nItems; i++) {
        if (cnt[i] >= mc[i]) continue;
        if ((itemReqMask[i] & deficitMask) === 0) continue;
        const score = scoreItemForDeficits(itemFlat, reqs, nReqs, total, i, deficitMask, itemBaseScore);
        if (score > bestScore) { bestScore = score; bestItem = i; }
      }
      if (bestItem < 0) return false;
      cnt[bestItem]++;
      count++;
      const base = bestItem * 15;
      for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];
    }
    return false;
  }
  // Collateral-aware repair: at each step pick the deficit-closing item that
  // results in the FEWEST matched professions (lowest collateral), breaking ties
  // by deficit progress. This is what actually lets LNS reduce collateral instead
  // of just reaching feasibility. More expensive (O(items*humans) per step) so it
  // is used for the active local search, with the fast variant kept for cold
  // starts. A small epsilon of randomness diversifies the reconstruction.
  function lnsRepair(cnt, total) {
    let count = lnsSum(cnt);
    let guard = 0;
    while (guard++ < 100000) {
      let deficitMask = 0, sat = true;
      for (let r = 0; r < nReqs; r++) {
        if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { sat = false; deficitMask |= (1 << r); }
      }
      if (sat) return true;
      if (count >= maxSearchDepth) return false;

      let bestItem = -1, bestColl = Infinity, bestOver = Infinity, bestGain = -1;
      for (let i = 0; i < nItems; i++) {
        if (cnt[i] >= mc[i]) continue;
        if ((itemReqMask[i] & deficitMask) === 0) continue;
        const base = i * 15;
        // Deficit progress this item provides.
        let gain = 0;
        for (let r = 0; r < nReqs; r++) {
          if ((deficitMask & (1 << r)) === 0) continue;
          const si = reqs[r * 2];
          const deficit = reqs[r * 2 + 1] - total[si];
          if (deficit <= 0) continue;
          const v = itemFlat[base + si];
          gain += v < deficit ? v : deficit;
        }
        if (gain <= 0) continue;
        // Collateral and overshoot if this item is added.
        for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];
        const coll = countValid(total, humanSparse, humanOffsets, nHumans);
        let over = 0;
        for (let s = 0; s < 15; s++) { const ex = total[s] - targetReqVec[s]; if (ex > 0) over += ex; }
        for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
        // Prefer the lowest collateral, then the least overshoot (closest exact fit),
        // then the most deficit progress.
        if (coll < bestColl
            || (coll === bestColl && (over < bestOver
            || (over === bestOver && gain > bestGain)))) {
          bestColl = coll; bestOver = over; bestGain = gain; bestItem = i;
        }
      }
      if (bestItem < 0) return false;
      cnt[bestItem]++;
      count++;
      const base = bestItem * 15;
      for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];
    }
    return false;
  }
  function lnsRecomputeTotal(cnt, total) {
    total.fill(0);
    for (let i = 0; i < nItems; i++) {
      if (cnt[i] <= 0) continue;
      const base = i * 15;
      for (let s = 0; s < 15; s++) total[s] += cnt[i] * itemFlat[base + s];
    }
  }
  // Seed the working solution from the global incumbent (state.bestSol).
  function lnsInitFromBest() {
    if (!state.bestSol) return false;
    lnsCnt.fill(0);
    const its = state.bestSol.items;
    for (let k = 0; k < its.length; k++) lnsCnt[its[k]]++;
    lnsRecomputeTotal(lnsCnt, lnsTotal);
    lnsCurLen = its.length;
    lnsCurColl = state.bestSol.collateral;
    lnsCurOver = state.bestSol.overshoot != null ? state.bestSol.overshoot : computeOvershoot(lnsTotal, targetReqVec);
    lnsCurCost = state.bestSol.resourceCost || 0;
    lnsHasCur = true;
    return true;
  }
  // Build a randomized greedy feasible solution (diversification / cold start).
  function lnsRandomStart() {
    lnsCnt.fill(0);
    lnsTotal.fill(0);
    let seed = -1;
    for (let t = 0; t < 24; t++) {
      const cand = rndInt(nItems);
      if (mc[cand] > 0 && itemReqMask[cand] !== 0) { seed = cand; break; }
    }
    if (seed >= 0) {
      lnsCnt[seed] = 1;
      const base = seed * 15;
      for (let s = 0; s < 15; s++) lnsTotal[s] += itemFlat[base + s];
    }
    if (!lnsRepairFast(lnsCnt, lnsTotal)) return false;
    lnsCurLen = lnsSum(lnsCnt);
    lnsCurColl = countValid(lnsTotal, humanSparse, humanOffsets, nHumans);
    lnsCurOver = computeOvershoot(lnsTotal, targetReqVec);
    lnsCurCost = lnsCost(lnsCnt);
    lnsHasCur = true;
    return true;
  }
  // Destroy operator: with high probability, try to "block" a currently matched
  // profession by reducing one of its stats below requirement (targeted ruin);
  // otherwise remove a few random item instances. Repair re-adds minimally.
  function lnsDestroy(cnt, total) {
    const totalItems = lnsSum(cnt);
    if (totalItems === 0) return;
    if (rnd() < 0.6) {
      for (let tries = 0; tries < 8; tries++) {
        const h = rndInt(nHumans);
        const start = humanOffsets[h], end = humanOffsets[h + 1];
        if (start === end) continue;
        let matched = true;
        for (let k = start; k < end; k += 2) {
          if (total[humanSparse[k]] < humanSparse[k + 1]) { matched = false; break; }
        }
        if (!matched) continue;
        const nPairs = (end - start) >> 1;
        const pick = start + rndInt(nPairs) * 2;
        const si = humanSparse[pick];
        const need = humanSparse[pick + 1];
        let safety = 0;
        while (total[si] >= need && safety++ < 1000) {
          let pickItem = -1, pickVal = 0;
          for (let i = 0; i < nItems; i++) {
            if (cnt[i] <= 0) continue;
            const v = itemFlat[i * 15 + si];
            if (v > pickVal) { pickVal = v; pickItem = i; }
          }
          if (pickItem < 0) break;
          cnt[pickItem]--;
          const base = pickItem * 15;
          for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
        }
        return;
      }
    }
    const k = 1 + rndInt(Math.min(3, totalItems));
    for (let j = 0; j < k; j++) {
      const sum = lnsSum(cnt);
      if (sum <= 0) break;
      let r = rndInt(sum);
      let pickItem = -1;
      for (let i = 0; i < nItems; i++) {
        if (cnt[i] > 0) { if (r < cnt[i]) { pickItem = i; break; } r -= cnt[i]; }
      }
      if (pickItem < 0) break;
      cnt[pickItem]--;
      const base = pickItem * 15;
      for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
    }
  }
  function lnsMaterialize(cnt, len) {
    const seq = new Int32Array(len);
    let p = 0;
    for (let i = 0; i < nItems; i++) for (let c = 0; c < cnt[i]; c++) seq[p++] = i;
    return seq;
  }
  // Run LNS for up to budgetMs, returning early once it has clearly converged
  // (no global-incumbent improvement for a long run of iterations). Records every
  // strict improvement on the global incumbent; never sets perfect/exhaustive.
  function lnsBatch(budgetMs) {
    if (nReqs === 0) return;
    const start = performance.now();
    if (!lnsHasCur && !lnsInitFromBest() && !lnsRandomStart()) return;
    let iter = 0;
    let sinceGlobalGain = 0;
    while (true) {
      if (shouldStop) return;
      if ((iter & 15) === 0 && performance.now() - start > budgetMs) return;
      if (sinceGlobalGain > 8000) return; // converged for now
      iter++;

      wCnt.set(lnsCnt);
      wTotal.set(lnsTotal);
      lnsDestroy(wCnt, wTotal);
      if (!lnsRepair(wCnt, wTotal)) { lnsSinceImprove++; sinceGlobalGain++; }
      else if (lnsFeasible(wTotal)) {
        const len2 = lnsSum(wCnt);
        const coll2 = countValid(wTotal, humanSparse, humanOffsets, nHumans);
        const over2 = computeOvershoot(wTotal, targetReqVec);
        const cost2 = ecoMode ? lnsCost(wCnt) : 0;
        const tie2 = ecoMode ? cost2 : len2;

        // Record only if strictly better than the global incumbent, using the same
        // objective order as considerSolution: collateral, then overshoot, then cost/size.
        const betterGlobal = coll2 < state.bestColl ||
          (coll2 === state.bestColl && (over2 < state.bestOver ||
          (over2 === state.bestOver && tie2 < (ecoMode ? state.bestCost : state.bestLen))));
        if (betterGlobal) {
          const seq = lnsMaterialize(wCnt, len2);
          considerSolution(seq, len2, wTotal, state, humanSparse, humanOffsets, nHumans, false);
          sinceGlobalGain = 0;
        } else {
          sinceGlobalGain++;
        }

        // Local acceptance: keep improving-or-equal moves to walk plateaus.
        const prevColl = lnsCurColl;
        const betterLocal = coll2 < lnsCurColl ||
          (coll2 === lnsCurColl && (over2 < lnsCurOver ||
          (over2 === lnsCurOver && tie2 <= (ecoMode ? lnsCurCost : lnsCurLen))));
        if (betterLocal) {
          lnsCnt.set(wCnt);
          lnsTotal.set(wTotal);
          lnsCurColl = coll2; lnsCurOver = over2; lnsCurLen = len2; lnsCurCost = cost2;
          lnsSinceImprove = coll2 < prevColl ? 0 : lnsSinceImprove + 1;
        } else {
          lnsSinceImprove++;
        }
      } else {
        lnsSinceImprove++;
        sinceGlobalGain++;
      }

      // Diversify when stuck: alternate re-basing on the incumbent and restarting.
      if (lnsSinceImprove > 40) {
        lnsSinceImprove = 0;
        if ((iter & 1) && lnsInitFromBest()) { /* re-based on best */ }
        else if (!lnsRandomStart() && !lnsInitFromBest()) return;
      }
    }
  }

  let fi = 0;
  let seeded = false;
  let lnsFirstPass = true;

  function processNext() {
    // The LP lower bound proves no feasible solution fits within the item cap.
    if (curDepth > maxSearchDepth) {
      self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: true });
      return;
    }
    if (!seeded) {
      seeded = true;
      seedGreedySolutions(
        orderedFirstItems,
        itemFlat,
        nItems,
        reqs,
        nReqs,
        humanSparse,
        humanOffsets,
        nHumans,
        state,
        mc,
        itemReqMask,
        itemBaseScore,
        maxSearchDepth
      );
    }

    // Anytime improver: give LNS a slice of CPU each tick. It can only raise the
    // incumbent quality (strict-improvement only) and never affects the exact
    // search's correctness flags. The first tick gets a larger, convergence-gated
    // budget (LNS returns early once it stops improving); later ticks get small
    // slices since the exact DFS dominates the thread on hard instances.
    if (!shouldPause) lnsBatch(lnsFirstPass ? 600 : 6);
    lnsFirstPass = false;

    const tickDeadline = performance.now() + 50;
    let chosen = new Int32Array(curDepth);
    const total = new Float64Array(15);
    const used = new Int32Array(nItems);
    let lastDepth = curDepth;

    while (true) {
      if (shouldStop || state.perfect) {
        self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
        return;
      }

      if (shouldPause) {
        state.deadline += 100;
        setTimeout(processNext, 100);
        return;
      }

      if (performance.now() > state.deadline) {
        self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
        return;
      }

      if (state.provenPerfect) {
        self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
        return;
      }

      if (fi >= orderedFirstItems.length) {
        if (orderedFirstItems.length === 0) {
          self.postMessage({ type: 'done', solution: null, nodes: state.nodes, exhaustive: true });
          return;
        }
        self.postMessage({
          type: 'depthDone',
          depth: curDepth,
          nodes: state.nodes,
          bestCollateral: state.bestColl === Infinity ? 0 : state.bestColl,
          bestItems: state.bestLen === Infinity ? 0 : state.bestLen,
        });
        curDepth++;
        fi = 0;
        if (curDepth > maxSearchDepth) {
          self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: true });
          return;
        }
        if (curDepth !== lastDepth) {
          chosen = new Int32Array(curDepth);
          lastDepth = curDepth;
        }
      }

      const first = orderedFirstItems[fi];
      if (mc[first] === 0) { fi++; continue; }

      total.fill(0);
      chosen[0] = first;
      for (let s = 0; s < 15; s++) total[s] = itemFlat[first * 15 + s];
      used[first] = 1;

      let sat = true;
      for (let r = 0; r < nReqs; r++) {
        if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { sat = false; break; }
      }
      if (sat) {
        considerSolution(chosen, 1, total, state, humanSparse, humanOffsets, nHumans, true);
      }

      if (curDepth > 1 && !state.perfect && !shouldStop) {
        let initMask = 0;
        for (let r = 0; r < nReqs; r++) {
          if (total[reqs[r * 2]] < reqs[r * 2 + 1]) initMask |= (1 << r);
        }
        dfs(itemFlat, nItems, chosen, total, reqs, nReqs, curDepth, 1, first,
          bps, humanSparse, humanOffsets, nHumans, state, mc, used, suffMax, suffJoint, itemReqMask, initMask);
      }

      used[first] = 0;
      fi++;

      if (performance.now() > tickDeadline) {
        setTimeout(processNext, 0);
        return;
      }
    }
  }

  setTimeout(processNext, 0);
}
