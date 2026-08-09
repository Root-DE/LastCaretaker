// inventory-storage.js — persistence format for the Resource Inventory.
//
// Loaded as a plain <script> by both index.html and tests.html (no modules, no
// build step), so the tests exercise the shipped code rather than a copy.
//
// Counts are stored by item NAME. Version 1 keyed them by position in the
// foods/memories list, which meant adding an item to data/*.csv shifted every
// later count onto the wrong item; migrateInventoryData converts v1 blobs on
// read, using the list order the reader currently has.

const INVENTORY_STORAGE_VERSION = 2;

// The foods/memories order as it stood when v1 blobs were written. A v1 blob's
// keys are positions in *these* lists, so the conversion is pinned to this
// snapshot rather than to the live data — otherwise every later edit to
// data/*.csv would change how old inventories are read. Frozen: do not edit,
// and do not extend it when adding items.
const LEGACY_V1_ORDER = {
  food: [
    'High-Fat',
    'Mind Surge',
    'Nutri-Core',
    'Physique Fuel',
    'Bone-Fortify',
    'Endura-Growth',
    'Immune Boost',
    'Muscle Fortification',
    'Neuro-Boost',
    'Hyper-Evolution',
    'Mitochondrial Surge',
    'Nanite Infusion',
    'Ultimate Genesis',
  ],
  memory: [
    'Ash Notebook',
    'Assembly Instructions',
    'Basketball',
    'Biology Notes',
    'Blueprints',
    'Bowling Ball',
    'Bowling Pin',
    'Camera',
    'Cards',
    'Cognitive Cards',
    "Commander's Log",
    'Compass',
    'Crayon',
    'Encyclopedia',
    'First Aid',
    'Guitar',
    'Love Letters',
    'Maps',
    'Meditation',
    'Mirror',
    'Music Notes',
    'Mystery Box',
    'PECO Athletics - 100m Dash',
    'PECO Athletics - Javelin',
    'PECO Athletics - Triple Jump',
    'Plans',
    'Porcine Vocal Interface',
    'Programming Manual',
    'Small Human Art',
    'Small Tree',
    'Stopwatch',
    'Sudoku Book',
    'Survival Diagrams',
    'Teddy Bear',
    'The Art of War',
    'Tommy',
    'Travel Journal',
    "Where's Tommy",
  ],
};

// Read a stored blob into { unlimited, counts: { food: {name: n}, memory: {name: n} } }.
// `unlimited` is null when the blob does not record the setting. Unknown item
// names are kept: an item that is temporarily absent from the data keeps its
// count instead of silently losing it.
function migrateInventoryData(data, foodNames, memoryNames) {
  if (foodNames === undefined) foodNames = LEGACY_V1_ORDER.food;
  if (memoryNames === undefined) memoryNames = LEGACY_V1_ORDER.memory;
  const out = { unlimited: null, counts: { food: {}, memory: {} } };
  if (!data || typeof data !== 'object') return out;
  if (data._unlimited !== undefined) out.unlimited = !!data._unlimited;

  if (data._v >= 2) {
    ['food', 'memory'].forEach(kind => {
      const src = data[kind];
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(name => {
        const n = parseInt(src[name], 10);
        if (Number.isFinite(n)) out.counts[kind][name] = n;
      });
    });
    return out;
  }

  // v1: keys are `<kind>_<listIndex>` against the list order at write time.
  const lists = { food: foodNames || [], memory: memoryNames || [] };
  Object.keys(data).forEach(key => {
    const m = /^(food|memory)_(\d+)$/.exec(key);
    if (!m) return;
    const name = lists[m[1]][parseInt(m[2], 10)];
    if (name === undefined) return; // stale index — drop rather than misapply
    const n = parseInt(data[key], 10);
    if (Number.isFinite(n)) out.counts[m[1]][name] = n;
  });
  return out;
}

// Build the blob to persist from name-keyed counts.
function serializeInventory(counts, unlimited) {
  const blob = { _v: INVENTORY_STORAGE_VERSION, _unlimited: !!unlimited, food: {}, memory: {} };
  ['food', 'memory'].forEach(kind => {
    const src = (counts && counts[kind]) || {};
    Object.keys(src).forEach(name => {
      const n = parseInt(src[name], 10);
      if (Number.isFinite(n)) blob[kind][name] = n;
    });
  });
  return blob;
}
