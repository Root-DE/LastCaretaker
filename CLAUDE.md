# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **build-step-free static site** (GitHub Pages, served from the root of `master`) that solves a combinatorial optimization problem for the game *The Last Caretaker*: pick foods + memories whose summed stats meet a target profession's requirements while matching as few *other* professions as possible ("collateral").

Pages serves the repo root directly, so **every committed file is live** and there is no bundler. `app.js` and the shared helper scripts are plain `<script>`s (no modules, no imports), `solver-worker.js` is a classic Web Worker, and `solver-kernel.wasm` is fetched at runtime.

## Commands

```bash
npm ci                                   # devDeps: playwright, wabt
npx playwright install chromium --with-deps

npx serve . -l 8080                      # tests and the app both need an HTTP origin
npm test                                 # == node run-tests.js; drives tests.html headlessly
                                         # honours TEST_PORT (default 8080)

npm run build:wasm                       # wasm/solver-kernel.wat -> solver-kernel.wasm

node bench-solver.js                     # solver benchmark on the curated hard set
node bench-solver.js --regression        # enforce the committed GATES table
```

Bench env vars: `BENCH_PORT`, `BENCH_TIMEOUT`, `BENCH_THREADS`, `BENCH_DEPTH`, `BENCH_TARGETS` (`all` | `hard` | comma-separated profession names).

**Running a single test:** there is no filter. `tests.html` is a flat sequence of IIFEs on a hand-rolled `assert` / `assertEqual` / `assertApprox` harness. To iterate on one area, open `http://localhost:8080/tests.html` in a browser and read the section headings, or temporarily comment out other blocks.

**Async tests must bracket themselves with `asyncBegin()` / `asyncEnd()`.** Anything that fetches a CSV or spawns a real `solver-worker.js` needs this; otherwise `#summary` — the element `run-tests.js` waits on — fires early and the run reports a false pass.

## Architecture

**Main thread — [app.js](app.js)** loads the three CSVs, renders the UI, and owns everything decided *before* the search: item filtering, item sort order, `maxCounts` clamping, eco-mode availability, and splitting first-item indices across workers. It spawns N `Worker('solver-worker.js')` and merges their results.

**Workers — [solver-worker.js](solver-worker.js)** run an async iterative-deepening DFS (IDA*-style) with LP-relaxation lower bounds, suffix-max and pairwise-joint-suffix pruning, plus an interleaved LNS incumbent improver. The DFS yields to the event loop between first-item runs so `stop` / `pause` can be handled mid-search.

**WASM kernel — [wasm/solver-kernel.wat](wasm/solver-kernel.wat)** implements `countValid` (how many professions a stat total matches), the hottest per-node operation, ~2.3× faster than the JS loop. The worker falls back to an identical JS implementation if the fetch or instantiation fails, so behaviour is the same either way.

**Shared pure logic** lives in small classic scripts loaded by both `index.html` and `tests.html`, so the suite exercises the shipped code rather than a copy:

| | |
|---|---|
| [stat-mapping.js](stat-mapping.js) | `STAT_NAMES`, the labels, and `STAT_COLUMNS` — the only place a CSV column becomes a stat index |
| [inventory-storage.js](inventory-storage.js) | the `tlc_inventory` format, its v1/v2 conversions, `newItemsSince` and `subtractFromStock` |
| [profession-model.js](profession-model.js) | `getTier`, `stripTier`, `collateralRisk` |
| [theme-mode.js](theme-mode.js) | `resolveTheme`, `readThemeMode` — **also loaded from the document head**, before the stylesheet, so the stored theme is on the root element at first paint |

Message protocol (app ⇄ worker): app sends `solve`, `stop`, `pause`, `resume`; worker sends `progress`, `newBest`, `depthDone`, `done` (with `exhaustive`).

## Invariants worth knowing before editing

- **The 15-stat vector order is a hard contract.** `STAT_NAMES` in [stat-mapping.js](stat-mapping.js) fixes indices 0–14 (weight, height, life_exp, strength, intellect, adaptability, creativity, communication, disipline, empathy, focus, leadership, logic, patience, wisdom). Items, humans, `bestPerStat`, `reqVec`, the wasm memory layout, and the duplicated copies in `tests.html` all assume it. Reordering it silently corrupts every solve.

- **CSV headers are consistent across the three files** — `Life Exp`, `Discipline`, no stray whitespace. They used to differ (`Life Exp.` in humans, and `Disipline` misspelled, which was also the internal stat key), so `statCell` accepts the old spellings as well and any CSV exported before the correction still imports — those two capitalised legacy strings are the compatibility shim, not leftovers to tidy away. Files are `;`-delimited, and a blank cell means zero. The mapping is declared as data in `STAT_COLUMNS` ([stat-mapping.js](stat-mapping.js)) — add a column there, not in a mapper.

- **Intellect reaches a human through food only.** Every food grants it; no memory does, so `memories.csv` has no such column and `memoryStats` never sets index 4. The 15-stat vector still reserves that index — food fills it.

- **The theme is resolved before the stylesheet loads.** The head script in [index.html](index.html) writes `data-theme` (the palette) and `data-theme-mode` (the chosen mode) onto `<html>`; CSS drives the switch knob's position and label from the latter. Move that work into `app.js` and the knob visibly slides in from Auto on every load.

- **Worker solutions are item *indices* into the sorted `items` array.** `startSolve` filters and re-sorts `items` by specificity, and `maxCounts` / `availability` / `firstItems` are all built against that post-sort order. Any change to filtering or sorting must keep those arrays aligned, or results decode to the wrong items.

- **Two ranking functions must agree.** `solutionRanksBetter` in [app.js:1151](app.js#L1151) and `considerSolution` in [solver-worker.js:218](solver-worker.js#L218) implement the same objective: collateral → overshoot → tie-break (eco `resourceCost` when eco mode is on, else item count). Change one, change the other.

- **Eco mode has three values** (`0` normal, `1` world eco, `2` inventory eco), each with a different `availability` denominator; mode 2 also zeroes `maxCounts` for items explicitly set to `0`. The "perfect solution → stop all workers" shortcut is disabled whenever eco mode is on, since cost is still being minimised.

- **The wasm binary is committed and CI verifies it.** After editing the `.wat`, run `npm run build:wasm` and commit the regenerated `solver-kernel.wasm`; CI recompiles and fails on `git diff --exit-code`. `.gitattributes` marks `*.wasm` binary so line-ending normalization can't corrupt it.

- **Inventory persists in `localStorage` under `tlc_inventory`, keyed by item name** ([inventory-storage.js](inventory-storage.js)). Version 1 blobs were keyed by list position; `migrateInventoryData` converts them against `LEGACY_V1_ORDER`, a frozen snapshot of the item order as it stood when those blobs were written. That snapshot is why `data/*.csv` can now be reordered or extended freely — do not update it to match new data, or every old inventory converts onto the wrong items.

- **The storage format is v3, and the point of v3 is that blanks are on record.** v1 and v2 stored only the numbers, so on read an absent name was ambiguous: either the user cleared that field (blank = unlimited for that item) or the item was added to `data/*.csv` after the save. Those need opposite defaults — a cleared field must stay blank, a new item must become `0`, since nobody owns something they have never seen. v3 writes blanks as `null`, `migrateInventoryData` returns the `known` name set, and `newItemsSince` names the difference. `known` is `null` for v1/v2 blobs and callers must not guess: `loadInventory` sets new items to `0` only when the format can actually say so, and otherwise just reports how many fields count as unlimited. **`persistInventory` therefore has to write every field, blanks included** — go back to skipping them and new items silently read as unlimited stock again.

- **In an inventory field, blank means unlimited for that item and `0` excludes it from the search entirely.** Unticking "Assume unlimited resources" seeds every blank with `0` so the user starts from "I have nothing" — but that fill must only run on a real click. The restore paths (`loadInventory`, `handleInvCSVUpload`) pass `toggleUnlimited(false)`; otherwise a deliberately blank field comes back as `0` and the item silently vanishes from every solve. Same trap in `applySolution` (use `subtractFromStock`) and in the CSV export, which writes blank as blank in both modes.

## Testing conventions

`tests.html` still **inlines copies of a few app.js helpers** (`parseCSV`, `esc`, `formatNum`, …) because `app.js` is a plain script that self-starts on `DOMContentLoaded` and cannot be imported. Editing one of those in `app.js` without mirroring it in `tests.html` produces green tests that assert nothing about the shipped code — that is not a hypothetical, it is how an intellect mapping once went missing from the shipped file while the suite stayed green.

**Prefer not to add to that pile.** New pure logic belongs in its own classic script loaded by both `index.html` and `tests.html` — the three above are the pattern. Then the tests exercise the shipped code, and `app.js` keeps only the DOM glue.

## Fonts and visual direction

[style.css](style.css) is a token system with dark as the default ground and a light theme applied both via `prefers-color-scheme` and an explicit `[data-theme]` override — **the light values exist in two blocks and must be edited together**, or the toggle and the OS preference disagree.

Palette values and structural conventions (2px corners, mono uppercase eyebrows, the status strip, orange signal against phosphor-green system state) are aligned with the official game site so the tool reads as a companion to it. Their wordmark, artwork and licensed display face (Stratum2) are deliberately **not** used. The display face is [Saira](fonts/) — SIL OFL, self-hosted as one variable woff2, with [fonts/OFL.txt](fonts/OFL.txt) retained as the licence requires. Keep it self-hosted: a webfont CDN would put a third party in the critical path of rendering text on every page load, and the font is the one asset that has no reason to be anywhere else. (The page is *not* request-pure — item images and the favicon come from the wiki, the footer version from `api.github.com`, and analytics from `eu.umami.is`. All are disclosed in [privacy.html](privacy.html).)

Saira carries the interface voice (names, labels, actions, prose); the mono stack is reserved for readings — anything the solver measured or counted.

## Analytics

Umami (EU plan), one `<script defer>` in `index.html`'s head, plus `tlcTrack` and about a dozen call sites in `app.js`. The whole of it is removable by deleting the tag and grepping out `tlcTrack`.

- **`tlcTrack` lives in `app.js` rather than in its own script on purpose.** A file named `analytics.js` is matched by common ad-blocker filter lists; if it were blocked, every call site would throw `ReferenceError` and take the app down. `app.js` is never blocked by name. The helper is guarded and swallows its own errors — `window.umami` is undefined whenever the script is blocked, fails, or the visitor sends Do Not Track, and Umami does **not** queue calls.
- **Never pre-define `window.umami` as a stub queue.** The real tracker does `window.umami || (window.umami = {...})`, so an existing object is never overwritten and tracking would silently die forever.
- **`data-domains` is the only thing keeping localhost and forks out of the data.** It gates sending, not the script download. To watch events arrive while developing, add `,localhost` to it temporarily — and take it out again.
- **`data-do-not-track="true"` is not the default.** Without it the browser signal is ignored.
- **`data-performance` and `umami.identify()` stay off.** Both read or attach far more than reach measurement needs, and either would require a consent banner in Germany, which the current setup avoids.
- **Track at choke points, never at render points.** `finishSolve` fires once per solve; `displayResults` also runs on every `newBest` and would emit dozens of events per run. Same trap in `toggleUnlimited`, where only a real click passes `fillBlanks`.
- **Only fixed vocabulary is sent** — no item names, no imported data, nothing a user typed. [privacy.html](privacy.html) lists every event and must be updated alongside any new one.
- `tests.html` has its own head and carries no tag, so the suite generates no traffic.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on PRs and pushes to `master`: wasm-in-sync check → Playwright test run (waits for the static server to accept connections first) → Super-Linter (`VALIDATE_ALL_CODEBASE: false` — diff-scoped, so pre-existing style is not enforced) → dependency review. [security.yml](.github/workflows/security.yml) runs CodeQL weekly. CI is the deploy gate and should be a required status check on `master`.

Note that fork PRs from first-time contributors do not run CI until a maintainer approves the workflow — a green-looking PR may simply never have been tested.

Super-Linter reads its rules from [.github/linters/](.github/linters/), which is where the project's own conventions are recorded rather than left to the bundled defaults. `.stylelintrc.json` keeps `stylelint-config-standard` and switches off the rules that fight the stylesheet's deliberate house style — compact single-line rule bodies, legacy `rgba()` notation, no enforced blank lines — plus `media-feature-range-notation`, since `width <= 600px` needs a newer browser than the `max-width` form it would replace. **The two duplicate-detecting rules stay on:** `no-duplicate-selectors` and `declaration-block-no-duplicate-properties` each caught a real dead declaration, so they earn their place. `.htmlhintrc` exists mainly to allow `head-script-disabled` — the theme script *must* run in the head (see the invariant above), so the default rule forbidding it is wrong for this page.

## Game data

`data/*.csv` is sourced from the [official wiki](https://thelastcaretaker.wiki.gg/wiki/Humans), which exposes a queryable Cargo table (`api.php?action=cargoquery&tables=memories&fields=...`) — useful for diffing the shipped data against upstream. The wiki carries stats, item weight and rarity, but **no world counts**; `WorldCount` / `TotalAvailability` come from the maintainer and every memory row must have `WorldCount > 0` or the suite fails.

Users can edit data in the browser and export CSVs; updates land as PRs replacing the files in `data/`. Item images resolve to `https://thelastcaretaker.wiki.gg/images/{Name_With_Underscores}.png?format=original` (spaces → `_`, `'` → `%27`) and fail silently when absent, so new or custom entries need no broken-icon handling.
