#!/usr/bin/env node
// build-wasm.js — Compile wasm/solver-kernel.wat to solver-kernel.wasm.
//
// The .wat file is the reviewable source of truth; this script produces the
// binary the app actually loads. Run it after editing the .wat:
//
//   npm run build:wasm
//
// CI runs this and then checks `git diff --exit-code solver-kernel.wasm`, so the
// committed binary is guaranteed to match the reviewed .wat source.

const fs = require('fs');
const path = require('path');
const wabtInit = require('wabt');

const ROOT = path.resolve(__dirname, '..');
const WAT_PATH = path.join(ROOT, 'wasm', 'solver-kernel.wat');
const WASM_PATH = path.join(ROOT, 'solver-kernel.wasm');

(async () => {
  const wabt = await wabtInit();
  const watSource = fs.readFileSync(WAT_PATH, 'utf8');

  let mod;
  try {
    mod = wabt.parseWat('solver-kernel.wat', watSource);
    mod.validate();
  } catch (err) {
    console.error('Failed to compile solver-kernel.wat:\n' + err.message);
    process.exit(1);
  }

  const { buffer } = mod.toBinary({ write_debug_names: false });
  fs.writeFileSync(WASM_PATH, Buffer.from(buffer));
  console.log(`Built ${path.relative(ROOT, WASM_PATH)} (${buffer.length} bytes) from wasm/solver-kernel.wat`);
})();
