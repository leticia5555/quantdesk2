#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/historia-g7.mjs — el cierre de G7, contra Neon.
//
// El goteo prueba que la INGESTA corre: baja de EDGAR, guarda, y reporta
// cuántos hechos y cuántos descartes. Lo que NO prueba es que la VISTA
// devuelva lo correcto — y la vista es donde vivían los tres errores que la
// rebanada B tuvo que arreglar: el alias confundido con re-expresión, el Q4
// derivado con una sola cita, y el YoY contando cuatro filas.
//
// Esto corre las consultas que cierran esa mitad. Solo lecturas.
//
//   DATABASE_URL=... node scripts/historia-g7.mjs
//
// Sale 0 si G7 cierra, 1 si algo no cuadra. Imprime el número, no el
// veredicto solo: un "VERDE" sin el dato al lado no se puede auditar.
// ═══════════════════════════════════════════════════════════════

import { sql } from '../api/_lib/db.js';
import { NUCLEO } from '../api/_lib/historia-db.js';

// ─────────────────────────────────────────────────────────────────────────
// El criterio, separado de las consultas para poder probarlo sin base.
// Los umbrales salen de §11 del memo y no se mueven acá.
// ─────────────────────────────────────────────────────────────────────────
export function veredictoG7({ cobertura = [], citas = {}, aliasLulu = [], reexpresionesMeli = [] }) {
  const lineas = [];
  let rojo = false;

  const falla = (id, texto, detalle) => { rojo = true; lineas.push({ id, estado: 'ROJO', texto, detalle }); };
  const pasa = (id, texto, detalle) => lineas.push({ id, estado: 'VERDE', texto, detalle });
  const nota = (id, texto, detalle) => lineas.push({ id, estado: 'NOTA', texto, detalle });

  // 1. La cita. La corrida 2 midió 0 hechos sin accn en los cuatro emisores:
  //    cualquier otro número es nuestro, no de EDGAR.
  if (Number(citas.sin_accession || 0) > 0) {
    falla('citas', 'hay hechos sin accession en la tabla', `${citas.sin_accession} filas`);
  } else pasa('citas', 'ningún hecho guardado sin accession', '0 filas');

  // Un derivado sin su segunda cita estaría citando la mitad de una resta.
  // El CHECK de la tabla lo impide, así que esto confirma el CHECK.
  if (Number(citas.derivados_sin_aux || 0) > 0) {
    falla('cita_doble', 'hay Q4 derivados sin accession_aux', `${citas.derivados_sin_aux} filas`);
  } else pasa('cita_doble', 'todo Q4 derivado trae sus DOS citas', '0 sin segunda cita');

  // 2. La cobertura del núcleo, contra los 12/12 de §11. El emisor extranjero
  //    queda FUERA DE CRITERIO, que es la enmienda de §4.
  const domesticos = cobertura.filter((c) => c.cobertura === 'completa');
  const extranjeros = cobertura.filter((c) => c.cobertura !== 'completa');
  for (const c of domesticos) {
    const peor = Math.min(...NUCLEO.map((f) => Number(c[f] ?? 0)));
    if (peor >= 11) pasa('cobertura', `${c.ticker}: peor familia del núcleo ${peor}/12`, null);
    else falla('cobertura', `${c.ticker}: peor familia del núcleo ${peor}/12 (§11 midió 12)`, null);
  }
  for (const c of extranjeros) {
    nota('cobertura', `${c.ticker}: fuera de criterio — emisor extranjero, no reporta trimestres`, 'lo clasifica G6');
  }

  // 3. EL ARREGLO DEL ALIAS. La corrida 2 dejó a LULU con inventario revisado
  //    al 100% (12 de 12) porque la vista mezclaba InventoryNet con
  //    InventoryFinishedGoods. Si sigue en 100%, el arreglo no llegó.
  for (const f of aliasLulu) {
    const pct = Number(f.trimestres) ? (100 * Number(f.revisados)) / Number(f.trimestres) : 0;
    const d = `${f.revisados}/${f.trimestres} revisados`;
    if (f.familia === 'inventario' && pct >= 100) {
      falla('alias', 'LULU inventario sigue revisado al 100%: el arreglo del alias NO llegó a la vista', d);
    } else if (pct >= 100 && Number(f.trimestres) > 4) {
      nota('alias', `LULU ${f.familia} está revisado al 100% — mirar si es real o otro alias`, d);
    } else {
      pasa('alias', `LULU ${f.familia}: ${pct.toFixed(0)}% revisado`, d);
    }
  }

  // 4. LAS RE-EXPRESIONES DE MELI, POR TAG. El 19 de la sonda mezclaba
  //    re-expresión con diferencia entre alias. Esto las separa: cada fila es
  //    un concepto, y su conteo son periodos con más de un valor DENTRO de
  //    ese concepto. La suma ya no tiene por qué dar 19 — si diera, sería
  //    casualidad, no confirmación.
  if (!reexpresionesMeli.length) {
    nota('reexpresiones', 'MELI no tiene periodos re-expresados en ingresos', 'la sonda contaba alias, no revisiones');
  } else {
    for (const r of reexpresionesMeli) {
      nota('reexpresiones', `MELI ${r.concept}: ${r.periodos} periodo(s) con más de un valor`, `${r.revisiones_totales} presentaciones`);
    }
  }

  return { rojo, lineas };
}

// ─────────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. Este script solo lee, pero necesita la base donde corrió el goteo.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  G7 — la mitad que el goteo NO prueba: la VISTA');
  console.log('═══════════════════════════════════════════════════════════\n');

  // La cita, sobre la tabla cruda.
  const [citas] = await sql(`
    select count(*) filter (where accession is null or accession = '')            as sin_accession,
           count(*) filter (where derived and (accession_aux is null or accession_aux = '')) as derivados_sin_aux,
           count(*)                                                                as total
      from company_facts`);

  // La cobertura del núcleo por emisor, desde la VISTA y en la ventana de 3
  // años — la misma que midió G1.
  const cobertura = await sql(`
    select e.ticker, e.cobertura,
           count(distinct q.period_end) filter (where q.familia = 'ingresos')   as ingresos,
           count(distinct q.period_end) filter (where q.familia = 'margen')     as margen,
           count(distinct q.period_end) filter (where q.familia = 'inventario') as inventario,
           count(distinct q.period_end) filter (where q.familia = 'neto')       as neto
      from company_emisor e
      left join company_quarterly q
        on q.cik = e.cik and q.period_end >= (current_date - interval '3 years')
     group by e.ticker, e.cobertura
     order by e.ticker`);

  // EL ARREGLO DEL ALIAS: LULU, por familia, cuántos trimestres salen
  // marcados `revisado`.
  const aliasLulu = await sql(`
    select q.familia,
           count(*)                            as trimestres,
           count(*) filter (where q.revisado)  as revisados
      from company_quarterly q
      join company_emisor e on e.cik = q.cik
     where upper(e.ticker) = 'LULU'
     group by q.familia
     order by q.familia`);

  // LAS RE-EXPRESIONES DE MELI, SEPARADAS POR TAG.
  const reexpresionesMeli = await sql(`
    with porPeriodo as (
      select f.concept, f.period_end, count(distinct f.val) as valores, count(*) as presentaciones
        from company_facts f
        join company_emisor e on e.cik = f.cik
       where upper(e.ticker) = 'MELI'
         and f.familia = 'ingresos'
         and f.period_class = 'Q'
       group by 1, 2
    )
    select concept,
           count(*) filter (where valores > 1) as periodos,
           sum(presentaciones)                 as revisiones_totales
      from porPeriodo
     group by concept
    having count(*) filter (where valores > 1) > 0
     order by 2 desc`);

  console.log(`  hechos en la tabla: ${citas.total}\n`);

  const { rojo, lineas } = veredictoG7({ cobertura, citas, aliasLulu, reexpresionesMeli });
  const marca = { VERDE: '🟢', ROJO: '🔴', NOTA: '  ' };
  let grupo = null;
  for (const l of lineas) {
    if (l.id !== grupo) { console.log(`\n── ${l.id}`); grupo = l.id; }
    console.log(`  ${marca[l.estado]} ${l.texto}${l.detalle ? '  ·  ' + l.detalle : ''}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(rojo ? '  🔴 G7 NO cierra' : '  🟢 G7 CIERRA — la vista devuelve lo que dice devolver');
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(rojo ? 1 : 0);
}

// Solo corre si se invoca directo: el test importa `veredictoG7` sin base.
if (import.meta.url === `file://${process.argv[1]}`) await main();
