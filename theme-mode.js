// theme-mode.js — resolves the three-way theme setting to a concrete theme.
//
// Loaded as a plain <script> by index.html (before the stylesheet, so the
// resolved theme is on <html> at first paint) and by tests.html.

const THEME_MODES = ['dark', 'auto', 'light'];

// The day, for the purposes of the fallback below.
const THEME_DAY_STARTS = 7;   // 07:00
const THEME_DAY_ENDS = 19;    // 19:00

// Anything unrecognised — never set, cleared, a value from a future version —
// falls back to following the environment.
function readThemeMode(stored) {
  return THEME_MODES.indexOf(stored) === -1 ? 'auto' : stored;
}

// mode: 'dark' | 'auto' | 'light'
// env:  { prefersDark, prefersLight, hour }  hour is 0-23 local time
//
// A browser that has no colour preference set matches neither media query, and
// on those the clock is a better guess than always assuming dark.
function resolveTheme(mode, env) {
  if (mode === 'dark' || mode === 'light') return mode;
  if (env.prefersDark) return 'dark';
  if (env.prefersLight) return 'light';
  return (env.hour >= THEME_DAY_STARTS && env.hour < THEME_DAY_ENDS) ? 'light' : 'dark';
}
