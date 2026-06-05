// bench-solver.js — Permanent solver benchmark + regression gate (headless)
//
// Drives the REAL app pipeline (data loading, payload construction, Web Worker
// search) in headless Chromium via Playwright, so it can never drift from what
// app.js actually does. For each target profession it measures:
//   - time to the first feasible solution (ms)
//   - final collateral (lower is better; inherentCount is the optimum)
//   - final item count
//   - whether the search finished exhaustively
//   - whether the inherent-only (collateral === inherentCount) optimum was hit
//
// Usage (a static server must already be running, e.g. `npx serve . -l 8080`):
//   $env:BENCH_PORT='8080'; node bench-solver.js                # measure default hard set
//   $env:BENCH_TARGETS='all'; node bench-solver.js              # measure every profession
//   $env:BENCH_TARGETS='Guardian of Humanity T4'; node bench-solver.js
//   node bench-solver.js --regression                           # enforce committed gates
//
// Env vars:
//   BENCH_PORT      static server port (default 8080)
//   BENCH_TIMEOUT   per-target solver timeout in seconds (default 8)
//   BENCH_THREADS   worker threads (default 4, for reproducibility)
//   BENCH_DEPTH     maxSearchDepth (default 30)
//   BENCH_TARGETS   'all' | 'hard' | comma-separated profession names (default 'hard')
//
// Exit code is non-zero if any regression gate fails (only in --regression mode).

const { chromium } = require('playwright');

const PORT = process.env.BENCH_PORT || 8080;
const TIMEOUT_SEC = parseInt(process.env.BENCH_TIMEOUT || '8', 10);
const THREADS = parseInt(process.env.BENCH_THREADS || '4', 10);
const DEPTH = parseInt(process.env.BENCH_DEPTH || '30', 10);
const REGRESSION = process.argv.includes('--regression');

// Curated hard set used when BENCH_TARGETS is unset or 'hard'.
const HARD_SET = [
  'Guardian of Humanity T4',
  'Quantum Engineer T4',
  'Logistics High Command T4',
  'Neural Architect T4',
  'Colonel of Humanity T4',
];

// Committed regression gates. Each target must reach `maxCollateral` (or better)
// within BENCH_TIMEOUT seconds, using BENCH_THREADS workers. Thresholds are set
// with margin above the measured result of the current solver so the gate flags
// genuine regressions without being flaky. Re-baseline intentionally when the
// solver legitimately improves.
//
// Baseline measured at BENCH_TIMEOUT=4, BENCH_THREADS=4, BENCH_DEPTH=30 (LP bound
// + collateral-aware LNS build). The other 35 professions are all solved to their
// inherent floor (collateral == inherent, the theoretical minimum) and need no
// gate. Margins are +1 over the measured collateral.
const GATES = {
  'Guardian of Humanity T4':    { maxCollateral: 17 }, // measured 16
  'Quantum Engineer T4':        { maxCollateral: 11 }, // measured 10
  'Logistics High Command T4':  { maxCollateral: 9 },  // measured 8
  'Neural Architect T4':        { maxCollateral: 7 },  // measured 6
  'Colonel of Humanity T4':     { maxCollateral: 8 },  // measured 7
};

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);

  // Wait until the app finished loading the CSV data.
  await page.waitForFunction(() => Array.isArray(window.humans ? window.humans : humans) &&
    (window.humans ? window.humans : humans).length > 0, { timeout: 30000 })
    .catch(async () => {
      // humans is a top-level `let`; reference it by bare name inside evaluate.
      await page.waitForFunction(() => typeof humans !== 'undefined' && humans.length > 0, { timeout: 30000 });
    });

  const professions = await page.evaluate(() => humans.map(h => h.profession));

  // Resolve the target list.
  let targetNames;
  const raw = (process.env.BENCH_TARGETS || 'hard').trim();
  if (raw === 'all') targetNames = professions.slice();
  else if (raw === 'hard') targetNames = HARD_SET.filter(n => professions.includes(n));
  else targetNames = raw.split(',').map(s => s.trim()).filter(Boolean);

  const missing = targetNames.filter(n => !professions.includes(n));
  if (missing.length) {
    console.error('Unknown profession(s):', missing.join(', '));
    console.error('Available:', professions.join(' | '));
    await browser.close();
    process.exit(2);
  }

  console.log(`Benchmark: ${targetNames.length} target(s), timeout=${TIMEOUT_SEC}s, threads=${THREADS}, depth=${DEPTH}`);
  console.log(pad('Profession', 32), pad('first(ms)', 10), pad('collat', 8), pad('inherent', 9),
    pad('items', 7), pad('exhaust', 8), pad('elapsed(s)', 11));
  console.log('-'.repeat(95));

  const results = [];
  for (const name of targetNames) {
    const idx = professions.indexOf(name);

    // Configure inputs and start the real solve.
    await page.evaluate(({ idx, TIMEOUT_SEC, THREADS, DEPTH }) => {
      document.getElementById('timeout-input').value = String(TIMEOUT_SEC);
      document.getElementById('threads-input').value = String(THREADS);
      document.getElementById('depth-input').value = String(DEPTH);
      const sel = document.getElementById('profession-select');
      sel.value = String(idx);
      onProfessionChange();
      window.__benchStart = performance.now();
      window.__benchFirstMs = null;
      startSolve();
    }, { idx, TIMEOUT_SEC, THREADS, DEPTH });

    // Poll for first solution and completion.
    const start = Date.now();
    const hardCap = (TIMEOUT_SEC + 20) * 1000;
    let snapshot;
    while (true) {
      snapshot = await page.evaluate(() => {
        if (window.__benchFirstMs === null && typeof globalBest !== 'undefined' && globalBest) {
          window.__benchFirstMs = performance.now() - window.__benchStart;
        }
        return {
          solving: typeof solving !== 'undefined' ? solving : false,
          firstMs: window.__benchFirstMs,
          best: (typeof globalBest !== 'undefined' && globalBest) ? {
            collateral: globalBest.collateral,
            items: globalBest.items.length,
          } : null,
          inherent: typeof inherentCount !== 'undefined' ? inherentCount : null,
          exhaustive: (typeof workersExhaustive !== 'undefined' && typeof numWorkers !== 'undefined')
            ? (workersExhaustive >= numWorkers) : false,
        };
      });
      if (!snapshot.solving) break;
      if (Date.now() - start > hardCap) break;
      await new Promise(r => setTimeout(r, 15));
    }

    const elapsed = (Date.now() - start) / 1000;
    const r = {
      name,
      firstMs: snapshot.firstMs != null ? Math.round(snapshot.firstMs) : null,
      collateral: snapshot.best ? snapshot.best.collateral : null,
      inherent: snapshot.inherent,
      items: snapshot.best ? snapshot.best.items : null,
      exhaustive: snapshot.exhaustive,
      inherentOnly: snapshot.best ? snapshot.best.collateral <= snapshot.inherent : false,
      elapsed,
    };
    results.push(r);
    console.log(
      pad(name, 32),
      pad(r.firstMs == null ? '-' : r.firstMs, 10),
      pad(r.collateral == null ? '-' : r.collateral, 8),
      pad(r.inherent == null ? '-' : r.inherent, 9),
      pad(r.items == null ? '-' : r.items, 7),
      pad(r.exhaustive ? 'yes' : 'no', 8),
      pad(r.elapsed.toFixed(1), 11),
      r.inherentOnly ? ' OPTIMAL' : '',
    );
  }

  await browser.close();

  if (consoleErrors.length) {
    console.log('\nPage console errors:');
    consoleErrors.slice(0, 10).forEach(e => console.log('  ', e));
  }

  // Regression gate.
  if (REGRESSION) {
    let failures = 0;
    console.log('\nRegression gates:');
    for (const r of results) {
      const gate = GATES[r.name];
      if (!gate) continue;
      const ok = r.collateral != null && r.collateral <= gate.maxCollateral;
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${r.name}: collateral ${r.collateral} (gate <= ${gate.maxCollateral})`);
      if (!ok) failures++;
    }
    if (Object.keys(GATES).length === 0) {
      console.log('  (no gates defined yet — run once without --regression to baseline, then populate GATES)');
    }
    if (failures > 0) {
      console.error(`\nREGRESSION: ${failures} gate(s) failed`);
      process.exit(1);
    }
    console.log('\nAll regression gates passed');
  }

  process.exit(0);
})();
