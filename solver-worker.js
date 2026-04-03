// solver-worker.js — Specificity-optimized parallel solver for Web Workers
// Ported from the Rust IDA* specificity solver

let shouldStop = false;
let shouldPause = false;
let ecoMode = false;
let availArr = null;

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
    solve(e.data);
  }
};

// Count how many professions a stat total satisfies
// humanFlat: Float64Array of nHumans*15 stats
function countValid(total, humanFlat, nHumans) {
  let count = 0;
  for (let h = 0; h < nHumans; h++) {
    let valid = true;
    const base = h * 15;
    for (let s = 0; s < 15; s++) {
      if (humanFlat[base + s] > 0 && total[s] <= humanFlat[base + s]) {
        valid = false;
        break;
      }
    }
    if (valid) count++;
  }
  return count;
}

function computeResourceCost(chosen, avail) {
  if (!avail) return 0;
  const counts = new Int32Array(avail.length);
  for (let i = 0; i < chosen.length; i++) counts[chosen[i]]++;
  let cost = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0 && avail[i] > 0) cost += counts[i] / avail[i];
  }
  return cost;
}

// Core DFS — tight inner loop, optimized for V8 JIT
// itemFlat: Float64Array[nItems*15], reqs: Float64Array[nReqs*2] as [si,val,si,val,...]
// suffMax: Float64Array[nItems*nReqs] — suffMax[i*nReqs+r] = max single-item value for req r among items[i..end]
function dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d, minI,
             bps, humanFlat, nHumans, state, maxCounts, used, suffMax) {
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

  // Lower-bound pruning on target deficits (strict >: need total > req, i.e. total >= req+1)
  for (let r = 0; r < nReqs; r++) {
    const si = reqs[r * 2];
    const deficit = reqs[r * 2 + 1] + 1 - total[si];
    if (deficit > 0) {
      if (Math.ceil(deficit / bps[si]) > remaining) return;
    }
  }

  // Suffix-max pruning: can remaining items even close each deficit?
  if (minI < nItems) {
    const suffOff = minI * nReqs;
    for (let r = 0; r < nReqs; r++) {
      const si = reqs[r * 2];
      const deficit = reqs[r * 2 + 1] + 1 - total[si];
      if (deficit > 0 && suffMax[suffOff + r] * remaining < deficit) return;
    }
  }

  // Check if target is satisfied (strict >: total must exceed req)
  let satisfied = true;
  for (let r = 0; r < nReqs; r++) {
    if (total[reqs[r * 2]] <= reqs[r * 2 + 1]) { satisfied = false; break; }
  }

  if (satisfied) {
    const coll = countValid(total, humanFlat, nHumans);
    const resCost = computeResourceCost(chosen, availArr);
    if (coll < state.bestColl || (coll === state.bestColl && (ecoMode
        ? resCost < state.bestCost : chosen.length < state.bestLen))) {
      state.bestColl = coll;
      state.bestLen = chosen.length;
      state.bestCost = resCost;
      state.bestSol = { items: chosen.slice(), total: Array.from(total), collateral: coll, resourceCost: resCost };
      self.postMessage({ type: 'newBest', solution: state.bestSol, nodes: state.nodes });
      if (coll <= state.inherentCount && !ecoMode) { state.perfect = true; return; }
    }
  }

  if (d >= maxD || state.perfect || shouldStop) return;

  for (let i = minI; i < nItems; i++) {
    if (state.perfect || shouldStop) return;
    if (used[i] >= maxCounts[i]) continue;

    // Skip items that don't help with any remaining deficit (strict >)
    const base = i * 15;
    let helps = false;
    for (let r = 0; r < nReqs; r++) {
      const si = reqs[r * 2];
      if (total[si] <= reqs[r * 2 + 1] && itemFlat[base + si] > 0) { helps = true; break; }
    }
    if (!helps) continue;

    chosen.push(i);
    used[i]++;
    for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];

    dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d + 1, i,
        bps, humanFlat, nHumans, state, maxCounts, used, suffMax);

    for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
    used[i]--;
    chosen.pop();
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

  const state = {
    nodes: 0,
    bestColl: Infinity,
    bestLen: Infinity,
    bestCost: Infinity,
    bestSol: null,
    perfect: false,
    inherentCount,
    deadline: performance.now() + timeoutSec * 1000,
  };

  // Async iterative deepening — yields to event loop between first-item DFS
  // runs so that pause/stop messages can be processed via onmessage
  let curDepth = initialLb;
  let fi = 0;

  function processNext() {
    if (shouldStop || state.perfect) {
      self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
      return;
    }

    // Handle pause: defer and retry so the event loop can process messages
    if (shouldPause) {
      state.deadline += 100;
      setTimeout(processNext, 100);
      return;
    }

    if (performance.now() > state.deadline) {
      self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
      return;
    }

    if (state.bestColl <= inherentCount && state.bestColl !== Infinity && !ecoMode) {
      self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes, exhaustive: false });
      return;
    }

    // All first items done for this depth level — advance
    if (fi >= firstItems.length) {
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
    }

    // Process one first item at the current depth
    const first = firstItems[fi];
    const chosen = [first];
    const total = new Float64Array(15);
    const used = new Int32Array(nItems);
    for (let s = 0; s < 15; s++) total[s] = itemFlat[first * 15 + s];
    used[first] = 1;

    // Check single-item solution (strict >)
    let sat = true;
    for (let r = 0; r < nReqs; r++) {
      if (total[reqs[r * 2]] <= reqs[r * 2 + 1]) { sat = false; break; }
    }
    if (sat) {
      const coll = countValid(total, humanFlat, nHumans);
      const resCost = computeResourceCost([first], availArr);
      if (coll < state.bestColl || (coll === state.bestColl && (ecoMode
          ? resCost < state.bestCost : 1 < state.bestLen))) {
        state.bestColl = coll;
        state.bestLen = 1;
        state.bestCost = resCost;
        state.bestSol = { items: [first], total: Array.from(total), collateral: coll, resourceCost: resCost };
        self.postMessage({ type: 'newBest', solution: state.bestSol, nodes: state.nodes });
        if (coll <= inherentCount && !ecoMode) { state.perfect = true; }
      }
    }

    if (curDepth > 1 && !state.perfect && !shouldStop) {
      dfs(itemFlat, nItems, chosen, total, reqs, nReqs, curDepth, 1, first,
          bps, humanFlat, nHumans, state, mc, used, suffMax);
    }

    fi++;

    // Yield to event loop so pause/stop messages can be processed
    setTimeout(processNext, 0);
  }

  processNext();
}
