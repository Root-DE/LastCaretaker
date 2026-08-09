// stat-mapping.js — the 15-stat vector and the only place CSV columns are
// turned into it.
//
// Loaded as a plain <script> by both index.html and tests.html (no modules, no
// build step). It lives here rather than in app.js because these functions used
// to be copied into the test page: the copy kept passing while the shipped
// version drifted, so a deleted line could go green. One copy, tested directly.

// Index order is a hard contract — items, humans, bestPerStat, reqVec and the
// wasm memory layout all assume it.
const STAT_NAMES = [
  'weight', 'height', 'life_exp', 'strength', 'intellect',
  'adaptability', 'creativity', 'communication', 'discipline',
  'empathy', 'focus', 'leadership', 'logic', 'patience', 'wisdom',
];

const STAT_LABELS = {
  weight: 'Weight', height: 'Height', life_exp: 'Life Exp.', strength: 'Strength',
  intellect: 'Intellect', adaptability: 'Adaptability', creativity: 'Creativity',
  communication: 'Communication', discipline: 'Discipline', empathy: 'Empathy',
  focus: 'Focus', leadership: 'Leadership', logic: 'Logic', patience: 'Patience',
  wisdom: 'Wisdom',
};

// Short headings for the edit tables. "Communication" is wider than any value
// beneath it, and with 15 stat columns the headings alone decide whether the
// table fits the screen. The full label rides along as a tooltip.
const STAT_ABBR = {
  weight: 'Weight', height: 'Height', life_exp: 'Life', strength: 'Str',
  intellect: 'Int', adaptability: 'Adapt', creativity: 'Creat',
  communication: 'Comm', discipline: 'Disc', empathy: 'Emp', focus: 'Focus',
  leadership: 'Lead', logic: 'Logic', patience: 'Pat', wisdom: 'Wis',
};

// Which CSV column feeds which stat, per file. Declaring it as data rather than
// as three hand-written blocks of s[n] = ... is the point: a stat cannot be
// dropped by an edit that happens to match one line, and the tests below walk
// these tables instead of restating them.
//
// Extra names are older spellings, accepted so a CSV exported before the
// headers were corrected still imports.
const STAT_COLUMNS = {
  human: {
    weight: ['Weight'], height: ['Height'], life_exp: ['Life Exp', 'Life Exp.'],
    strength: ['Strength'], intellect: ['Intellect'], adaptability: ['Adaptability'],
    creativity: ['Creativity'], communication: ['Communication'],
    discipline: ['Discipline', 'Disipline'], empathy: ['Empathy'], focus: ['Focus'],
    leadership: ['Leadership'], logic: ['Logic'], patience: ['Patience'], wisdom: ['Wisdom'],
  },
  // Food carries the five physical stats. Intellect is one of them: every food
  // grants it and no memory does.
  food: {
    weight: ['Weight'], height: ['Height'], life_exp: ['Life Exp', 'Life Exp.'],
    strength: ['Strength'], intellect: ['Intellect'],
  },
  // Memories carry the ten mental stats — deliberately no intellect.
  memory: {
    adaptability: ['Adaptability'], communication: ['Communication'],
    creativity: ['Creativity'], discipline: ['Discipline', 'Disipline'],
    empathy: ['Empathy'], focus: ['Focus'], leadership: ['Leadership'],
    logic: ['Logic'], patience: ['Patience'], wisdom: ['Wisdom'],
  },
};

// Reads a stat cell, taking the first header present, so older exports still load.
function statCell(row, names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && String(v).trim() !== '') return parseFloat(v) || 0;
  }
  return 0;
}

// Map a parsed CSV row to the 15-stat vector, using the table for that file.
function statsFromRow(row, kind) {
  const s = new Array(15).fill(0);
  const cols = STAT_COLUMNS[kind];
  for (const stat in cols) s[STAT_NAMES.indexOf(stat)] = statCell(row, cols[stat]);
  return s;
}

function humanStats(row) { return statsFromRow(row, 'human'); }
function foodStats(row) { return statsFromRow(row, 'food'); }
function memoryStats(row) { return statsFromRow(row, 'memory'); }
