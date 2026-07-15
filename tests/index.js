// ═══════════════════════════════════════════════════════════════
// tests/index.js — hace que `node --test tests/` funcione.
//
// Node 22 no expande un DIRECTORIO pasado a --test: lo trata como archivo
// de test y ejecuta `node tests/`, que sin este index.js muere con
// MODULE_NOT_FOUND. Este runner corre todas las suites *.test.mjs en orden
// y sale ≠ 0 si alguna falla, así que:
//   node --test tests/   → 1 subtest 'tests' que agrega las 7 suites
//   node tests/          → mismo runner, directo
//   node --test          → sigue descubriendo cada suite individual
// ═══════════════════════════════════════════════════════════════

const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const suites = readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;

for (const f of suites) {
  console.log(`\n═══ ${f} ═══`);
  const r = spawnSync(process.execPath, [join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${suites.length - failed}/${suites.length} suites en verde`);
process.exit(failed ? 1 : 0);
