// solver-worker.js — Specificity-optimized parallel solver for Web Workers
// Ported from the Rust IDA* specificity solver

let shouldStop = false;
let shouldPause = false;

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
      if (humanFlat[base + s] > 0 && total[s] < humanFlat[base + s]) {
        valid = false;
        break;
      }
    }
    if (valid) count++;
  }
  return count;
}

// Core DFS — tight inner loop, optimized for V8 JIT
// itemFlat: Float64Array[nItems*15], reqs: Float64Array[nReqs*2] as [si,val,si,val,...]
function dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d, minI,
             bps, humanFlat, nHumans, state, maxCounts, used) {
  state.nodes++;

  // Periodic checks (every ~131K nodes via bitmask)
  if ((state.nodes & 0x1FFFF) === 0) {
    if (shouldStop) return;
    if (performance.now() > state.deadline) { shouldStop = true; return; }
    // Spin-wait while paused (check every 50ms)
    while (shouldPause && !shouldStop) {
      const pauseStart = performance.now();
      // Busy-wait for a short period (workers can't use setTimeout)
      while (performance.now() - pauseStart < 50) { /* spin */ }
      // Extend deadline by pause duration
      state.deadline += 50;
    }
    if (shouldStop) return;
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

  // Lower-bound pruning on target deficits
  for (let r = 0; r < nReqs; r++) {
    const si = reqs[r * 2];
    const deficit = reqs[r * 2 + 1] - total[si];
    if (deficit > 0) {
      if (Math.ceil(deficit / bps[si]) > remaining) return;
    }
  }

  // Check if target is satisfied
  let satisfied = true;
  for (let r = 0; r < nReqs; r++) {
    if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { satisfied = false; break; }
  }

  if (satisfied) {
    const coll = countValid(total, humanFlat, nHumans);
    if (coll < state.bestColl || (coll === state.bestColl && chosen.length < state.bestLen)) {
      state.bestColl = coll;
      state.bestLen = chosen.length;
      state.bestSol = { items: chosen.slice(), total: Array.from(total), collateral: coll };
      self.postMessage({ type: 'newBest', solution: state.bestSol, nodes: state.nodes });
      if (coll <= state.inherentCount) { state.perfect = true; return; }
    }
  }

  if (d >= maxD || state.perfect || shouldStop) return;

  for (let i = minI; i < nItems; i++) {
    if (state.perfect || shouldStop) return;
    if (used[i] >= maxCounts[i]) continue;

    // Skip items that don't help with any remaining deficit
    const base = i * 15;
    let helps = false;
    for (let r = 0; r < nReqs; r++) {
      const si = reqs[r * 2];
      if (total[si] < reqs[r * 2 + 1] && itemFlat[base + si] > 0) { helps = true; break; }
    }
    if (!helps) continue;

    chosen.push(i);
    used[i]++;
    for (let s = 0; s < 15; s++) total[s] += itemFlat[base + s];

    dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, d + 1, i,
        bps, humanFlat, nHumans, state, maxCounts, used);

    for (let s = 0; s < 15; s++) total[s] -= itemFlat[base + s];
    used[i]--;
    chosen.pop();
  }
}

function solve(data) {
  const { items, humans, targetReqs, bestPerStat, inherentCount,
          firstItems, initialLb, maxSearchDepth, maxCounts, timeoutSec } = data;

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

  const state = {
    nodes: 0,
    bestColl: Infinity,
    bestLen: Infinity,
    bestSol: null,
    perfect: false,
    inherentCount,
    deadline: performance.now() + timeoutSec * 1000,
  };

  // Iterative deepening from lower bound
  for (let maxD = initialLb; maxD <= maxSearchDepth; maxD++) {
    if (shouldStop || state.perfect) break;
    if (performance.now() > state.deadline) break;
    if (state.bestColl <= inherentCount && state.bestColl !== Infinity) break;

    for (let fi = 0; fi < firstItems.length; fi++) {
      if (shouldStop || state.perfect) break;
      if (performance.now() > state.deadline) break;

      const first = firstItems[fi];
      const chosen = [first];
      const total = new Float64Array(15);
      const used = new Int32Array(nItems);
      for (let s = 0; s < 15; s++) total[s] = itemFlat[first * 15 + s];
      used[first] = 1;

      // Check single-item solution
      let sat = true;
      for (let r = 0; r < nReqs; r++) {
        if (total[reqs[r * 2]] < reqs[r * 2 + 1]) { sat = false; break; }
      }
      if (sat) {
        const coll = countValid(total, humanFlat, nHumans);
        if (coll < state.bestColl || (coll === state.bestColl && 1 < state.bestLen)) {
          state.bestColl = coll;
          state.bestLen = 1;
          state.bestSol = { items: [first], total: Array.from(total), collateral: coll };
          self.postMessage({ type: 'newBest', solution: state.bestSol, nodes: state.nodes });
          if (coll <= inherentCount) { state.perfect = true; break; }
        }
      }

      if (maxD > 1) {
        dfs(itemFlat, nItems, chosen, total, reqs, nReqs, maxD, 1, first,
            bps, humanFlat, nHumans, state, mc, used);
      }
    }

    self.postMessage({
      type: 'depthDone',
      depth: maxD,
      nodes: state.nodes,
      bestCollateral: state.bestColl === Infinity ? 0 : state.bestColl,
      bestItems: state.bestLen === Infinity ? 0 : state.bestLen,
    });
  }

  self.postMessage({ type: 'done', solution: state.bestSol, nodes: state.nodes });
}
