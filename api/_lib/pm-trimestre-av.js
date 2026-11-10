// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-trimestre-av.js — a qué reporte de Alpha Vantage apunta cada
// mercado de earnings de Polymarket. Ver docs/pm-fechas-av-scope.md.
//
// Dos usos, una sola regla:
//   1. FECHAS: los mercados resueltos SIN report_date en v1/v2 (los que
//      PM-DRIFT y PM-CENTAVOS excluyeron) reciben la fecha del PRIMER reporte
//      de pm_v2_hist (AV EARNINGS) en o después del día de creación del
//      mercado. Fuente marcada: 'tabla' o 'av_hist'.
//   2. CONSENSO FINAL: el estimatedEPS de AV de ESE trimestre (PM-CENTAVOS2).
//
// PURO (sin red ni DB): la carga recibe `sql` inyectado. Sobre v1, v2,
// pm_v2_hist, pead_event_hour y pead_earnings: solo SELECT. Escribe
// únicamente en pm_fecha_av (tabla nueva, auditoría del relleno).
//
// CRITERIOS_TRIMESTRE_AV se fijó ANTES de correr y el test lo pinea.
// ═══════════════════════════════════════════════════════════════════

const CRITERIOS_TRIMESTRE_AV = Object.freeze({
  // Mercado CON report_date en la tabla: el trimestre de AV es el de
  // reported_date más cercano a esa fecha, a ≤ 3 días. Si no hay, sin estimado.
  tolerancia_dias_tabla: 3,
  // Mercado SIN report_date: el primer reporte con reported_date ≥ día de
  // creación (UTC) y ≤ creación + 120 días.
  max_dias_tras_creacion: 120,
  // Y no después de la resolución del mercado (+1 día de holgura): un
  // mercado no resuelve antes del reporte por el que pregunta.
  holgura_resolucion_dias: 1,
});

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const DIA = 24 * 3600 * 1000;
const dia = (s) => (s ? String(s).slice(0, 10) : null);
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA);

// hist: filas de pm_v2_hist (o pead_earnings) de UN símbolo, con
// reported_date. Devuelve:
//   fecha, fuente_fecha ('tabla' | 'av_hist' | null), motivo_fecha
//   av (la fila del trimestre o null), motivo_av
function emparejaTrimestre(m, hist, C = CRITERIOS_TRIMESTRE_AV) {
  const filas = (hist || [])
    .filter((h) => h && h.reported_date)
    .map((h) => ({ ...h, reported_date: dia(h.reported_date) }))
    .sort((a, b) => (a.reported_date < b.reported_date ? -1 : a.reported_date > b.reported_date ? 1 : 0));
  const tabla = dia(m.report_date);
  const fuera = (motivo) => ({ fecha: null, fuente_fecha: null, motivo_fecha: motivo, av: null, motivo_av: motivo });

  if (tabla) {
    let av = null;
    let mejor = Infinity;
    for (const h of filas) {
      const d = Math.abs(diasEntre(tabla, h.reported_date));
      if (d <= C.tolerancia_dias_tabla && d < mejor) { av = h; mejor = d; }
    }
    const motivo_av = av ? null : !m.symbol ? 'sin_simbolo' : !filas.length ? 'simbolo_sin_hist' : 'sin_trimestre_av';
    return { fecha: tabla, fuente_fecha: 'tabla', motivo_fecha: null, av, motivo_av };
  }

  if (!m.symbol) return fuera('sin_simbolo');
  const creado = dia(m.creado);
  if (!creado) return fuera('sin_creado');
  if (!filas.length) return fuera('simbolo_sin_hist');
  const primero = filas.find((h) => h.reported_date >= creado);
  if (!primero) return fuera('hist_desactualizado');      // el último reporte de AV es anterior a la creación
  if (diasEntre(creado, primero.reported_date) > C.max_dias_tras_creacion) return fuera('sin_reporte_cercano');
  const res = dia(m.resolved_date);
  if (res && diasEntre(res, primero.reported_date) > C.holgura_resolucion_dias) return fuera('posterior_a_resolucion');
  return { fecha: primero.reported_date, fuente_fecha: 'av_hist', motivo_fecha: null, av: primero, motivo_av: null };
}

// Validación de la regla, sobre los mercados que SÍ traen report_date: ¿la
// regla "primer reporte tras la creación" da la misma fecha (± tolerancia)?
// Se reporta, no decide nada.
function validaRegla(mercados, histPorSimbolo, C = CRITERIOS_TRIMESTRE_AV) {
  const r = { con_fecha_tabla: 0, evaluables: 0, coincide: 0, no_coincide: 0, ejemplos_no_coincide: [] };
  for (const m of mercados) {
    if (!dia(m.report_date)) continue;
    r.con_fecha_tabla++;
    const e = emparejaTrimestre({ ...m, report_date: null }, histPorSimbolo.get(m.symbol), C);
    if (!e.fecha) continue;
    r.evaluables++;
    if (Math.abs(diasEntre(dia(m.report_date), e.fecha)) <= C.tolerancia_dias_tabla) r.coincide++;
    else {
      r.no_coincide++;
      if (r.ejemplos_no_coincide.length < 10) r.ejemplos_no_coincide.push({ market_id: m.market_id, symbol: m.symbol, tabla: dia(m.report_date), regla: e.fecha, creado: dia(m.creado) });
    }
  }
  return r;
}

// ─────────────────── base común de los estudios ───────────────────

// filas = SQL_MERCADOS (v2 primero). Dedup por market_id (gana v2), resueltos,
// liquidez ≥ min, con token. A cada uno le pega el emparejamiento con AV y la
// hora del reporte en SU fecha efectiva. Las exclusiones propias de cada
// estudio se cuentan en cada estudio.
function baseMercados(filas, { histPorSimbolo = new Map(), horas = new Map(), min_volumen_usd = 500, C = CRITERIOS_TRIMESTRE_AV } = {}) {
  const vistos = new Set();
  const mercados = [];
  const excluidos = { duplicado: 0, no_resuelto: 0, liquidez: 0, sin_token: 0 };
  for (const f of filas || []) {
    const id = f && f.market_id != null ? String(f.market_id) : null;
    if (!id) continue;
    if (vistos.has(id)) { excluidos.duplicado++; continue; }
    vistos.add(id);
    const outcome = String(f.outcome || '').toLowerCase();
    if (outcome !== 'yes' && outcome !== 'no') { excluidos.no_resuelto++; continue; }
    const vol = num(f.volume);
    if (vol === null || vol < min_volumen_usd) { excluidos.liquidez++; continue; }
    if (!f.yes_token_id) { excluidos.sin_token++; continue; }
    const e = emparejaTrimestre(f, histPorSimbolo.get(f.symbol), C);
    const hora = e.fecha && f.symbol ? horas.get(`${f.symbol}|${e.fecha}`) || null : null;
    mercados.push({
      market_id: id, symbol: f.symbol || null, cosecha: f.cosecha || null,
      slug: f.slug || null, question: f.question || null, descripcion: f.descripcion || null,
      creado: dia(f.creado), resolved_date: dia(f.resolved_date), report_date_tabla: dia(f.report_date),
      token: String(f.yes_token_id), y: outcome === 'yes' ? 1 : 0, volume: vol,
      fecha: e.fecha, fuente_fecha: e.fuente_fecha, motivo_fecha: e.motivo_fecha,
      av: e.av ? { reported_date: e.av.reported_date, fiscal_quarter_end: dia(e.av.fiscal_quarter_end),
        estimated_eps: num(e.av.estimated_eps), reported_eps: num(e.av.reported_eps) } : null,
      motivo_av: e.motivo_av,
      hour: hora,
    });
  }
  return { mercados, excluidos, filas: (filas || []).length };
}

// ─────────────────── resumen del relleno de fechas ───────────────────

// pead: Map símbolo → filas de pead_earnings (solo para INFORMAR cuántos de
// los no recuperados sí estarían ahí; no se usa para rellenar).
function resumenFechas(base, { histPorSimbolo, peadPorSimbolo = new Map(), C = CRITERIOS_TRIMESTRE_AV } = {}) {
  const ms = base.mercados;
  const sinTabla = ms.filter((m) => !m.report_date_tabla);
  const recuperados = sinTabla.filter((m) => m.fuente_fecha === 'av_hist');
  const motivos = {};
  for (const m of sinTabla) if (!m.fecha) motivos[m.motivo_fecha] = (motivos[m.motivo_fecha] || 0) + 1;
  const noRec = sinTabla.filter((m) => !m.fecha);
  const enPead = noRec.filter((m) => m.symbol && emparejaTrimestre({ ...m, report_date: null }, peadPorSimbolo.get(m.symbol), C).fecha).length;
  const conHora = (g) => g.filter((m) => m.hour).length;
  return {
    filas: base.filas,
    excluidos_base: base.excluidos,
    resueltos_con_liquidez_y_token: ms.length,
    con_fecha_tabla: ms.length - sinTabla.length,
    sin_fecha_tabla: sinTabla.length,
    recuperados: recuperados.length,
    no_recuperados: noRec.length,
    motivos_no_recuperado: motivos,
    no_recuperados_que_estan_en_pead_earnings: enPead,
    con_hora_de_reporte: { tabla: conHora(ms.filter((m) => m.fuente_fecha === 'tabla')), av_hist: conHora(recuperados) },
    con_estimado_av: {
      tabla: ms.filter((m) => m.fuente_fecha === 'tabla' && m.av && m.av.estimated_eps !== null).length,
      av_hist: recuperados.filter((m) => m.av && m.av.estimated_eps !== null).length,
      motivos_sin_estimado_tabla: ms.filter((m) => m.fuente_fecha === 'tabla' && !m.av)
        .reduce((a, m) => { a[m.motivo_av] = (a[m.motivo_av] || 0) + 1; return a; }, {}),
    },
    validacion_regla: validaRegla(ms.map((m) => ({ ...m, report_date: m.report_date_tabla })), histPorSimbolo, C),
  };
}

function renderFechasMarkdown(s) {
  const r = s.resumen;
  const C = s.criterios || CRITERIOS_TRIMESTRE_AV;
  const v = r.validacion_regla;
  const kv = (o) => Object.entries(o || {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';
  const L = [];
  L.push('# PM-FECHAS-AV — relleno de report_date desde pm_v2_hist (Alpha Vantage EARNINGS)');
  L.push('');
  L.push(`Generado: ${s.generado_en}${s.escrito ? ` · filas escritas en pm_fecha_av: ${s.escrito}` : ''}`);
  L.push('');
  L.push(`Regla: primer reporte de AV con reported_date ≥ día de creación del mercado, a ≤ ${C.max_dias_tras_creacion} días, y no después de la resolución (+${C.holgura_resolucion_dias} día).`);
  L.push('');
  L.push('## Universo (v2 ∪ v1, resueltos, liquidez ≥ $500, con token)');
  L.push(`- Filas leídas: ${r.filas} · excluidos: ${kv(r.excluidos_base)}`);
  L.push(`- Quedan: **${r.resueltos_con_liquidez_y_token}** · con report_date en la tabla: ${r.con_fecha_tabla} · **sin report_date: ${r.sin_fecha_tabla}**`);
  L.push('');
  L.push('## Relleno');
  L.push(`- **Recuperados: ${r.recuperados} de ${r.sin_fecha_tabla}** (fuente \`av_hist\`)`);
  L.push(`- No recuperados: ${r.no_recuperados} → ${kv(r.motivos_no_recuperado)}`);
  L.push(`- De los no recuperados, ${r.no_recuperados_que_estan_en_pead_earnings} sí tendrían fecha en pead_earnings (informativo: no se usa).`);
  L.push('');
  L.push('## Validación de la regla (sobre los que SÍ traen fecha en la tabla)');
  L.push(`- Evaluables: ${v.evaluables} de ${v.con_fecha_tabla} · coincide (± ${C.tolerancia_dias_tabla} días): **${v.coincide}** · no coincide: ${v.no_coincide}${v.evaluables ? ` (${((v.coincide / v.evaluables) * 100).toFixed(1)}% de acierto)` : ''}`);
  for (const e of v.ejemplos_no_coincide) L.push(`  - ${e.symbol} ${e.market_id}: tabla ${e.tabla} vs regla ${e.regla} (creado ${e.creado})`);
  L.push('');
  L.push('## Lo que cada estudio tendría');
  L.push(`- Hora de reporte conocida (pead_event_hour): tabla ${r.con_hora_de_reporte.tabla} · av_hist ${r.con_hora_de_reporte.av_hist}`);
  L.push(`- Con estimatedEPS de AV para el trimestre: tabla ${r.con_estimado_av.tabla} · av_hist ${r.con_estimado_av.av_hist}`);
  L.push(`- Con fecha de tabla pero sin estimado de AV: ${kv(r.con_estimado_av.motivos_sin_estimado_tabla)}`);
  return L.join('\n');
}

// ─────────────────── SQL ───────────────────

const COLS_M = `market_id, symbol, slug, question, raw->>'description' as descripcion,
       to_char(report_date, 'YYYY-MM-DD') as report_date, to_char(resolved_date, 'YYYY-MM-DD') as resolved_date,
       to_char(creado at time zone 'UTC', 'YYYY-MM-DD') as creado, outcome, volume, yes_token_id`;
// v2 primero; de v1 solo lo que v2 no tiene. Solo SELECT sobre v1/v2.
const SQL_MERCADOS = `select * from (
    select ${COLS_M}, 'v2' as cosecha, 0 as orden from pm_earnings_markets_v2
    union all
    select ${COLS_M}, 'v1' as cosecha, 1 as orden from pm_earnings_markets m
     where not exists (select 1 from pm_earnings_markets_v2 v where v.market_id = m.market_id)
  ) u order by orden, market_id`;

const ph = (n, desde = 1) => Array.from({ length: n }, (_, i) => `$${i + desde}`).join(', ');
const sqlHist = (n) => `select symbol, to_char(fiscal_quarter_end, 'YYYY-MM-DD') as fiscal_quarter_end,
       to_char(reported_date, 'YYYY-MM-DD') as reported_date, reported_eps, estimated_eps
  from pm_v2_hist where symbol in (${ph(n)}) and reported_date is not null order by symbol, reported_date`;
const sqlHoras = (n) => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, hour
  from pead_event_hour where symbol in (${ph(n)})`;
const sqlPead = (n) => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date
  from pead_earnings where symbol in (${ph(n)})`;

// Carga: mercados + historial AV + horas, en lotes de símbolos.
async function cargaBase({ sql, conPead = false, lote = 200 }) {
  const filas = await sql(SQL_MERCADOS);
  const simbolos = [...new Set(filas.map((f) => f.symbol).filter(Boolean))];
  const histPorSimbolo = new Map();
  const peadPorSimbolo = new Map();
  const horas = new Map();
  const agrupa = (mapa, r) => { if (!mapa.has(r.symbol)) mapa.set(r.symbol, []); mapa.get(r.symbol).push(r); };
  for (let i = 0; i < simbolos.length; i += lote) {
    const s = simbolos.slice(i, i + lote);
    for (const r of await sql(sqlHist(s.length), s)) agrupa(histPorSimbolo, r);
    for (const r of await sql(sqlHoras(s.length), s)) if (r.hour) horas.set(`${r.symbol}|${dia(r.reported_date)}`, String(r.hour).toLowerCase());
    if (conPead) for (const r of await sql(sqlPead(s.length), s)) agrupa(peadPorSimbolo, r);
  }
  return { filas, histPorSimbolo, peadPorSimbolo, horas };
}

// Auditoría del relleno. Tabla NUEVA; v1/v2 no se tocan.
const SCHEMA_FECHAS = [
  `create table if not exists pm_fecha_av (
     market_id          text primary key,
     symbol             text,
     cosecha            text,
     creado             date,
     report_date_tabla  date,
     report_date        date,
     fuente_fecha       text,            -- 'tabla' | 'av_hist' | null
     motivo             text,            -- por qué no hay fecha (null si hay)
     fiscal_quarter_end date,
     estimated_eps      numeric,
     reported_eps       numeric,
     calculado_en       timestamptz not null default now()
   )`,
];
const COLS_FECHAS = ['market_id', 'symbol', 'cosecha', 'creado', 'report_date_tabla', 'report_date', 'fuente_fecha', 'motivo', 'fiscal_quarter_end', 'estimated_eps', 'reported_eps'];

function sqlUpsertFechas(mercados) {
  const params = [];
  const values = mercados.map((m) => {
    const fila = [m.market_id, m.symbol, m.cosecha, m.creado, m.report_date_tabla, m.fecha, m.fuente_fecha, m.motivo_fecha,
      m.av ? m.av.fiscal_quarter_end : null, m.av ? m.av.estimated_eps : null, m.av ? m.av.reported_eps : null];
    const ini = params.length;
    params.push(...fila);
    return `(${fila.map((_, j) => `$${ini + j + 1}`).join(', ')})`;
  });
  return {
    query: `insert into pm_fecha_av (${COLS_FECHAS.join(', ')}) values ${values.join(', ')}
      on conflict (market_id) do update set ${COLS_FECHAS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, calculado_en = now()`,
    params,
  };
}

export {
  CRITERIOS_TRIMESTRE_AV, emparejaTrimestre, validaRegla, baseMercados, resumenFechas, renderFechasMarkdown,
  SQL_MERCADOS, sqlHist, sqlHoras, sqlPead, cargaBase, SCHEMA_FECHAS, COLS_FECHAS, sqlUpsertFechas,
};
