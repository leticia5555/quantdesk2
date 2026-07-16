// ═══════════════════════════════════════════════════════════════
// tests/no-hardcoded-dates.test.mjs — lint anti "relojes rotos".
//
// En abril 2026 se tatuaron fechas en prompts y datos ("April 2026",
// "Apr 9", "GDP Q1 2026") y en julio la app seguía mostrando abril como
// próximo. Este lint escanea el código de PRODUCCIÓN (app.html,
// index.html, api/) buscando fechas literales y FALLA si aparece una
// nueva: toda referencia temporal se calcula en runtime — frontend vía
// qdTodayLabel()/qdMonthYear()/qdParseCalDate() (app.html) y backend vía
// dateDirective() (api/_lib/ai-guard.js).
//
// Exentos: comentarios (documentación tipo "calibrado en Apr 2026"),
// tests y e2e (fixtures stale intencionales), y líneas marcadas con
// `date-lint-ok` (waiver explícito, dejá el porqué al lado).
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'app.html',
  'index.html',
  ...readdirSync(join(ROOT, 'api')).filter((f) => f.endsWith('.js')).map((f) => 'api/' + f),
  ...readdirSync(join(ROOT, 'api/_lib')).filter((f) => f.endsWith('.js')).map((f) => 'api/_lib/' + f),
];

const MONTHS_EN = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const MONTHS_ES = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)';

const PATTERNS = [
  // "April 2026", "Apr 9 2026", "April 7 to May 2 2026", "Sept. 15, 2027"
  { name: 'mes+año (EN)', re: new RegExp('\\b' + MONTHS_EN + '\\.?\\s+(\\d{1,2}(st|nd|rd|th)?\\s*(,|to|-|–)?\\s*)*20\\d{2}\\b') },
  // "abril de 2026"
  { name: 'mes+año (ES)', re: new RegExp('\\b' + MONTHS_ES + '\\s+(de\\s+)?20\\d{2}\\b', 'i') },
  // "Q1 2026", "Q3-2025"
  { name: 'trimestre+año', re: /\bQ[1-4]\s*[- ]?\s*20\d{2}\b/ },
  // "H2 2025", "S1 2026"
  { name: 'semestre+año', re: /\b[HS][12]\s+20\d{2}\b/ },
  // fecha ISO literal en string: '2026-04-09'
  { name: 'ISO literal', re: /['"`]20\d{2}-\d{2}-\d{2}/ },
  // "early 2026", "as of 2025", "mid-2026", "late 2027"
  { name: 'ancla vaga+año', re: /\b(early|late|mid|as of|finales de|inicios de|mediados de)[- ]+20\d{2}\b/i },
];

// Falsos positivos conocidos y permanentes (no son referencias temporales):
const ALLOW = [
  /ANTHROPIC_VERSION/,          // '2023-06-01' es la versión de la API de Anthropic
  /date-lint-ok/,               // waiver explícito en línea
];

function scanLine(line) {
  // comentario de línea completa (JS o HTML) → documentación, exenta
  if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return null;
  // comentario al final de línea: se corta en ' //' precedido de espacio
  // (no rompe 'http://', que no lleva espacio antes de '//')
  const code = line.replace(/\s\/\/.*$/, '');
  if (ALLOW.some((a) => a.test(code))) return null;
  for (const p of PATTERNS) {
    const m = p.re.exec(code);
    if (m) return { pattern: p.name, match: m[0] };
  }
  return null;
}

test('el propio linter reconoce las formas que motivaron el bug', () => {
  assert.ok(scanLine("  'Economic calendar April-May 2026. Fed, CPI'"));
  assert.ok(scanLine("  'Fear & Greed score for financial markets April 9 2026.'"));
  assert.ok(scanLine("  {date:'Apr 25',event:'GDP Q1 2026',country:'US'}"));
  assert.ok(scanLine('  `Senior VC analyst. Active fundraising, early 2026.`'));
  assert.ok(scanLine("  { ticker: 'JPM', date: '2026-04-10', time: 'BMO' }"));
  assert.ok(scanLine('  "macro brief for LATAM investors as of abril de 2026"'));
  // y NO grita con lo legítimo:
  assert.equal(scanLine("  const RISK_FREE_RATE = 0.045;  // ~4.5% T-bill (Apr 2026)"), null);
  assert.equal(scanLine("  // Parsea fechas: '2026-07-20', 'Jul 20'"), null);
  assert.equal(scanLine("  'Standard error (Lo 2002 GMM)'"), null);
  assert.equal(scanLine("  'Russell 2000 ETF'"), null);
  assert.equal(scanLine("  const ANTHROPIC_VERSION = '2023-06-01';"), null);
  assert.equal(scanLine("  'Earnings calendar for the next 4 weeks starting '+qdTodayLabel()"), null);
});

test('cero fechas hardcodeadas en código de producción y prompts', () => {
  const violations = [];
  for (const f of FILES) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch (_) { continue; }
    src.split('\n').forEach((line, i) => {
      const hit = scanLine(line);
      if (hit) violations.push(`${f}:${i + 1} [${hit.pattern}] "${hit.match}" → usa qdTodayLabel()/qdMonthYear() (front) o dateDirective() (api), o marca date-lint-ok con el porqué`);
    });
  }
  assert.deepEqual(violations, [], '\n' + violations.join('\n'));
});
