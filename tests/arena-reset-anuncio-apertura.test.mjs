// ═══════════════════════════════════════════════════════════════════
// tests/arena-reset-anuncio-apertura.test.mjs — el anuncio de apertura dice
// la ventana REAL, los días fuera de la serie y el ámbar con su causa.
//
// 2026-10-20: la T3 abre tarde. ARENA_SEASON planeaba 2026-10-01 → 10-30 (22
// sesiones). La temporada NO se acorta: el cierre es inicio + 22 sesiones
// (→ 2026-11-18), y el anuncio publica ESA ventana, no la planeada.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { resetAnnouncement, ambarDeQuery } from '../api/arena-reset.js';

const rows = ['claude', 'control', 'openai', 'grok', 'gemini', 'deepseek', 'qwen'].map((agent, i) => ({
  agent, flat: true, before: { position_count: 3, open_order_count: 1, equity: 100000 - i * 1000 }, baseline_equity: 100000 - i * 1000,
}));
const HOY = new Date('2026-10-20T14:30:00Z');
const MOTIVO = 'su proveedor ignora el presupuesto de razonamiento (reasoning.max_tokens); corre con ARENA_MAX_TOKENS=12000 y se arregla fijando proveedor cuando view=cierres diga cuál lo respeta';

test('la ventana es la REAL: desde hoy, 22 sesiones, y dice que el inicio se corrió', () => {
  const a = resetAnnouncement({ resetId: 'arena-t3-2026-10-20', baselineUsd: 100000, rows, now: HOY });
  assert.match(a, /VENTANA DE LA TEMPORADA: 2026-10-20 → 2026-11-18, 22 sesiones hábiles/);
  assert.match(a, /El inicio PLANEADO era 2026-10-01; la temporada abre tarde pero NO se acorta/);
});

test('capital de arranque con posición mínima, y la rejilla de enfoques', () => {
  const a = resetAnnouncement({ resetId: 'x', baselineUsd: 100000, rows, now: HOY });
  assert.match(a, /CAPITAL DE ARRANQUE.*qwen \$94000 \(posición mínima \$1880\)/);
  assert.match(a, /ENFOQUE DEL DÍA — LA REJILLA COMPLETA.*22 sesiones/);
});

test('los días fuera de la serie salen de la lista oficial, con su motivo', () => {
  const a = resetAnnouncement({ resetId: 'x', baselineUsd: 100000, rows, now: HOY });
  assert.match(a, /DÍAS FUERA DE LA SERIE de la T3/);
  assert.match(a, /2026-09-29 \[corrio_contaminado\] — La liga corrió EN VIVO etiquetada T3/);
  assert.match(a, /2026-09-30 \[detenida_a_proposito\]/);
});

test('ámbar: con motivo se publica; sin motivo, no', () => {
  const ag = rows.map((r) => r.agent);
  const conMotivo = ambarDeQuery({ ambar: 'qwen', ambar_motivo: MOTIVO }, ag);
  assert.deepEqual(conMotivo.ambar, [{ agent: 'qwen', motivo: MOTIVO }]);
  const a = resetAnnouncement({ resetId: 'x', baselineUsd: 100000, rows, now: HOY, ambar: conMotivo.ambar });
  assert.match(a, /EN ÁMBAR AL ABRIR: qwen — su proveedor ignora el presupuesto de razonamiento/);
  const sinMotivo = ambarDeQuery({ ambar: 'qwen' }, ag);
  assert.deepEqual(sinMotivo.ambar, []);
  assert.match(sinMotivo.aviso, /sin `ambar_motivo`/);
  assert.doesNotMatch(resetAnnouncement({ resetId: 'x', baselineUsd: 100000, rows, now: HOY }), /ÁMBAR/, 'sin ámbar, no hay línea');
  assert.match(ambarDeQuery({ ambar: 'qwen,nadie', ambar_motivo: 'm' }, ag).aviso, /nadie/);
});
