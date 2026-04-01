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
let maxDepthReached = 0;
let workersDone = 0;
let numWorkers = 0;
let inherentCount = 0;
let currentTarget = null;

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
  }));

  const mCSV = parseCSV(mText);
  memories = mCSV.rows.map(r => ({
    name: normalize(r['Memory'] || ''),
    stats: memoryStats(r),
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
    return;
  }
  currentTarget = idx;
  solveBtn.disabled = false;
  showRequirements(idx);
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

  inhDiv.innerHTML = `<div class="analysis-label">Always matched (${inherentList.length}):</div>
    <div class="analysis-list">${inherentList.map(h =>
      `<span class="analysis-tag inherent">${esc(h.profession)}</span>`).join('')}</div>`;

  avoDiv.innerHTML = `<div class="analysis-label">Can be avoided (${avoidableList.length}):</div>
    <div class="analysis-list">${avoidableList.map(h =>
      `<span class="analysis-tag avoidable">${esc(h.profession)}</span>`).join('')}</div>`;

  ap.classList.remove('hidden');
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
  });
}

function getResourceLimits() {
  const unlimited = document.getElementById('unlimited-check').checked;
  const limits = { foods: [], memories: [] };
  foods.forEach((_, i) => limits.foods.push(unlimited ? 9999 : getInvValue('food', i)));
  memories.forEach((_, i) => limits.memories.push(unlimited ? 9999 : getInvValue('memory', i)));
  return limits;
}

function getInvValue(kind, index) {
  const inp = document.querySelector(`.inv-item-input[data-kind="${kind}"][data-index="${index}"]`);
  if (!inp || inp.value === '') return 9999; // unlimited
  return parseInt(inp.value) || 0;
}

function saveInventory() {
  const data = {};
  document.querySelectorAll('.inv-item-input').forEach(inp => {
    const key = `${inp.dataset.kind}_${inp.dataset.index}`;
    data[key] = inp.value;
  });
  data._unlimited = document.getElementById('unlimited-check').checked;
  localStorage.setItem('tlc_inventory', JSON.stringify(data));
  showToast('Inventory saved');
}

function loadInventory(silent) {
  const raw = localStorage.getItem('tlc_inventory');
  if (!raw) { if (!silent) showToast('No saved inventory found'); return; }
  const data = JSON.parse(raw);
  if (data._unlimited !== undefined) {
    document.getElementById('unlimited-check').checked = data._unlimited;
    toggleUnlimited();
  }
  document.querySelectorAll('.inv-item-input').forEach(inp => {
    const key = `${inp.dataset.kind}_${inp.dataset.index}`;
    if (data[key] !== undefined) inp.value = data[key];
  });
  if (!silent) showToast('Inventory loaded');
}

function resetInventory() {
  document.getElementById('unlimited-check').checked = true;
  toggleUnlimited();
  document.querySelectorAll('.inv-item-input').forEach(inp => { inp.value = ''; });
  showToast('Inventory reset');
}

function toggleUnlimited() {
  const checked = document.getElementById('unlimited-check').checked;
  document.getElementById('inventory-limited').classList.toggle('hidden', checked);
  if (!checked) {
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
  html += '</tr></thead><tbody>';
  foods.forEach((f, fi) => {
    html += `<tr><td>${esc(f.name)}</td>`;
    statCols.forEach(s => {
      const si = STAT_NAMES.indexOf(s);
      html += `<td><input type="number" value="${f.stats[si] || ''}" min="0"
                data-type="food" data-index="${fi}" data-stat="${si}"></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      foods[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
}

function buildMemoryTable() {
  const statCols = ['adaptability','communication','creativity','disipline','empathy',
                    'focus','intellect','leadership','logic','patience','wisdom'];
  const wrap = document.getElementById('memory-table-wrap');
  let html = '<table class="edit-table"><thead><tr><th>Memory</th>';
  statCols.forEach(s => { html += `<th>${STAT_LABELS[s]}</th>`; });
  html += '</tr></thead><tbody>';
  memories.forEach((m, mi) => {
    html += `<tr><td>${esc(m.name)}</td>`;
    statCols.forEach(s => {
      const si = STAT_NAMES.indexOf(s);
      html += `<td><input type="number" value="${m.stats[si] || ''}" min="0"
                data-type="memory" data-index="${mi}" data-stat="${si}"></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      memories[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
}

function buildHumanTable() {
  const wrap = document.getElementById('human-table-wrap');
  let html = '<table class="edit-table"><thead><tr><th>Profession</th><th>Category</th>';
  STAT_NAMES.forEach(s => { html += `<th>${STAT_LABELS[s]}</th>`; });
  html += '</tr></thead><tbody>';
  humans.forEach((h, hi) => {
    html += `<tr><td>${esc(h.profession)}</td><td>${esc(h.category)}</td>`;
    STAT_NAMES.forEach((s, si) => {
      html += `<td><input type="number" value="${h.stats[si] || ''}" min="0"
                data-type="human" data-index="${hi}" data-stat="${si}"></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      humans[parseInt(inp.dataset.index)].stats[parseInt(inp.dataset.stat)] = parseFloat(inp.value) || 0;
    });
  });
}

// ─── CSV Download ────────────────────────────────────────────────────────────
function downloadFoodCSV() {
  const foodStatCols = [
    {key:'Height',si:1},{key:'Intellect',si:4},{key:'Life Exp',si:2},
    {key:'Strength',si:3},{key:'Weight',si:0},
  ];
  let csv = 'Food;' + foodStatCols.map(c=>c.key).join(';') + '\n';
  foods.forEach(f => {
    csv += f.name + ';' + foodStatCols.map(c => f.stats[c.si] || '').join(';') + '\n';
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
  let csv = 'Memory;' + memCols.map(c=>c.key).join(';') + '\n';
  memories.forEach(m => {
    csv += m.name + ';' + memCols.map(c => m.stats[c.si] || '').join(';') + '\n';
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
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

// ─── Solver Management ───────────────────────────────────────────────────────
function buildItems() {
  items = [];
  foods.forEach(f => {
    if (f.stats.some(v => v > 0)) items.push({ name: f.name, kind: 'Food', stats: f.stats.slice() });
  });
  memories.forEach(m => {
    if (m.stats.some(v => v > 0)) items.push({ name: m.name, kind: 'Memory', stats: m.stats.slice() });
  });
}

function startSolve() {
  if (currentTarget === null) return;
  const target = humans[currentTarget];

  // Build unified items and sort by specificity
  buildItems();

  const targetReqs = [];
  STAT_NAMES.forEach((_, si) => {
    if (target.stats[si] > 0) targetReqs.push([si, target.stats[si]]);
  });

  if (targetReqs.length === 0) { showToast('No stat requirements for this profession'); return; }

  const requiredSet = new Array(15).fill(false);
  targetReqs.forEach(([si]) => { requiredSet[si] = true; });

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

  // Lower bound
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

  // Flatten item stats for workers
  const itemStatsForWorker = items.map(it => it.stats);
  const humanStatsForWorker = humans.map(h => h.stats);

  const timeoutSec = parseInt(document.getElementById('timeout-input').value) || 120;
  let threads = parseInt(document.getElementById('threads-input').value) || 0;
  if (threads <= 0) threads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  numWorkers = Math.min(threads, items.length);

  const maxSearchDepth = initialLb + 20;

  // Split first-item indices across workers (interleaved for load balancing)
  const workerChunks = Array.from({ length: numWorkers }, () => []);
  for (let i = 0; i < items.length; i++) {
    workerChunks[i % numWorkers].push(i);
  }

  // UI state
  solving = true;
  paused = false;
  totalPausedMs = 0;
  globalBest = null;
  workerNodes = new Array(numWorkers).fill(0);
  maxDepthReached = 0;
  workersDone = 0;
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
    });
    workers.push(worker);
  }
}

function handleWorkerMsg(workerIdx, msg) {
  if (!solving) return;
  switch (msg.type) {
    case 'progress':
      workerNodes[workerIdx] = msg.nodes;
      break;
    case 'newBest':
      if (!globalBest || msg.solution.collateral < globalBest.collateral ||
          (msg.solution.collateral === globalBest.collateral && msg.solution.items.length < globalBest.items.length)) {
        globalBest = msg.solution;
        // Live results display
        const liveElapsed = (performance.now() - solveStart) / 1000;
        displayResults(liveElapsed);
        if (globalBest.collateral <= inherentCount) {
          // Perfect — stop all workers
          workers.forEach(w => w.postMessage({ type: 'stop' }));
        }
      }
      break;
    case 'depthDone':
      if (msg.depth > maxDepthReached) maxDepthReached = msg.depth;
      workerNodes[workerIdx] = msg.nodes;
      break;
    case 'done':
      if (msg.solution) {
        if (!globalBest || msg.solution.collateral < globalBest.collateral ||
            (msg.solution.collateral === globalBest.collateral && msg.solution.items.length < globalBest.items.length)) {
          globalBest = msg.solution;
        }
      }
      workerNodes[workerIdx] = msg.nodes;
      workersDone++;
      if (workersDone >= numWorkers) {
        finishSolve();
      }
      break;
  }
}

function cancelSolve() {
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
  updateProgressDisplay(elapsed);

  // Show results
  displayResults(elapsed);
}

function updateProgress() {
  if (!solving) return;
  const elapsed = (performance.now() - solveStart) / 1000;
  updateProgressDisplay(elapsed);
}

function updateProgressDisplay(elapsed) {
  if (!elapsed) elapsed = (performance.now() - solveStart) / 1000;
  const timeout = parseInt(document.getElementById('timeout-input').value) || 120;
  const pct = Math.min(100, (elapsed / timeout) * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('p-time').textContent = `Time: ${elapsed.toFixed(1)}s`;
  document.getElementById('p-depth').textContent = maxDepthReached > 0 ? `Depth: ${maxDepthReached}` : 'Depth: —';
  const totalNodes = workerNodes.reduce((a, b) => a + b, 0);
  document.getElementById('p-nodes').textContent = `Nodes: ${formatNum(totalNodes)}`;
  if (globalBest) {
    document.getElementById('progress-best').textContent =
      `Current best: ${globalBest.items.length} items, ${globalBest.collateral} profession${globalBest.collateral !== 1 ? 's' : ''} matched`;
  }
}

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ─── Results Display ─────────────────────────────────────────────────────────
function displayResults(elapsed) {
  const body = document.getElementById('results-body');
  const card = document.getElementById('results-card');
  card.classList.remove('hidden');

  if (!globalBest) {
    body.innerHTML = `<div class="result-summary no-solution">
      <span class="result-badge">No solution found within time limit</span></div>`;
    return;
  }

  const sol = globalBest;
  const target = humans[currentTarget];

  // Count items
  const counts = {};
  sol.items.forEach(idx => {
    const it = items[idx];
    const key = `${it.kind}:${it.name}`;
    if (!counts[key]) counts[key] = { name: it.name, kind: it.kind, count: 0 };
    counts[key].count++;
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

  let html = `<div class="result-summary">
    <span class="result-badge">${sol.items.length} item${sol.items.length !== 1 ? 's' : ''} &mdash; matches ${sol.collateral} profession${sol.collateral !== 1 ? 's' : ''}</span>
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

  // Stats
  html += `<div class="result-section"><div class="result-section-title">Stats Achieved</div><table class="stats-table">`;
  targetReqs.forEach(([si, req]) => {
    const val = sol.total[si];
    const ok = val >= req;
    const cls = ok ? (val > req ? 'stat-over' : 'stat-ok') : 'stat-miss';
    html += `<tr>
      <td class="stat-name">${STAT_LABELS[STAT_NAMES[si]]}</td>
      <td class="stat-val ${cls}">${Math.round(val)}</td>
      <td>/ ${Math.round(req)}</td>
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
  html += `<div class="result-section"><div class="result-section-title">Professions Matched (${matched.length})</div>
    <div class="profession-list">`;
  // Sort: target first, then inherent, then avoidable
  matched.sort((a, b) => {
    if (a.isTarget) return -1; if (b.isTarget) return 1;
    if (a.isInherent && !b.isInherent) return -1;
    if (!a.isInherent && b.isInherent) return 1;
    return 0;
  });
  matched.forEach(m => {
    const dotCls = m.isTarget ? 'target' : m.isInherent ? 'inherent' : 'avoidable';
    const tag = m.isTarget ? 'TARGET' : m.isInherent ? 'inherent subset' : 'AVOIDABLE';
    html += `<div class="prof-item">
      <span class="prof-dot ${dotCls}"></span>
      <span class="prof-name">${esc(m.profession)}</span>
      <span class="prof-tag">(${esc(m.category)}) &mdash; ${tag}</span></div>`;
  });
  html += '</div></div>';

  // Search info
  const totalN = workerNodes.reduce((a, b) => a + b, 0);
  html += `<div class="search-time">Search: ${elapsed.toFixed(2)}s &bull; Nodes: ${formatNum(totalN)} &bull; Workers: ${numWorkers}</div>`;

  body.innerHTML = html;

  // Scroll to results
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function recipeItemHTML(c) {
  const imgUrl = getItemImageUrl(c.name);
  return `<div class="recipe-item">
    <img class="recipe-item-img" src="${imgUrl}" alt="${esc(c.name)}"
         onerror="this.style.display='none'">
    <span class="recipe-item-count">${c.count}×</span>
    <span class="recipe-item-name">${esc(c.name)}</span></div>`;
}

// ─── Toggle Helpers ──────────────────────────────────────────────────────────
function setupToggle(btnId, bodyId) {
  const btn = document.getElementById(btnId);
  const body = document.getElementById(bodyId);
  btn.addEventListener('click', () => {
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
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
  document.getElementById('profession-select').addEventListener('change', onProfessionChange);
  document.getElementById('solve-btn').addEventListener('click', startSolve);
  document.getElementById('cancel-btn').addEventListener('click', cancelSolve);
  document.getElementById('pause-btn').addEventListener('click', togglePause);
  document.getElementById('unlimited-check').addEventListener('change', toggleUnlimited);
  document.getElementById('save-inv-btn').addEventListener('click', saveInventory);
  document.getElementById('load-inv-btn').addEventListener('click', () => loadInventory());
  document.getElementById('reset-inv-btn').addEventListener('click', resetInventory);
  document.getElementById('dl-food').addEventListener('click', downloadFoodCSV);
  document.getElementById('dl-memories').addEventListener('click', downloadMemoriesCSV);
  document.getElementById('dl-humans').addEventListener('click', downloadHumansCSV);
  document.getElementById('ul-food').addEventListener('change', function() { uploadCSV(this, uploadFoodCSV); });
  document.getElementById('ul-memories').addEventListener('change', function() { uploadCSV(this, uploadMemoriesCSV); });
  document.getElementById('ul-humans').addEventListener('change', function() { uploadCSV(this, uploadHumansCSV); });

  setupToggle('inventory-toggle', 'inventory-body');
  setupToggle('edit-toggle', 'edit-body');
  setupToggle('settings-toggle', 'settings-body');
  setupTabs();

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
}

document.addEventListener('DOMContentLoaded', init);
