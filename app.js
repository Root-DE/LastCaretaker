// app.js — Main application logic for the Human Growth Specificity Calculator

const STAT_NAMES = [
  'weight','height','life_exp','strength','intellect',
  'adaptability','creativity','communication','disipline',
  'empathy','focus','leadership','logic','patience','wisdom',
];

const STAT_LABELS = {
  weight:'Weight', height:'Height', life_exp:'Life Exp.', strength:'Strength',
  intellect:'Intellect', adaptability:'Adaptability', creativity:'Creativity',
  communication:'Communication', disipline:'Discipline', empathy:'Empathy',
  focus:'Focus', leadership:'Leadership', logic:'Logic', patience:'Patience',
  wisdom:'Wisdom',
};

const CATEGORY_CLASS = {
  'Engineer':'cat-engineer','Arts & Culture':'cat-arts','Educator':'cat-educator',
  'Agriculture':'cat-agriculture','Logistics':'cat-logistics','Military':'cat-military',
  'Science':'cat-science','Healthcare':'cat-healthcare','Leadership':'cat-leadership',
  'Explorer':'cat-explorer',
};

const REPO_COMMITS_API = 'https://api.github.com/repos/Root-DE/LastCaretaker/commits?per_page=1';

// ─── State ───────────────────────────────────────────────────────────────────
let humans = [];   // [{profession, category, stats:[15]}]
let foods  = [];   // [{name, stats:[15]}]
let memories = []; // [{name, stats:[15]}]
let items  = [];   // unified [{name, kind, stats:[15]}] — rebuilt before each solve
let workers = [];
let solving = false;
let paused = false;
let solveStart = 0;
let pauseStart = 0;
let totalPausedMs = 0;
let solveTimer = null;
let globalBest = null;
let workerNodes = [];
let workerDepths = [];
let maxDepthReached = 0;
let currentMaxSearchDepth = 0;
let workersDone = 0;
let workersExhaustive = 0;
let numWorkers = 0;
let inherentCount = 0;
let currentTarget = null;
let ecoModeActive = false;
let ecoModeValue  = 0; // 0=Normal, 1=World Eco, 2=Inventory Eco
let cancelledByUser = false;
let allSolutions = [];
let solutionIndex = 0;
let userBrowsingSolutions = false;

// ─── CSV Parsing ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(';');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 2) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (cols[j] || '').trim();
    }
    rows.push(row);
  }
  return { headers: headers.map(h => h.trim()), rows };
}

function normalize(s) { return s.replace(/\u00a0/g, ' ').trim(); }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getItemImageUrl(name) {
  const formatted = name.replace(/ /g, '_').replace(/'/g, '%27');
  return `https://thelastcaretaker.wiki.gg/images/${formatted}.png?format=original`;
}

// Map CSV columns → 15-stat array for humans
function humanStats(row) {
  const s = new Array(15).fill(0);
  s[0]  = parseFloat(row['Weight']) || 0;
  s[1]  = parseFloat(row['Height']) || 0;
  s[2]  = parseFloat(row['Life Exp.']) || 0;
  s[3]  = parseFloat(row['Strength']) || 0;
  s[4]  = parseFloat(row['Intellect']) || 0;
  s[5]  = parseFloat(row['Adaptability']) || 0;
  s[6]  = parseFloat(row['Creativity']) || 0;
  s[7]  = parseFloat(row['Communication']) || 0;
  s[8]  = parseFloat(row['Disipline']) || 0;
  s[9]  = parseFloat(row['Empathy']) || 0;
  s[10] = parseFloat(row['Focus']) || 0;
  s[11] = parseFloat(row['Leadership']) || 0;
  s[12] = parseFloat(row['Logic']) || 0;
  s[13] = parseFloat(row['Patience']) || 0;
  s[14] = parseFloat(row['Wisdom']) || 0;
  return s;
}

// Map CSV columns → 15-stat array for food (only physical stats)
function foodStats(row) {
  const s = new Array(15).fill(0);
  s[0]  = parseFloat(row['Weight']) || 0;
  s[1]  = parseFloat(row['Height']) || 0;
  s[2]  = parseFloat(row['Life Exp']) || 0;
  s[3]  = parseFloat(row['Strength']) || 0;
  s[4]  = parseFloat(row['Intellect']) || 0;
  return s;
}

// Map CSV columns → 15-stat array for memories (mental stats + intellect)
function memoryStats(row) {
  const s = new Array(15).fill(0);
  s[5]  = parseFloat(row['Adaptability']) || 0;
  s[7]  = parseFloat(row['Communication']) || 0;
  s[6]  = parseFloat(row['Creativity']) || 0;
  s[8]  = parseFloat(row['Discipline']) || 0;
  s[9]  = parseFloat(row['Empathy']) || 0;
  s[10] = parseFloat(row['Focus']) || 0;
  s[4]  = parseFloat(row['Intellect']) || 0;
  s[11] = parseFloat(row['Leadership']) || 0;
  s[12] = parseFloat(row['Logic']) || 0;
  s[13] = parseFloat(row['Patience']) || 0;
  s[14] = parseFloat(row['Wisdom']) || 0;
  return s;
}

// ─── Data Loading ────────────────────────────────────────────────────────────
async function fetchCSV(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return await res.text();
}

async function loadData() {
  const [hText, fText, mText] = await Promise.all([
    fetchCSV('data/humans.csv'),
    fetchCSV('data/food.csv'),
    fetchCSV('data/memories.csv'),
  ]);

  const hCSV = parseCSV(hText);
  humans = hCSV.rows.map(r => ({
    profession: normalize(r['Profession'] || ''),
    category: normalize(r['Category'] || ''),
    stats: humanStats(r),
  }));

  const fCSV = parseCSV(fText);
  foods = fCSV.rows.map(r => ({
    name: normalize(r['Food'] || ''),
    stats: foodStats(r),
    availability: parseInt(r['TotalAvailability']) || 0,
  }));

  const mCSV = parseCSV(mText);
  memories = mCSV.rows.map(r => ({
    name: normalize(r['Memory'] || ''),
    stats: memoryStats(r),
    availability: parseInt(r['WorldCount']) || 0,
  }));
}

// ─── UI: Profession Dropdown ─────────────────────────────────────────────────
function populateDropdown() {
  const sel = document.getElementById('profession-select');
  const cats = {};
  humans.forEach((h, i) => {
    if (!cats[h.category]) cats[h.category] = [];
    cats[h.category].push({ index: i, ...h });
  });
  for (const [cat, list] of Object.entries(cats)) {
    const grp = document.createElement('optgroup');
    grp.label = cat;
    for (const h of list) {
      const opt = document.createElement('option');
      opt.value = h.index;
      opt.textContent = h.profession;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
}

function onProfessionChange() {
  const sel = document.getElementById('profession-select');
  const idx = parseInt(sel.value);
  const panel = document.getElementById('requirements-panel');
  const solveBtn = document.getElementById('solve-btn');
  if (isNaN(idx)) {
    panel.classList.add('hidden');
    solveBtn.disabled = true;
    currentTarget = null;
    idleStatus();
    return;
  }
  currentTarget = idx;
  solveBtn.disabled = false;
  showRequirements(idx);
  idleStatus();
}

function showRequirements(idx) {
  const h = humans[idx];
  const panel = document.getElementById('requirements-panel');
  const title = document.getElementById('req-title');
  const grid = document.getElementById('req-grid');

  title.textContent = `${h.profession} (${h.category})`;
  grid.innerHTML = '';

  h.stats.forEach((val, si) => {
    if (val <= 0) return;
    const chip = document.createElement('div');
    chip.className = 'req-chip';
    chip.innerHTML = `
      <span class="req-chip-name">${STAT_LABELS[STAT_NAMES[si]]}</span>
      <input type="number" class="req-chip-val" value="${val}" min="0"
             data-human="${idx}" data-stat="${si}">
    `;
    grid.appendChild(chip);
  });

  // Wire up editable values
  grid.querySelectorAll('.req-chip-val').forEach(inp => {
    inp.addEventListener('change', () => {
      const hi = parseInt(inp.dataset.human);
      const si = parseInt(inp.dataset.stat);
      humans[hi].stats[si] = parseFloat(inp.value) || 0;
      showAnalysis(hi);
    });
  });

  showAnalysis(idx);
  panel.classList.remove('hidden');
}

function stripTier(name) { return name.replace(/ T\d+$/, ''); }
function getTier(name) { const m = name.match(/ T(\d+)$/); return m ? parseInt(m[1]) : 0; }

function groupByCategory(list) {
  const cats = {};
  list.forEach(h => {
    if (!cats[h.category]) cats[h.category] = [];
    cats[h.category].push(h);
  });
  // Sort within each category by tier
  for (const arr of Object.values(cats)) {
    arr.sort((a, b) => getTier(a.profession) - getTier(b.profession));
  }
  return cats;
}

function analysisGroupHTML(list, tagClass) {
  const cats = groupByCategory(list);
  let html = '';
  for (const [cat, profs] of Object.entries(cats)) {
    const catCls = CATEGORY_CLASS[cat] || '';
    html += `<div class="analysis-cat-group">
      <span class="analysis-cat-header ${catCls}">${esc(cat)}</span>
      <span class="analysis-cat-items">${profs.map(h =>
        `<span class="analysis-tag ${tagClass}" data-prof="${esc(h.profession)}"
               title="${esc(h.profession)}">${esc(stripTier(h.profession))}</span>`).join('')}</span>
    </div>`;
  }
  return html;
}

function showAnalysis(targetIdx) {
  const target = humans[targetIdx];
  const inherentList = [];
  const avoidableList = [];

  humans.forEach((h, hi) => {
    const isSubset = STAT_NAMES.every((_, si) => {
      const hReq = h.stats[si];
      const tReq = target.stats[si];
      return hReq <= 0 || (tReq > 0 && hReq <= tReq);
    });
    if (hi === targetIdx || isSubset) {
      inherentList.push(h);
    } else {
      avoidableList.push(h);
    }
  });

  const ap = document.getElementById('analysis-panel');
  const inhDiv = document.getElementById('analysis-inherent');
  const avoDiv = document.getElementById('analysis-avoidable');

  // Identify lower-tier professions in the same category that are inherent subsets
  const targetCat = target.category;
  const lowerTierInherent = inherentList.filter(h =>
    h.profession !== target.profession && h.category === targetCat);

  let inherentNote = '';
  if (lowerTierInherent.length > 0) {
    inherentNote = `<div class="analysis-note">ℹ️ Lower-tier professions in the same category (${esc(targetCat)}) are always inherent matches —
      any recipe that unlocks a higher tier will also satisfy the lower tiers. This cannot be avoided.</div>`;
  }

  let avoidableNote = '';
  if (avoidableList.length > 0) {
    avoidableNote = `<div class="analysis-note analysis-note-tip">⏱ ${avoidableList.length} profession${avoidableList.length !== 1 ? 's' : ''} can potentially be avoided.
      The solver needs enough time to find the most specific recipe —
      if results still show avoidable matches, try increasing the <strong>Timeout</strong> in Settings.</div>`;
  }

  inhDiv.innerHTML = `<div class="analysis-label">Always matched (${inherentList.length}):</div>
    <div class="analysis-grouped">${analysisGroupHTML(inherentList, 'inherent')}</div>${inherentNote}`;

  avoDiv.innerHTML = `<div class="analysis-label">Can be avoided (${avoidableList.length}):</div>
    <div class="analysis-grouped">${analysisGroupHTML(avoidableList, 'avoidable')}</div>${avoidableNote}`;

  ap.classList.remove('hidden');
  boardKey = null; // the tags were just re-rendered — force the next paint
  markBoard(null);
}

// The board is the live view of the search: every profession the target could
// collaterally produce, lit as the current best recipe changes. `matched` is the
// list from displayResults; null clears it back to the resting state.
// Live results refresh on every improvement, so repaint only when the matched
// set actually changes — otherwise the board flickers throughout a long search.
let boardKey = null;

function markBoard(matched) {
  const key = matched ? matched.map(m => m.profession).sort().join('|') : '';
  if (key === boardKey) return;
  boardKey = key;

  const target = currentTarget !== null ? humans[currentTarget].profession : null;
  const hits = matched ? new Set(matched.map(m => m.profession)) : null;
  document.querySelectorAll('.analysis-tag[data-prof]').forEach(tag => {
    const prof = tag.dataset.prof;
    tag.classList.toggle('is-target', prof === target);
    tag.classList.toggle('is-hit', !!hits && prof !== target && hits.has(prof));
  });
}

// ─── UI: Inventory ───────────────────────────────────────────────────────────
function buildInventory() {
  buildItemGrid('foods-grid', foods, 'food');
  buildItemGrid('memories-grid', memories, 'memory');
}

function buildItemGrid(containerId, itemList, kind) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  itemList.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'inv-item';
    div.innerHTML = `
      <img class="inv-item-img" src="${getItemImageUrl(item.name)}" alt="${esc(item.name)}"
           onerror="this.style.display='none'">
      <div class="inv-item-name">${esc(item.name)}</div>
      <input type="number" class="inv-item-input" min="0" placeholder="∞"
             data-kind="${kind}" data-index="${i}">
    `;
    container.appendChild(div);
    container.lastElementChild.querySelector('.inv-item-input').addEventListener('change', persistInventory);
  });
}

function getResourceLimits() {
  const unlimited = document.getElementById('unlimited-check').checked;
  const limits = { foods: [], memories: [] };
  // Unlimited mode: food is freely craftable (truly unlimited), but memories are
  // finite collectibles — cap each at its world maximum (WorldCount). A memory with
  // no recorded world count (0) falls back to unlimited rather than being excluded.
  foods.forEach((_, i) => limits.foods.push(unlimited ? 9999 : getInvValue('food', i)));
  memories.forEach((m, i) => limits.memories.push(unlimited ? (m.availability || 9999) : getInvValue('memory', i)));
  return limits;
}

function getInvValue(kind, index) {
  const inp = document.querySelector(`.inv-item-input[data-kind="${kind}"][data-index="${index}"]`);
  if (!inp || inp.value === '') return 9999; // unlimited
  return parseInt(inp.value) || 0;
}

function csvQuote(s) {
  // Wrap in double quotes if the value contains delimiter, quotes, or newlines
  s = String(s);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function saveInventory() {
  const unlimited = document.getElementById('unlimited-check').checked;
  let csv = 'Name;Kind;Count\n';
  document.querySelectorAll('.inv-item-input').forEach(inp => {
    const kind = inp.dataset.kind;
    const index = parseInt(inp.dataset.index);
    const list = kind === 'food' ? foods : memories;
    const name = list[index] ? list[index].name : '';
    // Blank exports as blank in both modes: it means unlimited for that item,
    // and writing 0 here would turn a Save/Load round trip into an exclusion.
    csv += `${csvQuote(name)};${kind};${inp.value}\n`;
  });
  csv += `_unlimited;setting;${unlimited}\n`;
  downloadBlob(csv, 'inventory.csv');
  flashButton('save-inv-btn');
  showToast('Inventory saved as CSV');
}

function loadInventory(silent) {
  if (silent) {
    // On startup, try localStorage for backward compat
    const raw = localStorage.getItem('tlc_inventory');
    if (!raw) return;
    try {
      // Counts are keyed by item name; blobs written by older versions are keyed
      // by list position and get converted against the frozen v1 item order, so
      // adding or reordering rows in data/*.csv cannot skew an old inventory.
      const state = migrateInventoryData(JSON.parse(raw));
      if (state.unlimited !== null) {
        document.getElementById('unlimited-check').checked = state.unlimited;
        toggleUnlimited(false);
      }
      document.querySelectorAll('.inv-item-input').forEach(inp => {
        const list = inp.dataset.kind === 'food' ? foods : memories;
        const item = list[parseInt(inp.dataset.index)];
        if (!item) return;
        const count = state.counts[inp.dataset.kind][item.name];
        if (count !== undefined) inp.value = count;
      });
      // Rewrite in the current format so the conversion only ever happens once.
      persistInventory();
    } catch (e) {
      // Corrupted localStorage — silently discard
      localStorage.removeItem('tlc_inventory');
    }
    return;
  }
  // Interactive: open file picker for CSV
  const fileInput = document.getElementById('inv-csv-upload');
  fileInput.value = '';
  fileInput.click();
}

function handleInvCSVUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const csv = parseCSV(reader.result);
    // Build lookup: name+kind → count
    const lookup = {};
    let unlimitedVal = null;
    csv.rows.forEach(r => {
      const name = normalize(r['Name'] || '');
      const kind = (r['Kind'] || '').trim().toLowerCase();
      const count = (r['Count'] || '').trim();
      if (name === '_unlimited' && kind === 'setting') {
        unlimitedVal = count === 'true';
        return;
      }
      lookup[`${kind}:${name}`] = count;
    });
    if (unlimitedVal !== null) {
      document.getElementById('unlimited-check').checked = unlimitedVal;
      toggleUnlimited(false);
    }
    document.querySelectorAll('.inv-item-input').forEach(inp => {
      const kind = inp.dataset.kind;
      const index = parseInt(inp.dataset.index);
      const list = kind === 'food' ? foods : memories;
      const name = list[index] ? list[index].name : '';
      const key = `${kind}:${name}`;
      if (lookup[key] !== undefined) inp.value = lookup[key];
    });
    flashButton('load-inv-btn');
    showToast('Inventory loaded from CSV');
    persistInventory();
  };
  reader.readAsText(file);
}

function flashButton(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.style.background = 'var(--green)';
  btn.style.color = '#000';
  setTimeout(() => { btn.style.background = ''; btn.style.color = ''; }, 600);
}

// Clears every count back to blank (= unlimited for that item) without changing
// the mode, so "unlimited except the few things I don't have" is a Reset plus a
// couple of zeroes rather than filling in every field by hand.
function resetInventory() {
  document.querySelectorAll('.inv-item-input').forEach(inp => { inp.value = ''; });
  persistInventory();
  showToast('Inventory reset');
}

// `fillBlanks` seeds empty fields with 0 when switching to limited mode, so the
// user starts from "I have nothing" and fills in what they own. That is a
// convenience for a real click only — restoring saved state must pass false, or
// a field deliberately left blank (= unlimited for that item) would come back
// as 0 and silently drop the item from every search.
function toggleUnlimited(fillBlanks) {
  const checked = document.getElementById('unlimited-check').checked;
  document.getElementById('inventory-limited').classList.toggle('hidden', checked);
  if (!checked && fillBlanks) {
    document.querySelectorAll('.inv-item-input').forEach(inp => {
      if (inp.value === '') inp.value = '0';
    });
  }
}

// ─── UI: Edit Data Tables ────────────────────────────────────────────────────
function buildEditTables() {
  buildFoodTable();
  buildMemoryTable();
  buildHumanTable();
}

function buildFoodTable() {
  const statCols = ['weight','height','life_exp','strength','intellect'];
  const wrap = document.getElementById('food-table-wrap');
  let html = '<table class="edit-table"><thead><tr><th>Food</th>';
  statCols.forEach(s => { html += `<th>${STAT_LABELS[s]}</th>`; });
  html += '<th></th></tr></thead><tbody>';
  foods.forEach((f, fi) => {
    html += `<tr><td><input type="text" value="${esc(f.name)}" class="edit-name-input"
              data-type="food" data-index="${fi}" data-field="name"></td>`;
    statCols.forEach(s => {
      const si = STAT_NAMES.indexOf(s);
      html += `<td><input type="number" value="${f.stats[si] || ''}" min="0"
                data-type="food" data-index="${fi}" data-stat="${si}"></td>`;
    });
    html += `<td><button class="btn-del-row" data-type="food" data-index="${fi}" title="Remove">✕</button></td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input[data-stat]').forEach(inp => {
    inp.addEventListener('change', () => {
      foods[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
  wrap.querySelectorAll('input[data-field="name"]').forEach(inp => {
    inp.addEventListener('change', () => {
      foods[parseInt(inp.dataset.index)].name = inp.value.trim();
    });
  });
  wrap.querySelectorAll('.btn-del-row[data-type="food"]').forEach(btn => {
    btn.addEventListener('click', () => {
      foods.splice(parseInt(btn.dataset.index), 1);
      buildFoodTable(); buildInventory();
    });
  });
}

function buildMemoryTable() {
  const statCols = ['adaptability','communication','creativity','disipline','empathy',
                    'focus','intellect','leadership','logic','patience','wisdom'];
  const wrap = document.getElementById('memory-table-wrap');
  let html = '<table class="edit-table"><thead><tr><th>Memory</th>';
  statCols.forEach(s => { html += `<th>${STAT_LABELS[s]}</th>`; });
  html += '<th></th></tr></thead><tbody>';
  memories.forEach((m, mi) => {
    html += `<tr><td><input type="text" value="${esc(m.name)}" class="edit-name-input"
              data-type="memory" data-index="${mi}" data-field="name"></td>`;
    statCols.forEach(s => {
      const si = STAT_NAMES.indexOf(s);
      html += `<td><input type="number" value="${m.stats[si] || ''}" min="0"
                data-type="memory" data-index="${mi}" data-stat="${si}"></td>`;
    });
    html += `<td><button class="btn-del-row" data-type="memory" data-index="${mi}" title="Remove">✕</button></td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input[data-stat]').forEach(inp => {
    inp.addEventListener('change', () => {
      memories[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
  wrap.querySelectorAll('input[data-field="name"]').forEach(inp => {
    inp.addEventListener('change', () => {
      memories[parseInt(inp.dataset.index)].name = inp.value.trim();
    });
  });
  wrap.querySelectorAll('.btn-del-row[data-type="memory"]').forEach(btn => {
    btn.addEventListener('click', () => {
      memories.splice(parseInt(btn.dataset.index), 1);
      buildMemoryTable(); buildInventory();
    });
  });
}

function buildHumanTable() {
  const wrap = document.getElementById('human-table-wrap');
  let html = '<table class="edit-table"><thead><tr><th>Profession</th><th>Category</th>';
  STAT_NAMES.forEach(s => { html += `<th>${STAT_LABELS[s]}</th>`; });
  html += '<th></th></tr></thead><tbody>';
  humans.forEach((h, hi) => {
    html += `<tr><td><input type="text" value="${esc(h.profession)}" class="edit-name-input"
              data-type="human" data-index="${hi}" data-field="profession"></td>`;
    html += `<td><input type="text" value="${esc(h.category)}" class="edit-name-input edit-cat-input"
              data-type="human" data-index="${hi}" data-field="category"></td>`;
    STAT_NAMES.forEach((s, si) => {
      html += `<td><input type="number" value="${h.stats[si] || ''}" min="0"
                data-type="human" data-index="${hi}" data-stat="${si}"></td>`;
    });
    html += `<td><button class="btn-del-row" data-type="human" data-index="${hi}" title="Remove">✕</button></td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input[data-stat]').forEach(inp => {
    inp.addEventListener('change', () => {
      humans[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
  wrap.querySelectorAll('input[data-field="profession"]').forEach(inp => {
    inp.addEventListener('change', () => {
      humans[parseInt(inp.dataset.index)].profession = inp.value.trim();
      rebuildDropdown();
    });
  });
  wrap.querySelectorAll('input[data-field="category"]').forEach(inp => {
    inp.addEventListener('change', () => {
      humans[parseInt(inp.dataset.index)].category = inp.value.trim();
      rebuildDropdown();
    });
  });
  wrap.querySelectorAll('.btn-del-row[data-type="human"]').forEach(btn => {
    btn.addEventListener('click', () => {
      humans.splice(parseInt(btn.dataset.index), 1);
      buildHumanTable(); rebuildDropdown();
    });
  });
}

// ─── Profession Combobox ─────────────────────────────────────────────────────
const _combo = { profIdx: null, profName: '', highlight: -1, isOpen: false };

function _comboRender() {
  const input = document.getElementById('profession-filter');
  const dropdown = document.getElementById('profession-dropdown');
  const q = (input.value || '').trim().toLowerCase();

  const groups = {};
  const order = [];
  let fi = 0;
  humans.forEach((h, i) => {
    if (q && !h.profession.toLowerCase().includes(q) && !h.category.toLowerCase().includes(q)) return;
    if (!groups[h.category]) { groups[h.category] = []; order.push(h.category); }
    groups[h.category].push({ i, name: h.profession, fi: fi++ });
  });

  dropdown.innerHTML = '';
  _combo.highlight = -1;

  if (!order.length) {
    const el = document.createElement('div');
    el.className = 'prof-combo-empty';
    el.textContent = 'No professions match';
    dropdown.appendChild(el);
    return;
  }

  for (const cat of order) {
    const grp = document.createElement('div');
    grp.className = 'prof-combo-group';
    const lbl = document.createElement('div');
    lbl.className = 'prof-combo-grouplabel';
    lbl.textContent = cat;
    grp.appendChild(lbl);
    for (const { i, name } of groups[cat]) {
      const el = document.createElement('div');
      el.className = 'prof-combo-option' + (i === _combo.profIdx ? ' is-selected' : '');
      el.textContent = name;
      el.dataset.pi = i;
      el.addEventListener('mousedown', e => { e.preventDefault(); _comboSelect(i, name); });
      grp.appendChild(el);
    }
    dropdown.appendChild(grp);
  }
}

function _comboPosition() {
  const input = document.getElementById('profession-filter');
  const dd = document.getElementById('profession-dropdown');
  const r = input.getBoundingClientRect();
  dd.style.left  = r.left + 'px';
  dd.style.top   = (r.bottom + 4) + 'px';
  dd.style.width = r.width + 'px';
}

function _comboOpen() {
  if (_combo.isOpen) return;
  _combo.isOpen = true;
  document.getElementById('profession-combo').classList.add('open');
  const dd = document.getElementById('profession-dropdown');
  dd.removeAttribute('hidden');
  _comboPosition();
  _comboRender();
  const cur = dd.querySelector('.is-selected');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function _comboClose(restore) {
  if (!_combo.isOpen) return;
  _combo.isOpen = false;
  document.getElementById('profession-combo').classList.remove('open');
  document.getElementById('profession-dropdown').setAttribute('hidden', '');
  if (restore) document.getElementById('profession-filter').value = _combo.profName;
}

function _comboSelect(idx, name) {
  _combo.profIdx = idx;
  _combo.profName = name;
  document.getElementById('profession-select').value = idx;
  _comboClose(true);
  onProfessionChange();
}

function _comboMoveHighlight(delta) {
  const opts = document.querySelectorAll('#profession-dropdown .prof-combo-option');
  if (!opts.length) return;
  const next = Math.max(0, Math.min(opts.length - 1, _combo.highlight + delta));
  opts.forEach((el, i) => el.classList.toggle('is-highlighted', i === next));
  _combo.highlight = next;
  opts[next].scrollIntoView({ block: 'nearest' });
}

function _comboSelectHighlighted() {
  const opts = document.querySelectorAll('#profession-dropdown .prof-combo-option');
  if (_combo.highlight >= 0 && opts[_combo.highlight]) {
    const el = opts[_combo.highlight];
    _comboSelect(parseInt(el.dataset.pi), el.textContent);
  }
}

function initCombobox() {
  const input = document.getElementById('profession-filter');
  const combo = document.getElementById('profession-combo');

  input.addEventListener('focus', () => { input.select(); _comboOpen(); });
  input.addEventListener('input', () => { if (!_combo.isOpen) _comboOpen(); else _comboRender(); });
  input.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); _combo.isOpen ? _comboMoveHighlight(1)    : _comboOpen(); break;
      case 'ArrowUp':   e.preventDefault(); _comboMoveHighlight(-1); break;
      case 'Enter':     e.preventDefault(); _combo.isOpen ? _comboSelectHighlighted() : _comboOpen(); break;
      case 'Escape':    e.preventDefault(); _comboClose(true); input.blur(); break;
      case 'Tab':       _comboClose(true); break;
    }
  });
  input.addEventListener('blur', () => { setTimeout(() => _comboClose(true), 150); });
  combo.addEventListener('mousedown', e => {
    if (e.target === input) return;
    e.preventDefault();
    _combo.isOpen ? (input.blur(), _comboClose(true)) : input.focus();
  });
  // Keep dropdown aligned when page scrolls or window resizes while open
  window.addEventListener('scroll', () => { if (_combo.isOpen) _comboPosition(); }, true);
  window.addEventListener('resize', () => { if (_combo.isOpen) _comboPosition(); });
}

function rebuildDropdown() {
  const sel = document.getElementById('profession-select');
  sel.innerHTML = '<option value="">\u2026</option>';
  populateDropdown();
  _combo.profIdx = null;
  _combo.profName = '';
  document.getElementById('profession-filter').value = '';
  if (_combo.isOpen) _comboRender();
}

// ─── Add Entry ───────────────────────────────────────────────────────────────
function addFood() {
  foods.push({ name: 'New Food', stats: new Array(15).fill(0), availability: 0 });
  buildFoodTable(); buildInventory();
}

function addMemory() {
  memories.push({ name: 'New Memory', stats: new Array(15).fill(0), availability: 0 });
  buildMemoryTable(); buildInventory();
}

function addHuman() {
  humans.push({ profession: 'New Profession', category: 'Custom', stats: new Array(15).fill(0) });
  buildHumanTable(); rebuildDropdown();
}

// ─── CSV Download ────────────────────────────────────────────────────────────
function downloadFoodCSV() {
  const foodStatCols = [
    {key:'Height',si:1},{key:'Intellect',si:4},{key:'Life Exp',si:2},
    {key:'Strength',si:3},{key:'Weight',si:0},
  ];
  let csv = 'Food;' + foodStatCols.map(c=>c.key).join(';') + ';TotalAvailability\n';
  foods.forEach(f => {
    csv += f.name + ';' + foodStatCols.map(c => f.stats[c.si] || '').join(';') + ';' + (f.availability || '') + '\n';
  });
  downloadBlob(csv, 'Food.csv');
}

function downloadMemoriesCSV() {
  const memCols = [
    {key:'Adaptability',si:5},{key:'Communication',si:7},{key:'Creativity',si:6},
    {key:'Discipline',si:8},{key:'Empathy',si:9},{key:'Focus',si:10},
    {key:'Intellect',si:4},{key:'Leadership',si:11},{key:'Logic',si:12},
    {key:'Patience',si:13},{key:'Wisdom',si:14},
  ];
  let csv = 'Memory;' + memCols.map(c=>c.key).join(';') + ';WorldCount\n';
  memories.forEach(m => {
    csv += m.name + ';' + memCols.map(c => m.stats[c.si] || '').join(';') + ';' + (m.availability || '') + '\n';
  });
  downloadBlob(csv, 'Memories.csv');
}

function downloadHumansCSV() {
  const cols = ['Category','Profession','Weight','Height','Life Exp.','Strength','Intellect',
    'Adaptability','Creativity','Communication','Disipline','Empathy','Focus',
    'Leadership','Logic','Patience','Wisdom'];
  let csv = cols.join(';') + '\n';
  humans.forEach(h => {
    csv += h.category + ';' + h.profession;
    STAT_NAMES.forEach((_,si) => { csv += ';' + (h.stats[si] || ''); });
    csv += '\n';
  });
  downloadBlob(csv, 'Humans.csv');
}

function downloadBlob(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

// ─── CSV Upload ──────────────────────────────────────────────────────────────
function uploadCSV(fileInput, onParsed) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    onParsed(reader.result);
    fileInput.value = '';
  };
  reader.readAsText(file);
}

function uploadFoodCSV(text) {
  const csv = parseCSV(text);
  foods = csv.rows.map(r => ({
    name: normalize(r['Food'] || ''),
    stats: foodStats(r),
    availability: parseInt(r['TotalAvailability']) || 0,
  }));
  buildInventory();
  buildEditTables();
  populateDropdown();
  showToast(`Loaded ${foods.length} foods`);
}

function uploadMemoriesCSV(text) {
  const csv = parseCSV(text);
  memories = csv.rows.map(r => ({
    name: normalize(r['Memory'] || ''),
    stats: memoryStats(r),
    availability: parseInt(r['WorldCount']) || 0,
  }));
  buildInventory();
  buildEditTables();
  populateDropdown();
  showToast(`Loaded ${memories.length} memories`);
}

function uploadHumansCSV(text) {
  const csv = parseCSV(text);
  humans = csv.rows.map(r => ({
    profession: normalize(r['Profession'] || ''),
    category: normalize(r['Category'] || ''),
    stats: humanStats(r),
  }));
  // Rebuild dropdown
  const sel = document.getElementById('profession-select');
  sel.innerHTML = '<option value="">Choose a profession&hellip;</option>';
  populateDropdown();
  currentTarget = null;
  document.getElementById('solve-btn').disabled = true;
  document.getElementById('requirements-panel').classList.add('hidden');
  buildEditTables();
  showToast(`Loaded ${humans.length} professions`);
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'padding:10px 24px;background:#30363d;color:#c9d1d9;border-radius:8px;font-size:.88rem;' +
      'z-index:1000;transition:opacity .3s;box-shadow:0 4px 12px rgba(0,0,0,.4);';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

async function loadFooterVersion() {
  const el = document.getElementById('footer-version');
  if (!el) return;

  try {
    const res = await fetch(REPO_COMMITS_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const commits = await res.json();
    const latest = Array.isArray(commits) ? commits[0] : null;
    if (!latest || !latest.sha || !latest.commit || !latest.commit.committer) {
      throw new Error('Missing commit metadata');
    }

    const shortSha = latest.sha.slice(0, 7);
    const committedAt = latest.commit.committer.date;
    const dateText = new Date(committedAt).toISOString().slice(0, 10);
    const label = `Version ${dateText}.${shortSha}`;

    el.textContent = '';
    const link = document.createElement('a');
    link.href = latest.html_url || 'https://github.com/Root-DE/LastCaretaker';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    link.title = latest.commit.message || label;
    el.appendChild(link);
  } catch (err) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      el.textContent = 'Local preview';
    } else {
      el.textContent = 'Version unavailable';
    }
  }
}

// ─── Solver Management ───────────────────────────────────────────────────────
function buildItems() {
  items = [];
  foods.forEach(f => {
    if (f.stats.some(v => v > 0)) items.push({ name: f.name, kind: 'Food', stats: f.stats.slice(), availability: f.availability || 0 });
  });
  memories.forEach(m => {
    if (m.stats.some(v => v > 0)) items.push({ name: m.name, kind: 'Memory', stats: m.stats.slice(), availability: m.availability || 0 });
  });
}

function startSolve() {
  if (currentTarget === null) return;
  const target = humans[currentTarget];

  // Read eco mode now — used throughout this function before the global is updated
  const pendingEcoMode = getEcoMode();

  // Build unified items and sort by specificity
  buildItems();

  const targetReqs = [];
  STAT_NAMES.forEach((_, si) => {
    if (target.stats[si] > 0) targetReqs.push([si, target.stats[si]]);
  });

  if (targetReqs.length === 0) { showToast('No stat requirements for this profession'); return; }

  const requiredSet = new Array(15).fill(false);
  targetReqs.forEach(([si]) => { requiredSet[si] = true; });

  // Pre-filter: remove items that don't contribute to any required stat
  items = items.filter(it => targetReqs.some(([si]) => it.stats[si] > 0));
  if (items.length === 0) { showToast('No items contribute to required stats'); return; }

  // Sort items by specificity (required contribution / (1 + extra contribution))
  items.sort((a, b) => {
    let aReq = 0, aExt = 0, bReq = 0, bExt = 0;
    for (let s = 0; s < 15; s++) {
      if (requiredSet[s]) { aReq += a.stats[s]; bReq += b.stats[s]; }
      else { aExt += a.stats[s]; bExt += b.stats[s]; }
    }
    return (bReq / (1 + bExt)) - (aReq / (1 + aExt));
  });

  // Best per stat
  const bestPerStat = new Array(15).fill(0);
  items.forEach(it => {
    for (let s = 0; s < 15; s++) bestPerStat[s] = Math.max(bestPerStat[s], it.stats[s]);
  });

  for (const [si, val] of targetReqs) {
    if (bestPerStat[si] <= 0) {
      showToast(`No item provides '${STAT_LABELS[STAT_NAMES[si]]}'. Infeasible.`);
      return;
    }
  }

  // Lower bound (>=: need total >= req)
  let initialLb = 1;
  for (const [si, val] of targetReqs) {
    initialLb = Math.max(initialLb, Math.ceil(val / bestPerStat[si]));
  }

  // Inherent subset count
  inherentCount = 0;
  humans.forEach((h, hi) => {
    const isSubset = STAT_NAMES.every((_, si) => {
      return h.stats[si] <= 0 || (target.stats[si] > 0 && h.stats[si] <= target.stats[si]);
    });
    if (hi === currentTarget || isSubset) inherentCount++;
  });

  // Resource limits — must match sorted items order
  const limits = getResourceLimits();
  const maxCounts = items.map(it => {
    if (it.kind === 'Food') {
      const fi = foods.findIndex(f => f.name === it.name);
      return fi >= 0 ? limits.foods[fi] : 9999;
    } else {
      const mi = memories.findIndex(m => m.name === it.name);
      return mi >= 0 ? limits.memories[mi] : 9999;
    }
  });

  // Inventory eco: also block items explicitly set to 0 even when unlimited-check is on
  if (pendingEcoMode === 2) {
    items.forEach((it, i) => {
      const datakind = it.kind === 'Food' ? 'food' : 'memory';
      const list     = it.kind === 'Food' ? foods : memories;
      const listIdx  = list.findIndex(x => x.name === it.name);
      if (listIdx >= 0) {
        const v = getInvValue(datakind, listIdx);
        // getInvValue returns 0 only when input is explicitly '0' (not empty)
        if (v === 0) maxCounts[i] = 0;
      }
    });
  }

  // Flatten item stats for workers
  const itemStatsForWorker = items.map(it => it.stats);
  const humanStatsForWorker = humans.map(h => h.stats);
  // For Inventory Eco (mode 2) use the entered inventory counts as the availability denominator
  let availabilityForWorker;
  if (pendingEcoMode === 2) {
    availabilityForWorker = items.map(it => {
      const kind = it.kind === 'Food' ? 'food' : 'memory';
      const list = it.kind === 'Food' ? foods : memories;
      const idx  = list.findIndex(x => x.name === it.name);
      if (idx < 0) return 0;
      const inp = document.querySelector(`.inv-item-input[data-kind="${kind}"][data-index="${idx}"]`);
      if (!inp || inp.value === '') return 0; // unlimited = no eco cost
      return parseInt(inp.value) || 0;
    });
  } else if (pendingEcoMode === 1) {
    // World Eco: the denominator is the world rarity (TotalAvailability / WorldCount).
    // But if the player's inventory shows MORE of an item than the world count says
    // exists, that higher number is the real ceiling — so use it as the denominator
    // (more abundant ⇒ lower cost). Empty/unlimited inventory leaves the world count
    // unchanged. Foods are craftable, so a stocked inventory naturally lifts their cap.
    availabilityForWorker = items.map(it => {
      const base = it.availability || 0;
      const kind = it.kind === 'Food' ? 'food' : 'memory';
      const list = it.kind === 'Food' ? foods : memories;
      const idx  = list.findIndex(x => x.name === it.name);
      if (idx < 0) return base;
      const inp = document.querySelector(`.inv-item-input[data-kind="${kind}"][data-index="${idx}"]`);
      if (!inp || inp.value === '') return base; // unset / unlimited → keep world count
      const inv = parseInt(inp.value) || 0;
      return Math.max(base, inv);
    });
  } else {
    availabilityForWorker = items.map(it => it.availability || 0);
  }

  const timeoutSec = parseInt(document.getElementById('timeout-input').value) || 30;
  let threads = parseInt(document.getElementById('threads-input').value) || 0;
  if (threads <= 0) threads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  numWorkers = Math.min(threads, items.length);

  const depthSetting = parseInt(document.getElementById('depth-input').value) || 0;
  const maxSearchDepth = depthSetting > 0 ? depthSetting : 100;
  currentMaxSearchDepth = maxSearchDepth;

  // Clamp maxCounts to maximum useful repetitions per item (>=: need total >= val)
  for (let i = 0; i < items.length; i++) {
    let maxUseful = 0;
    for (const [si, val] of targetReqs) {
      if (items[i].stats[si] > 0) {
        maxUseful = Math.max(maxUseful, Math.ceil(val / items[i].stats[si]));
      }
    }
    if (maxUseful > 0) maxCounts[i] = Math.min(maxCounts[i], maxUseful);
  }

  // Split first-item indices across workers (interleaved for load balancing)
  // Items with maxCounts=0 are completely excluded — they cannot appear in any solution
  const workerChunks = Array.from({ length: numWorkers }, () => []);
  let wi = 0;
  for (let i = 0; i < items.length; i++) {
    if (maxCounts[i] > 0) { workerChunks[wi % numWorkers].push(i); wi++; }
  }

  // If all workers ended up with no first items the problem is infeasible with this inventory
  if (wi === 0) { showToast('No usable items with current inventory — all counts are 0'); return; }

  // UI state
  solving = true;
  paused = false;
  totalPausedMs = 0;
  globalBest = null;
  markBoard(null); // clear last run's marks before the new search paints its own
  allSolutions = [];
  solutionIndex = 0;
  userBrowsingSolutions = false;
  ecoModeValue  = pendingEcoMode; // committed from the value read at the top of startSolve
  ecoModeActive = ecoModeValue > 0;
  cancelledByUser = false;
  workerNodes = new Array(numWorkers).fill(0);
  workerDepths = new Array(numWorkers).fill(0);
  maxDepthReached = 0;
  workersDone = 0;
  workersExhaustive = 0;
  document.getElementById('solve-btn').classList.add('hidden');
  document.getElementById('cancel-btn').classList.remove('hidden');
  document.getElementById('pause-btn').classList.remove('hidden');
  document.getElementById('pause-btn').textContent = 'Pause';
  document.getElementById('progress-card').classList.remove('hidden');
  document.getElementById('results-card').classList.add('hidden');
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-best').textContent = '';
  solveStart = performance.now();

  // Start progress timer
  solveTimer = setInterval(updateProgress, 200);

  // Spawn workers
  workers = [];
  for (let w = 0; w < numWorkers; w++) {
    const worker = new Worker('solver-worker.js');
    worker.onmessage = ((idx) => (e) => handleWorkerMsg(idx, e.data))(w);
    worker.onerror = () => {
      workersDone++;
      if (workersDone >= numWorkers) finishSolve();
    };
    worker.postMessage({
      type: 'solve',
      items: itemStatsForWorker,
      humans: humanStatsForWorker,
      targetReqs,
      bestPerStat,
      inherentCount,
      firstItems: workerChunks[w],
      initialLb,
      maxSearchDepth,
      maxCounts,
      timeoutSec,
      ecoMode: ecoModeActive,
      availability: availabilityForWorker,
    });
    workers.push(worker);
  }
}

// Rank one worker solution against another using the same objective order as the
// worker: collateral first, then overshoot (excess stats), then the cost/size
// tie-break (eco resourceCost, else item count). Returns true if `a` is better.
function solutionRanksBetter(a, b) {
  if (!b) return true;
  if (a.collateral !== b.collateral) return a.collateral < b.collateral;
  const ao = a.overshoot ?? Infinity, bo = b.overshoot ?? Infinity;
  if (ao !== bo) return ao < bo;
  return ecoModeActive
    ? (a.resourceCost || 0) < (b.resourceCost ?? Infinity)
    : a.items.length < b.items.length;
}

function handleWorkerMsg(workerIdx, msg) {
  if (!solving) return;
  switch (msg.type) {
    case 'progress':
      workerNodes[workerIdx] = msg.nodes;
      break;
    case 'newBest':
      if (!globalBest || solutionRanksBetter(msg.solution, globalBest)) {
        globalBest = msg.solution;
        allSolutions.push(msg.solution);
        if (!userBrowsingSolutions) {
          solutionIndex = allSolutions.length - 1;
          // Live results display (no scroll)
          const liveElapsed = (performance.now() - solveStart) / 1000;
          displayResults(liveElapsed, false);
        } else {
          // User is browsing older solutions — just update the nav counter
          updateSolutionNav();
        }
        if (globalBest.collateral <= inherentCount && !ecoModeActive) {
          // Perfect — stop all workers
          workers.forEach(w => w.postMessage({ type: 'stop' }));
        }
      }
      break;
    case 'depthDone':
      workerDepths[workerIdx] = msg.depth;
      if (msg.depth > maxDepthReached) maxDepthReached = msg.depth;
      workerNodes[workerIdx] = msg.nodes;
      break;
    case 'done':
      if (msg.solution) {
        if (!globalBest || solutionRanksBetter(msg.solution, globalBest)) {
          globalBest = msg.solution;
        }
      }
      workerNodes[workerIdx] = msg.nodes;
      workersDone++;
      if (msg.exhaustive) workersExhaustive++;
      if (workersDone >= numWorkers) {
        finishSolve();
      }
      break;
  }
}

function cancelSolve() {
  cancelledByUser = true;
  workers.forEach(w => w.postMessage({ type: 'stop' }));
  if (paused) {
    paused = false;
    totalPausedMs += performance.now() - pauseStart;
  }
  // Let done messages come in naturally, or force finish
  setTimeout(() => {
    if (solving) finishSolve();
  }, 500);
}

function togglePause() {
  if (!solving) return;
  if (paused) {
    // Resume
    paused = false;
    totalPausedMs += performance.now() - pauseStart;
    workers.forEach(w => w.postMessage({ type: 'resume' }));
    document.getElementById('pause-btn').textContent = 'Pause';
    solveTimer = setInterval(updateProgress, 200);
  } else {
    // Pause
    paused = true;
    pauseStart = performance.now();
    workers.forEach(w => w.postMessage({ type: 'pause' }));
    document.getElementById('pause-btn').textContent = 'Resume';
    clearInterval(solveTimer);
  }
}

function finishSolve() {
  solving = false;
  clearInterval(solveTimer);
  workers.forEach(w => w.terminate());
  workers = [];
  document.getElementById('solve-btn').classList.remove('hidden');
  document.getElementById('cancel-btn').classList.add('hidden');
  document.getElementById('pause-btn').classList.add('hidden');

  // Final progress update
  const elapsed = (performance.now() - solveStart) / 1000;
  document.getElementById('progress-bar').style.width = '100%';
  const totalNodes = workerNodes.reduce((a, b) => a + b, 0);
  document.getElementById('p-time').textContent = `Time: ${elapsed.toFixed(1)}s`;
  document.getElementById('p-nodes').textContent = `Nodes: ${formatNum(totalNodes)}`;
  const depthCompleted = maxDepthReached > 0 ? maxDepthReached : 0;
  let depthLabel;
  if (workersExhaustive >= numWorkers) {
    depthLabel = `Depth: ${depthCompleted} / ${currentMaxSearchDepth} \u2014 search complete`;
  } else if (globalBest && globalBest.collateral <= inherentCount) {
    depthLabel = `Depth: ${depthCompleted} / ${currentMaxSearchDepth} \u2014 optimal found, stopped early`;
  } else if (cancelledByUser) {
    depthLabel = `Depth: ${depthCompleted} / ${currentMaxSearchDepth} \u2014 cancelled`;
  } else {
    // Time limit: workers were searching depth depthCompleted+1 but didn't finish it
    const searchingDepth = depthCompleted + 1;
    depthLabel = `Depth: ${depthCompleted} / ${currentMaxSearchDepth} fully explored (interrupted at depth ${searchingDepth})`;
  }
  document.getElementById('p-depth').textContent = depthLabel;
  if (globalBest) {
    let bestText = `Best: ${globalBest.items.length} items, ${globalBest.collateral} profession${globalBest.collateral !== 1 ? 's' : ''} matched`;
    if (ecoModeActive && globalBest.resourceCost != null) {
      bestText += ` · draws ${(globalBest.resourceCost * 100).toFixed(1)}% of stock`;
    }
    document.getElementById('progress-best').textContent = bestText;
  }

  // Show final (best) results — reset to latest solution
  userBrowsingSolutions = false;
  if (allSolutions.length > 0) {
    solutionIndex = allSolutions.length - 1;
    globalBest = allSolutions[solutionIndex];
  }

  const finalState = cancelledByUser ? 'Stopped' : (globalBest ? 'Recipe found' : 'No recipe');
  const finalReadings = globalBest
    ? [`${globalBest.items.length} items`, `${globalBest.collateral} professions matched`, `${elapsed.toFixed(1)}s`]
    : [`${elapsed.toFixed(1)}s`];
  setStatus(finalState, finalReadings, false);

  displayResults(elapsed, true);
}

function updateProgress() {
  if (!solving) return;
  const elapsed = (performance.now() - solveStart) / 1000;
  updateProgressDisplay(elapsed);
}

function updateProgressDisplay(elapsed) {
  if (!elapsed) elapsed = (performance.now() - solveStart) / 1000;
  const timeout = parseInt(document.getElementById('timeout-input').value) || 30;
  let pausedMs = totalPausedMs;
  if (paused) pausedMs += performance.now() - pauseStart;
  const effectiveElapsed = elapsed - pausedMs / 1000;
  const pct = Math.min(100, (Math.max(0, effectiveElapsed) / timeout) * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('p-time').textContent = `Time: ${elapsed.toFixed(1)}s`;
  const activeDepths = workerDepths.filter(d => d > 0);
  if (activeDepths.length > 0) {
    const minD = Math.min(...activeDepths);
    const maxD = Math.max(...activeDepths);
    const depthStr = minD === maxD ? `${minD}` : `${minD}\u2013${maxD}`;
    document.getElementById('p-depth').textContent = `Depth: ${depthStr} / ${currentMaxSearchDepth}`;
  } else {
    document.getElementById('p-depth').textContent = `Depth: 1 / ${currentMaxSearchDepth}`;
  }
  const totalNodes = workerNodes.reduce((a, b) => a + b, 0);
  document.getElementById('p-nodes').textContent = `Nodes: ${formatNum(totalNodes)}`;

  const readings = [`${formatNum(totalNodes)} nodes`, `${elapsed.toFixed(1)}s`, `${numWorkers} workers`];
  if (globalBest) readings.push(`best: ${globalBest.collateral} matched`);
  setStatus(paused ? 'Paused' : 'Searching', readings, !paused);

  if (globalBest) {
    let bestText = `Current best: ${globalBest.items.length} items, ${globalBest.collateral} profession${globalBest.collateral !== 1 ? 's' : ''} matched`;
    if (ecoModeActive && globalBest.resourceCost != null) {
      bestText += ` · draws ${(globalBest.resourceCost * 100).toFixed(1)}% of stock`;
    }
    document.getElementById('progress-best').textContent = bestText;
  }
}

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ─── Results Display ─────────────────────────────────────────────────────────
function displayResults(elapsed, scroll) {
  const body = document.getElementById('results-body');
  const card = document.getElementById('results-card');
  card.classList.remove('hidden');

  if (!globalBest) {
    const allExhaustive = workersExhaustive >= numWorkers;
    const msg = allExhaustive
      ? 'No solution exists within search depth ' + currentMaxSearchDepth + ' (search space fully explored)'
      : 'No solution found within time limit';
    body.innerHTML = `<div class="result-summary no-solution">
      <span class="result-badge">${esc(msg)}</span></div>`;
    return;
  }

  const sol = globalBest;
  const target = humans[currentTarget];

  // Count items
  const counts = {};
  sol.items.forEach(idx => {
    const it = items[idx];
    const key = `${it.kind}:${it.name}`;
    if (!counts[key]) counts[key] = { name: it.name, kind: it.kind, count: 0, availability: it.availability || 0, stats: it.stats };
    counts[key].count++;
  });

  // Annotate each counted item with the user's inventory count (for inventory eco display)
  Object.values(counts).forEach(c => {
    const datakind = c.kind === 'Food' ? 'food' : 'memory';
    const list = c.kind === 'Food' ? foods : memories;
    const idx = list.findIndex(x => x.name === c.name);
    if (idx >= 0) {
      const v = getInvValue(datakind, idx);
      c.invCount = v >= 9999 ? null : v; // null = not set / unlimited
    } else {
      c.invCount = null;
    }
  });

  const foodItems = Object.values(counts).filter(c => c.kind === 'Food');
  const memItems = Object.values(counts).filter(c => c.kind === 'Memory');

  // Target requirements
  const targetReqs = [];
  STAT_NAMES.forEach((_, si) => {
    if (target.stats[si] > 0) targetReqs.push([si, target.stats[si]]);
  });
  const requiredSet = new Set(targetReqs.map(([si]) => si));

  // Matched professions
  const matched = [];
  humans.forEach((h, hi) => {
    let valid = true;
    for (let s = 0; s < 15; s++) {
      if (h.stats[s] > 0 && sol.total[s] < h.stats[s]) { valid = false; break; }
    }
    if (valid) {
      const isTarget = hi === currentTarget;
      const isInherent = !isTarget && STAT_NAMES.every((_, si) =>
        h.stats[si] <= 0 || (target.stats[si] > 0 && h.stats[si] <= target.stats[si]));
      matched.push({ profession: h.profession, category: h.category, isTarget, isInherent });
    }
  });

  let badgeExtra = '';
  if (ecoModeActive && sol.resourceCost != null) {
    const costTooltip = ecoModeValue === 2
      ? 'Resource cost: items used relative to your inventory counts. Lower means less personal inventory impact.'
      : 'Resource cost: items used relative to their world availability. Lower means less impact on shared resources.';
    const costLabel = ecoModeValue === 2 ? 'of your stock' : 'of world stock';
    badgeExtra = ` &mdash; <span class="resource-cost-badge" title="${costTooltip}">draws ${(sol.resourceCost * 100).toFixed(1)}% ${costLabel}</span>`;
  }
  let html = `<div class="result-summary">
    <span class="result-badge">${sol.items.length} item${sol.items.length !== 1 ? 's' : ''} &mdash; matches ${sol.collateral} profession${sol.collateral !== 1 ? 's' : ''}${badgeExtra}</span>
  </div>`;

  // Recipe
  if (foodItems.length > 0) {
    html += `<div class="result-section">
      <div class="result-section-title">Foods (${foodItems.reduce((a,c)=>a+c.count,0)} items)</div>
      <div class="recipe-items">${foodItems.map(c => recipeItemHTML(c)).join('')}</div></div>`;
  }
  if (memItems.length > 0) {
    html += `<div class="result-section">
      <div class="result-section-title">Memories (${memItems.reduce((a,c)=>a+c.count,0)} items)</div>
      <div class="recipe-items">${memItems.map(c => recipeItemHTML(c)).join('')}</div></div>`;
  }

  // Build per-stat item breakdown for tooltips
  const statBreakdown = {};
  sol.items.forEach(idx => {
    const it = items[idx];
    for (let si = 0; si < 15; si++) {
      if (it.stats[si] !== 0) {
        if (!statBreakdown[si]) statBreakdown[si] = {};
        if (!statBreakdown[si][it.name]) statBreakdown[si][it.name] = 0;
        statBreakdown[si][it.name] += it.stats[si];
      }
    }
  });

  // Stats
  html += `<div class="result-section"><div class="result-section-title">Stats Achieved</div><table class="stats-table">`;
  targetReqs.forEach(([si, req]) => {
    const val = sol.total[si];
    const ok = val >= req;
    const cls = ok ? (val > req ? 'stat-over' : 'stat-ok') : 'stat-miss';
    // Build breakdown tooltip
    let breakdown = '';
    if (statBreakdown[si]) {
      const parts = Object.entries(statBreakdown[si]).map(([name, v]) => `${name}: +${v}`);
      breakdown = esc(parts.join('\n'));
    }
    html += `<tr title="${breakdown}">
      <td class="stat-name">${STAT_LABELS[STAT_NAMES[si]]}</td>
      <td class="stat-val ${cls}">${Math.round(val)}</td>
      <td class="stat-target">need ${Math.round(req)}</td>
      <td class="stat-check">${ok ? '✓' : '✗'}</td></tr>`;
  });
  html += '</table></div>';

  // Side-effect stats
  const sideEffects = [];
  for (let s = 0; s < 15; s++) {
    if (!requiredSet.has(s) && sol.total[s] > 0) {
      sideEffects.push(`${STAT_LABELS[STAT_NAMES[s]]}=${Math.round(sol.total[s])}`);
    }
  }
  if (sideEffects.length > 0) {
    html += `<div class="result-section"><div class="result-section-title">Side-effect Stats</div>
      <div class="side-effects">${sideEffects.map(s => `<span class="side-effect-tag">${s}</span>`).join('')}</div></div>`;
  }

  // Matched professions
  matched.sort((a, b) => {
    if (a.isTarget) return -1; if (b.isTarget) return 1;
    if (a.isInherent && !b.isInherent) return -1;
    if (!a.isInherent && b.isInherent) return 1;
    return 0;
  });

  const targetAndInherent = matched.filter(m => m.isTarget || m.isInherent);
  const avoidable = matched.filter(m => !m.isTarget && !m.isInherent);

  html += `<div class="result-section"><div class="result-section-title">Professions Matched (${matched.length})</div>`;
  if (matched.length > 1) {
    html += `<div class="info-box" style="margin-bottom:8px">When multiple professions match, the game\u2019s selection is currently unclear (possibly random). Hover over each entry for details.</div>`;
  }

  // Target + inherent professions (always visible)
  html += `<div class="profession-list">`;
  targetAndInherent.forEach(m => {
    html += profItemHTML(m);
  });
  html += '</div>';

  // Avoidable professions (collapsible if > 3)
  if (avoidable.length > 0) {
    const collapsed = avoidable.length > 3;
    html += `<button class="avoidable-toggle${collapsed ? '' : ' open'}" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('collapsed')">
      <span class="avoidable-toggle-icon">\u25B6</span>
      Can be avoided (${avoidable.length})
    </button>`;
    html += `<div class="profession-list avoidable-list${collapsed ? ' collapsed' : ''}">`;
    avoidable.forEach(m => {
      html += profItemHTML(m);
    });
    html += '</div>';

    // If search was cut short by timeout, suggest increasing it
    const wasExhaustive = workersExhaustive >= numWorkers;
    if (!wasExhaustive && !cancelledByUser) {
      html += `<div class="info-box timeout-hint" style="margin-top:8px">
        \u23F1 The search timed out before fully exploring all possibilities.
        A longer <strong>Timeout</strong> (Settings) may find a more specific recipe that avoids
        some of these ${avoidable.length} profession${avoidable.length !== 1 ? 's' : ''}.
      </div>`;
    }
  }
  html += '</div>';

  // Search info
  const totalN = workerNodes.reduce((a, b) => a + b, 0);
  html += `<div class="search-time">Search: ${elapsed.toFixed(2)}s &bull; Nodes: ${formatNum(totalN)} &bull; Workers: ${numWorkers}</div>`;

  body.innerHTML = html;

  // Light the board so the taxonomy above shows what this recipe would produce.
  markBoard(matched);

  // Show apply button if inventory is limited
  const applyWrap = document.getElementById('apply-solution-wrap');
  const unlimited = document.getElementById('unlimited-check').checked;
  if (!unlimited && globalBest) {
    applyWrap.classList.remove('hidden');
  } else {
    applyWrap.classList.add('hidden');
  }

  // Scroll to results (only on explicit request, e.g. final results)
  if (scroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update solution navigation header
  updateSolutionNav();
}

function updateSolutionNav() {
  const navEl = document.getElementById('solution-nav');
  if (!navEl) return;
  if (allSolutions.length <= 1) {
    navEl.classList.add('hidden');
    return;
  }
  navEl.classList.remove('hidden');
  document.getElementById('sol-nav-label').textContent = `${solutionIndex + 1} / ${allSolutions.length}`;
  document.getElementById('sol-prev').disabled = solutionIndex <= 0;
  document.getElementById('sol-next').disabled = solutionIndex >= allSolutions.length - 1;
}

function navigateSolution(delta) {
  const newIdx = solutionIndex + delta;
  if (newIdx < 0 || newIdx >= allSolutions.length) return;
  solutionIndex = newIdx;
  userBrowsingSolutions = solutionIndex < allSolutions.length - 1;
  globalBest = allSolutions[solutionIndex];
  const elapsed = (performance.now() - solveStart) / 1000;
  displayResults(elapsed, false);
}

function recipeItemHTML(c) {
  const imgUrl = getItemImageUrl(c.name);
  // Build stat tooltip
  const statParts = [];
  if (c.stats) {
    c.stats.forEach((v, si) => {
      if (v !== 0) statParts.push(`${STAT_LABELS[STAT_NAMES[si]]}: ${v}`);
    });
  }
  const tooltip = statParts.length > 0 ? esc(statParts.join('\n')) : '';
  let pctHtml = '';
  if (ecoModeActive) {
    if (ecoModeValue === 2) {
      // Inventory eco: denominator is the user's own inventory count
      if (c.invCount !== null && c.invCount > 0) {
        const pct = (c.count / c.invCount * 100).toFixed(1);
        pctHtml = `<span class="recipe-item-pct" title="Using ${c.count} of ${c.invCount} in your inventory (${pct}%)">(${pct}%)</span>`;
      }
    } else {
      // World eco: denominator is global world availability
      if (c.availability > 0) {
        const pct = (c.count / c.availability * 100).toFixed(1);
        pctHtml = `<span class="recipe-item-pct" title="Using ${c.count} of ${Math.round(c.availability)} available worldwide (${pct}%)">(${pct}%)</span>`;
      }
    }
  }
  return `<div class="recipe-item" title="${tooltip}">
    <img class="recipe-item-img" src="${imgUrl}" alt="${esc(c.name)}"
         onerror="this.style.display='none'">
    <span class="recipe-item-count">${c.count}×</span>
    <span class="recipe-item-name">${esc(c.name)}</span>${pctHtml}</div>`;
}

function profItemHTML(m) {
  const dotCls = m.isTarget ? 'target' : m.isInherent ? 'inherent' : 'avoidable';
  const tag = m.isTarget ? 'TARGET' : m.isInherent ? 'inherent subset' : 'AVOIDABLE';
  const tooltip = m.isTarget
    ? 'This is your selected target profession.'
    : m.isInherent
      ? 'This profession\u2019s requirements are a subset of your target \u2014 it will always match regardless of recipe.'
      : 'This profession matched due to side-effect stats. A better recipe might avoid it.';
  return `<div class="prof-item" title="${esc(tooltip)}">
    <span class="prof-dot ${dotCls}"></span>
    <span class="prof-name">${esc(m.profession)}</span>
    <span class="prof-tag">(${esc(m.category)}) &mdash; ${tag}</span></div>`;
}

// ─── Apply Solution ──────────────────────────────────────────────────────────
function applySolution() {
  if (!globalBest || document.getElementById('unlimited-check').checked) return;

  // Count used items from solution
  const counts = {};
  globalBest.items.forEach(idx => {
    const it = items[idx];
    const key = `${it.kind}:${it.name}`;
    if (!counts[key]) counts[key] = { name: it.name, kind: it.kind, count: 0 };
    counts[key].count++;
  });

  // Subtract from inventory inputs
  for (const c of Object.values(counts)) {
    let list, datakind;
    if (c.kind === 'Food') { list = foods; datakind = 'food'; }
    else { list = memories; datakind = 'memory'; }
    const idx = list.findIndex(x => x.name === c.name);
    if (idx < 0) continue;
    const inp = document.querySelector(`.inv-item-input[data-kind="${datakind}"][data-index="${idx}"]`);
    if (!inp) continue;
    inp.value = subtractFromStock(inp.value, c.count);
  }

  document.getElementById('apply-solution-wrap').classList.add('hidden');
  persistInventory();
  showToast('Resources subtracted from inventory');
}

// ─── Eco Mode 3-way Switch ───────────────────────────────────────────────────
function getEcoMode() {
  const btn = document.querySelector('.eco-seg.active');
  return btn ? parseInt(btn.dataset.mode) : 0;
}

function setEcoMode(mode) {
  document.querySelectorAll('.eco-seg').forEach(btn => {
    const on = parseInt(btn.dataset.mode) === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

// ─── Inventory Persistence ───────────────────────────────────────────────────
function persistInventory() {
  const counts = { food: {}, memory: {} };
  document.querySelectorAll('.inv-item-input').forEach(inp => {
    if (inp.value === '') return;
    const list = inp.dataset.kind === 'food' ? foods : memories;
    const item = list[parseInt(inp.dataset.index)];
    if (item) counts[inp.dataset.kind][item.name] = parseInt(inp.value);
  });
  const unlimited = document.getElementById('unlimited-check').checked;
  const data = serializeInventory(counts, unlimited);
  try { localStorage.setItem('tlc_inventory', JSON.stringify(data)); } catch (e) { /* quota */ }
}

// ─── Status strip ────────────────────────────────────────────────────────────
// One line of machine voice under the header: state on the left, the readings
// behind it on the right. `busy` switches the dot from nominal to working.
function setStatus(state, readings, busy) {
  const strip = document.getElementById('status-strip');
  const text = document.getElementById('status-state-text');
  const out = document.getElementById('status-readings');
  if (!strip || !text || !out) return;
  text.textContent = state;
  out.innerHTML = (readings || []).map(r => `<span>${esc(r)}</span>`).join('');
  strip.classList.toggle('is-busy', !!busy);
}

function idleStatus() {
  const readings = [
    `${humans.length} professions`,
    `${foods.length} foods`,
    `${memories.length} memories`,
  ];
  if (currentTarget !== null) readings.unshift(humans[currentTarget].profession);
  setStatus(currentTarget === null ? 'Ready' : 'Target set', readings, false);
}

// ─── Theme ───────────────────────────────────────────────────────────────────
// An explicit choice is stored and wins; with nothing stored the page follows
// the OS via prefers-color-scheme (the inline script in index.html applies any
// stored value before first paint, so there is no flash of the wrong theme).
function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  try { localStorage.setItem('tlc_theme', theme); } catch (e) { /* storage blocked */ }
}

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
}

// ─── Toggle Helpers ──────────────────────────────────────────────────────────
function setupToggle(btnId, bodyId) {
  const btn = document.getElementById(btnId);
  const body = document.getElementById(bodyId);
  btn.setAttribute('aria-expanded', String(!body.classList.contains('hidden')));
  btn.addEventListener('click', () => {
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
    btn.setAttribute('aria-expanded', String(!open));
  });
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.edit-tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
  } catch (err) {
    showToast('Failed to load data: ' + err.message);
    return;
  }

  populateDropdown();
  buildInventory();
  buildEditTables();

  // Event listeners
  initTheme();
  initCombobox();
  document.getElementById('solve-btn').addEventListener('click', startSolve);
  document.getElementById('cancel-btn').addEventListener('click', cancelSolve);
  document.getElementById('pause-btn').addEventListener('click', togglePause);
  document.getElementById('unlimited-check').addEventListener('change', () => {
    toggleUnlimited(true); // real click: seed empty fields with 0
    persistInventory();
  });
  document.getElementById('save-inv-btn').addEventListener('click', saveInventory);
  document.getElementById('load-inv-btn').addEventListener('click', () => loadInventory());
  document.getElementById('inv-csv-upload').addEventListener('change', function() { handleInvCSVUpload(this.files[0]); });
  document.getElementById('reset-inv-btn').addEventListener('click', resetInventory);
  document.getElementById('dl-food').addEventListener('click', downloadFoodCSV);
  document.getElementById('dl-memories').addEventListener('click', downloadMemoriesCSV);
  document.getElementById('dl-humans').addEventListener('click', downloadHumansCSV);
  document.getElementById('ul-food').addEventListener('change', function() { uploadCSV(this, uploadFoodCSV); });
  document.getElementById('ul-memories').addEventListener('change', function() { uploadCSV(this, uploadMemoriesCSV); });
  document.getElementById('ul-humans').addEventListener('change', function() { uploadCSV(this, uploadHumansCSV); });
  document.getElementById('add-food').addEventListener('click', addFood);
  document.getElementById('add-memory').addEventListener('click', addMemory);
  document.getElementById('add-human').addEventListener('click', addHuman);
  document.getElementById('apply-solution-btn').addEventListener('click', applySolution);
  document.getElementById('sol-prev').addEventListener('click', () => navigateSolution(-1));
  document.getElementById('sol-next').addEventListener('click', () => navigateSolution(1));

  setupToggle('inventory-toggle', 'inventory-body');
  setupToggle('edit-toggle', 'edit-body');
  setupToggle('settings-toggle', 'settings-body');
  setupTabs();

  // 3-way eco mode switch
  document.querySelectorAll('.eco-seg').forEach(btn => {
    btn.addEventListener('click', () => setEcoMode(parseInt(btn.dataset.mode)));
  });

  // Keyboard: Enter triggers solve
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.matches('input, select, textarea') && !solving && currentTarget !== null) {
      startSolve();
    }
  });

  // Try loading saved inventory on start
  if (localStorage.getItem('tlc_inventory')) {
    loadInventory(true);
  }

  idleStatus();
  loadFooterVersion();
}

document.addEventListener('DOMContentLoaded', init);
