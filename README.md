# The Last Caretaker — Human Growth Calculator

A static website that finds the most targeted food & memory recipe for any profession in [The Last Caretaker](https://store.steampowered.com/app/1783560/The_Last_Caretaker/).

The solver minimises **collateral profession matches** — not just item count — so you grow exactly the profession you want with minimal side effects.

## Live Site

Hosted on GitHub Pages from the root of the `main` branch.

## Features

- **Specificity-optimised solver** — [IDA\*](https://en.wikipedia.org/wiki/Iterative_deepening_A*) with parallel Web Workers
- **Live results** — best solution displayed in real-time during search
- **Pause / Resume / Cancel** — full control over long-running searches (async yield to event loop)
- **Configurable search depth** — set max recipe depth in Settings (0 = auto)
- **Per-worker depth display** — see which depth each worker is exploring in real-time
- **Smart item filtering** — items irrelevant to target stats are excluded; item repetitions capped to useful maximum
- **Ordered search** — combinations explored in canonical order to avoid duplicate permutations
- **Editable game data** — add, remove, and modify food, memory, and human stats in the browser
- **CSV import & export** — download or upload data for easy updates and sharing (works on GitHub Pages)
- **Resource inventory** — set available item quantities or assume unlimited
- **Apply solution** — one-click subtraction of used items from your inventory
- **Profession analysis** — shows inherent vs avoidable collateral matches with explanations
- **Dark theme** — clean, responsive UI
- **No build step** — pure static HTML/JS/CSS, all computation client-side

## Project Structure

```
index.html          Main page
app.js              UI logic, CSV parsing, worker management
solver-worker.js    Web Worker: specificity-optimised DFS
style.css           Dark theme styles
data/               CSV game data (humans, food, memories)
tests.html          Browser-based test suite
run-tests.js        Headless test runner for CI (Playwright)
.nojekyll           Disable Jekyll processing on GitHub Pages
.github/workflows/  CI: tests on PR, security scanning
```

## How It Works

1. Select a target profession
2. Optionally edit stat requirements or set resource limits
3. Click **Find Optimal Recipe**
4. The solver spawns parallel Web Workers running iterative-deepening DFS
5. Items irrelevant to required stats are filtered out before solving
6. Each item's max repetitions are clamped to the max that could contribute
7. Items are sorted by specificity (required stat contribution vs. extra stat contribution)
8. Combinations are explored in canonical (index-ordered) form to avoid permutation duplicates
9. Solutions are ranked by fewest collateral professions matched, then fewest items
10. A "perfect" solution matches only the unavoidable (inherent) profession subsets

### Multiple profession matches

When the accumulated stats from a recipe exceed the requirements of more than one profession, all of those professions are considered "matched". Some matches are **inherent** — their requirements are a strict subset of your target, so they will always match regardless of recipe. Others are **avoidable** and appear only because of side-effect stats.

**It is currently unclear which profession the game selects when multiple professions match** — it may be random. The solver minimises collateral matches to give you the best odds.

## Updating Game Data

When the game updates with new foods, memories, or profession requirements:

1. **Edit in the browser**: Open the site → *Edit Game Data* → modify entries or click *+ Add* to create new ones
2. **Download CSVs**: Use the download buttons to export your changes
3. **Create a PR**: Replace the corresponding files in `data/` and open a pull request

### Handling images for new entities

Item images are loaded from the [official wiki CDN](https://thelastcaretaker.wiki.gg/) using the pattern:
```
https://thelastcaretaker.wiki.gg/images/{Name_With_Underscores}.png?format=original
```
Spaces in item names are converted to underscores, apostrophes are URL-encoded. If a new item doesn't have a wiki image yet, the image will silently fail to load — no broken icon is shown. Once the wiki page is created with the correct image name, it will work automatically.

For custom entries added by users (not from the wiki), images won't be available — this is expected and the UI handles it gracefully.

## CI / CD

- **On pull request**: Tests run in a headless browser (Playwright), linting and security checks via Super-Linter
- **On push to main**: Same test + lint pipeline
- **Weekly (scheduled)**: CodeQL analysis for vulnerability scanning

## Running Tests Locally

Open `tests.html` in a browser (served via any HTTP server):
```bash
npx serve . -l 8080
# then open http://localhost:8080/tests.html
```

Or run headlessly:
```bash
npx playwright install chromium --with-deps
npx serve . -l 8080 &
node run-tests.js
```

## Data Sources

Game data is sourced from the [official wiki](https://thelastcaretaker.wiki.gg/wiki/Humans). Item images are loaded from the wiki CDN.

## AI Disclosure

This project was developed with the assistance of AI tools (GitHub Copilot / Claude). The solver algorithm, website code, and documentation were produced collaboratively between a human developer and AI.

## License

[CC BY-NC-ND 4.0](LICENSE) — Free for personal, non-commercial use. No selling, no redistribution.
