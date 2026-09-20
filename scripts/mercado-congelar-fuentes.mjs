#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// R0(f) — congela en news-sources.json las URLs GANADORAS del censo.
//
//   node scripts/mercado-congelar-fuentes.mjs censo.json
//   node scripts/mercado-congelar-fuentes.mjs censo.json --dry
//
// POR QUÉ ESTO ES UN SCRIPT Y NO UN COMMIT A MANO.
//
// El punto 0.10 probó VARIAS candidatas por fuente y reportó cuál respondió.
// Cuál ganó está en el JSON de la corrida y en ningún otro lado: el registro
// quedó con las candidatas en orden, no con el resultado. Copiarlas a mano
// desde el JSON es exactamente el tipo de tarea donde se cuela un typo que
// después se lee como "la fuente se cayó" — el mismo modo de falla que este
// censo existe para evitar.
//
// Así que la congelación es mecánica: entra el JSON, sale el registro con
// `feed` (la ganadora), `smoke` (lo que se midió) y `feeds` (las candidatas,
// que NO se borran — si la ganadora muere, la siguiente ya está escrita).
//
// NO inventa nada: una fuente que el JSON no menciona se deja intacta, y se
// reporta. Una fuente GO sin url ganadora es un error del JSON y se dice.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRO = join(ROOT, 'api/_lib/news-sources.json');

/**
 * Entra el registro y la respuesta del censo; sale el registro nuevo más un
 * reporte de qué cambió. PURA: no lee ni escribe disco, así que se prueba con
 * fixtures (tests/mercado-r0.test.mjs).
 *
 * `censo` es el objeto completo de /api/mercado-censo, o su `q11_feeds_noticias`.
 */
export function congelar(registro, censo) {
  const q11 = (censo && censo.q11_feeds_noticias) || censo || {};
  const tabla = Array.isArray(q11.tabla) ? q11.tabla : [];
  const porId = new Map(tabla.map((t) => [t.id, t]));

  const reporte = {
    congeladas: [], sin_ganadora: [], asumidas_no: [],
    no_mencionadas: [], invalidas: [],
  };

  const fuentes = registro.fuentes.map((f) => {
    const r = porId.get(f.id);
    if (!r) { reporte.no_mencionadas.push(f.id); return f; }

    if (r.veredicto === 'ASUMIDO_NO') {
      reporte.asumidas_no.push(f.id);
      return { ...f, smoke: { veredicto: 'ASUMIDO_NO', motivo: r.motivo || f.asumido_no || null } };
    }

    if (r.veredicto === 'GO') {
      // Un GO sin url ganadora es un JSON roto, no una fuente buena. Se
      // reporta y NO se toca el registro: preferimos un registro viejo a uno
      // con un `feed: undefined` que después nadie sabe de dónde salió.
      if (!r.feed || !/^https?:\/\//i.test(r.feed)) {
        reporte.invalidas.push({ id: f.id, motivo: 'veredicto GO sin url ganadora válida', feed: r.feed ?? null });
        return f;
      }
      // Las candidatas NO se borran: se reordena para que la ganadora quede
      // primera. Si mañana muere, la siguiente ya está escrita y probada.
      const resto = (f.feeds || []).filter((u) => u !== r.feed);
      reporte.congeladas.push({ id: f.id, feed: r.feed, era_candidata_n: (f.feeds || []).indexOf(r.feed) + 1 || null });
      return {
        ...f,
        feed: r.feed,
        feeds: [r.feed, ...resto],
        smoke: {
          veredicto: 'GO',
          items: r.items ?? null,
          usables: r.usables ?? null,
          dialecto: r.dialecto ?? null,
          pct_con_fecha: r.pct_con_fecha ?? null,
          pct_con_imagen: r.pct_con_imagen ?? null,
          vias_imagen: r.vias_imagen ?? null,
          pct_con_categoria: r.pct_con_categoria ?? null,
          categorias_ejemplo: r.categorias_ejemplo ?? null,
        },
      };
    }

    // NO-GO: se guarda el motivo y se deja el `feed` en null. Un NO-GO con
    // motivo es una fuente que se puede reintentar con otra ruta; un NO-GO
    // sin motivo es un agujero en el registro.
    reporte.sin_ganadora.push({ id: f.id, motivo: r.motivo || 'sin motivo en el JSON' });
    return {
      ...f, feed: null,
      smoke: {
        veredicto: 'NO-GO',
        motivo: r.motivo || null,
        bloqueado_cloudflare: r.bloqueado_cloudflare === true,
        candidatas_probadas: Array.isArray(r.candidatas) ? r.candidatas.length : null,
      },
    };
  });

  return { registro: { ...registro, fuentes }, reporte };
}

/** Resumen legible para pegar en el PR. */
export function resumen(reporte) {
  const L = [];
  L.push(`congeladas con url ganadora: ${reporte.congeladas.length}`);
  const noPrimera = reporte.congeladas.filter((c) => c.era_candidata_n && c.era_candidata_n > 1);
  if (noPrimera.length) {
    L.push(`  de ésas, ${noPrimera.length} ganó una candidata que NO era la primera:`);
    for (const c of noPrimera) L.push(`    ${c.id} → candidata #${c.era_candidata_n}`);
  }
  L.push(`NO-GO (feed en null, con motivo): ${reporte.sin_ganadora.length}`);
  for (const s of reporte.sin_ganadora) L.push(`    ${s.id}: ${s.motivo}`);
  L.push(`asumidas NO (no se sondean): ${reporte.asumidas_no.length}`);
  if (reporte.no_mencionadas.length) {
    L.push(`SIN TOCAR — el JSON no las menciona: ${reporte.no_mencionadas.join(', ')}`);
  }
  if (reporte.invalidas.length) {
    L.push(`ERRORES EN EL JSON (registro no modificado para éstas):`);
    for (const i of reporte.invalidas) L.push(`    ${i.id}: ${i.motivo}`);
  }
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  const dry = args.includes('--dry');
  const ruta = args.find((a) => !a.startsWith('--'));
  if (!ruta) {
    console.error('uso: node scripts/mercado-congelar-fuentes.mjs <censo.json> [--dry]');
    console.error('  <censo.json> = la respuesta de /api/mercado-censo?job=todo, guardada en un archivo');
    process.exit(2);
  }
  const censo = JSON.parse(readFileSync(ruta, 'utf8'));
  const registro = JSON.parse(readFileSync(REGISTRO, 'utf8'));
  const { registro: nuevo, reporte } = congelar(registro, censo);
  console.log(resumen(reporte));
  if (dry) { console.log('\n--dry: no se escribió nada.'); return; }
  writeFileSync(REGISTRO, JSON.stringify(nuevo, null, 2) + '\n');
  console.log(`\nescrito: ${REGISTRO}`);
}

if (process.argv[1] && process.argv[1].endsWith('mercado-congelar-fuentes.mjs')) main(process.argv);
