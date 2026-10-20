// ═══════════════════════════════════════════════════════════════════
// tests/arena-audit-fuentes.test.mjs — la auditoría lee las DOS tablas.
//
// EL CASO (2026-10-20): la puerta de 21 corridas corre en
// `arena_shadow_journal` y /api/arena-audit sólo leía `arena_journal`. La
// puerta era invisible para la herramienta de auditoría y hubo que sacarla
// por SQL. Ahora:
//   · las corridas leen las dos tablas por defecto, cada fila con su sello;
//   · `?fuente=prueba` (o `?view=shadow`) lee sólo la sombra;
//   · el RESUMEN no mezcla poblaciones: EN VIVO por defecto, `fuente=prueba`
//     para el de la puerta, y `ambas` se rechaza CON AVISO.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolverFuente, auditaFila, agrupaCorridas, renderCorridasMarkdown } from '../api/_lib/arena-audit.js';

test('qué tablas se leen', () => {
  assert.equal(resolverFuente({}).fuente, 'ambas', 'corridas: las dos por defecto');
  assert.equal(resolverFuente({ view: 'shadow' }).fuente, 'prueba', '?view=shadow es la sombra');
  assert.equal(resolverFuente({ fuente: 'sombra' }).fuente, 'prueba');
  assert.equal(resolverFuente({ fuente: 'viva' }).fuente, 'en_vivo');
  assert.equal(resolverFuente({ esResumen: true }).fuente, 'en_vivo', 'el resumen por defecto no cambia de población');
  assert.equal(resolverFuente({ esResumen: true, fuente: 'prueba' }).fuente, 'prueba', 'el resumen de la puerta');
  const mezcla = resolverFuente({ esResumen: true, fuente: 'ambas' });
  assert.equal(mezcla.fuente, 'en_vivo');
  assert.match(mezcla.avisos[0], /no mezcla EN VIVO con PRUEBA/);
  assert.match(resolverFuente({ fuente: 'xyz' }).avisos[0], /no se reconoce/);
});

test('cada fila lleva su sello, y el objetivo de la sombra se lee igual que el de la viva', () => {
  // Una fila como la devuelve la consulta de la sombra: target y rebalance
  // metidos en context, sin actions.
  const sombra = auditaFila({
    id: 's1', run_date: '2026-10-20', created_at: '2026-10-20T15:40:00Z', agent_id: 'grok', status: 'ok_target',
    actions: null, fuente: 'prueba',
    context: { target: { weights: { MU: 0.15 }, cash: 0.85, theses: { MU: 'x' } }, rebalance: { legs: [] } },
  });
  assert.equal(sombra.fuente, 'prueba');
  assert.equal(sombra.sello, 'PRUEBA');
  assert.ok(sombra.objetivo, 'el objetivo de la sombra no sale vacío');
  const viva = auditaFila({ id: 'v1', run_date: '2026-10-20', created_at: '2026-10-20T15:41:00Z', agent_id: 'grok', status: 'ok_target', fuente: 'en_vivo', context: {} });
  assert.equal(viva.sello, 'EN VIVO');
  const md = renderCorridasMarkdown({ agente: 'grok', corridas: agrupaCorridas([sombra, viva]), halt: [], total_filas: 2 });
  assert.match(md, /### \[PRUEBA\] /);
  assert.match(md, /### \[EN VIVO\] /);
});

test('cableado: el endpoint consulta la sombra, la sella, acepta `fuente` y avisa los cortes', () => {
  const src = readFileSync(new URL('../api/arena-audit.js', import.meta.url), 'utf8');
  assert.match(src, /from arena_shadow_journal/);
  // La sombra guarda target/rebalance en COLUMNAS; sin meterlos en context, el
  // objetivo de cada corrida de la puerta sale vacío. (Revisión del texto SQL:
  // sin Neon en las pruebas, es lo que se puede verificar.)
  assert.match(src, /coalesce\(context, '\{\}'::jsonb\)\s*\|\| jsonb_strip_nulls\(jsonb_build_object\('target', target, 'rebalance', rebalance\)\) as context/);
  assert.match(src, /sombra\.map\(\(r\) => \(\{ \.\.\.r, fuente: 'prueba' \}\)\)/);
  assert.match(src, /viva\.map\(\(r\) => \(\{ \.\.\.r, fuente: 'en_vivo' \}\)\)/);
  assert.match(src, /'fuente'\]\);/, '`fuente` es un parámetro conocido, no "se IGNORÓ"');
  assert.match(src, /El límite \(\$\{limit\}\) cortó/);
});
