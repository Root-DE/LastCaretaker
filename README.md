# The Last Caretaker — Human Growth Calculator

A static website that finds the most targeted food & memory recipe for any profession in [The Last Caretaker](https://store.steampowered.com/app/2722000/The_Last_Caretaker/).

The solver minimises **collateral profession matches** — not just item count — so you grow exactly the profession you want with minimal side effects.

## Live Site

Hosted on GitHub Pages from the `docs/` folder.

## Features

- **Specificity-optimised solver** — IDA\* with parallel Web Workers, ported from a Rust prototype
- **Live results** — best solution displayed in real-time as the search progresses
- **Pause / Resume / Cancel** — full control over long-running searches
- **Editable game data** — modify food, memory, and human stats directly in the browser
- **CSV import & export** — download or upload edited data for easy updates and sharing
- **Resource inventory** — set available item quantities or assume unlimited
- **Profession analysis** — shows inherent (unavoidable) vs avoidable collateral matches
- **Dark theme** — clean, responsive UI

## Project Structure

```
docs/               GitHub Pages static site
  index.html        Main page
  app.js            UI logic, CSV parsing, worker management
  solver-worker.js  Web Worker: specificity-optimised DFS
  style.css         Dark theme styles
  data/             CSV game data (humans, food, memories)
  .nojekyll         Disable Jekyll processing
rust_human_solver/  Original Rust prototype (reference only)
grow_human_solver.py  Original Python prototype (reference only)
```

## How It Works

1. Select a target profession
2. Optionally edit stat requirements or set resource limits
3. Click **Find Optimal Recipe**
4. The solver spawns parallel Web Workers running iterative-deepening DFS
5. Items are sorted by specificity (required stat contribution vs. extra stat contribution)
6. Solutions are ranked by fewest collateral professions matched, then fewest items
7. A "perfect" solution matches only the unavoidable (inherent) profession subsets

## Deployment

The site is fully static — just serve the `docs/` folder. For GitHub Pages:

1. Go to **Settings → Pages**
2. Set source to **Deploy from a branch**, branch `main`, folder `/docs`

No build step required. All computation runs client-side in Web Workers.

## Data Sources

Game data is sourced from the [official wiki](https://thelastcaretaker.wiki.gg/wiki/Humans). Item images are loaded from the wiki CDN.

## AI Disclosure

This project was developed with the assistance of AI tools (GitHub Copilot / Claude). The solver algorithm, website code, and documentation were produced collaboratively between a human developer and AI.

## License

[MIT](LICENSE)
