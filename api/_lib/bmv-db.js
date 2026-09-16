// ═══════════════════════════════════════════════════════════════════
// api/_lib/bmv-db.js — capa de datos de la cosecha DataBursatil (Fase A).
//
// TABLAS NUEVAS. `xbrl_reports` NO se toca: es la serie de Fase 1a y lo que
// produce la fecha real de publicación, que es justo lo que DataBursatil no
// tiene (docs/historico-censo.md §2.1). Las dos series conviven y se cruzan
// por (clave, año, trimestre) en Fase B; ninguna pisa a la otra.
//
//   bmv_emisoras        — el censo. `rango_financieros` es el dato
//                         point-in-time: define qué emisora existía en qué
//                         trimestre, que es lo que evita el survivorship bias.
//   bmv_financieros     — un renglón por emisora × trimestre. Crudo COMPLETO
//                         en jsonb + los 7 campos normalizados + `faltantes`.
//   bmv_precios         — cierre diario e importe operado.
//   bmv_harvest_ledger  — qué ya se pidió y cómo salió. Es lo que hace la
//                         cosecha reanudable e idempotente, y lo que contesta
//                         "¿dónde se quedó?" cuando se acaban los créditos.
//   bmv_api_budget      — créditos gastados por mes CDMX (se reponen el 1º).
//
// El crudo se guarda SIEMPRE y es la fuente de verdad: si la normalización
// quedó mal, se corrige con un UPDATE sobre lo guardado — sin gastar un solo
// crédito de nuevo. Eso es deliberado, no redundancia.
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';
import { CAMPOS } from './databursatil.js';

const BMV_SCHEMA = [
  `create table if not exists bmv_emisoras (
     emisora            text primary key,
     razon_social       text,
     tipo_valor_id      text,
     estatus            text,
     fin_desde          text,        -- '2016-2'  (rango_financieros)
     fin_hasta          text,        -- '2026-2'
     fin_motivo         text,        -- por qué no se pudo parsear, si no se pudo
     hist_desde         date,        -- rango_historicos
     hist_hasta         date,
     hist_motivo        text,
     raw                jsonb not null,
     actualizado_at     timestamptz not null default now()
   )`,

  `create table if not exists bmv_financieros (
     emisora        text not null,
     anio           int  not null,
     trimestre      int  not null check (trimestre between 1 and 4),
     fecha_cierre   date not null,
     raw            jsonb not null,
     revenue                                  numeric,
     profitlossattributabletoownersofparent   numeric,
     basicearningslosspershare                numeric,
     assets                                   numeric,
     liabilities                              numeric,
     equity                                   numeric,
     cashandcashequivalents                   numeric,
     faltantes      jsonb,
     cosechado_at   timestamptz not null default now(),
     primary key (emisora, anio, trimestre)
   )`,

  `create table if not exists bmv_precios (
     emisora   text not null,
     fecha     date not null,
     cierre    numeric,
     apertura  numeric,
     maximo    numeric,
     minimo    numeric,
     volumen   numeric,
     importe   numeric,
     primary key (emisora, fecha)
   )`,

  `create table if not exists bmv_harvest_ledger (
     job            text not null,          -- 'financieros' | 'historicos' | 'emisoras'
     emisora        text not null,
     clave          text not null,          -- '2016-2' | 'AAAA-MM-DD..AAAA-MM-DD'
     estado         text not null default 'pendiente',  -- pendiente|hecho|vacio|error
     intentos       int  not null default 0,
     filas          int  not null default 0,
     requests       int  not null default 0,
     error_msg      text,
     actualizado_at timestamptz not null default now(),
     primary key (job, emisora, clave)
   )`,

  `create table if not exists bmv_api_budget (
     mes            text primary key,       -- '2026-09', mes CDMX (el reset es 00:01 CDMX)
     requests       int not null default 0,
     creditos       int not null default 0,
     headers        jsonb,                  -- último saldo que la API haya publicado
     actualizado_at timestamptz not null default now()
   )`,

  // El contrato de la API DESCUBIERTO por ?job=probe: cómo se llama el
  // parámetro del periodo, el del rango de fechas, y qué forma tuvo la
  // respuesta. Vive en la DB y no en una constante porque se descubre en
  // prod (el sandbox no alcanza la API) y porque cambiarlo no debe exigir
  // un deploy a media cosecha.
  `create table if not exists bmv_meta (
     key        text primary key,
     value      jsonb,
     nota       text,
     updated_at timestamptz not null default now()
   )`,

  `create index if not exists bmv_financieros_periodo_idx
     on bmv_financieros (anio desc, trimestre desc, emisora)`,
  `create index if not exists bmv_precios_fecha_idx
     on bmv_precios (fecha)`,
  `create index if not exists bmv_ledger_estado_idx
     on bmv_harvest_ledger (job, estado)`,
];

let listo = false;
async function ensureBmvSchema() {
  if (listo) return;
  await sqlBatch(BMV_SCHEMA.map((q) => [q, []]));
  listo = true;
}

/* ─────────────────── meta (contrato descubierto) ─────────────────── */

async function leerMeta(key) {
  const r = await sql(`select value, nota, updated_at from bmv_meta where key = $1`, [key]);
  return r[0] || null;
}

async function guardarMeta(key, value, nota = null) {
  await sql(
    `insert into bmv_meta (key, value, nota, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set
       value = excluded.value, nota = excluded.nota, updated_at = now()`,
    [key, JSON.stringify(value ?? null), nota]);
}

/* ─────────────────── censo ─────────────────── */

async function upsertEmisora(e) {
  await sql(
    `insert into bmv_emisoras
       (emisora, razon_social, tipo_valor_id, estatus,
        fin_desde, fin_hasta, fin_motivo, hist_desde, hist_hasta, hist_motivo,
        raw, actualizado_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
     on conflict (emisora) do update set
       razon_social = excluded.razon_social,
       tipo_valor_id = excluded.tipo_valor_id,
       estatus = excluded.estatus,
       fin_desde = excluded.fin_desde,
       fin_hasta = excluded.fin_hasta,
       fin_motivo = excluded.fin_motivo,
       hist_desde = excluded.hist_desde,
       hist_hasta = excluded.hist_hasta,
       hist_motivo = excluded.hist_motivo,
       raw = excluded.raw,
       actualizado_at = now()`,
    [e.emisora, e.razon_social || null, e.tipo_valor_id || null, e.estatus || null,
     e.fin_desde || null, e.fin_hasta || null, e.fin_motivo || null,
     e.hist_desde || null, e.hist_hasta || null, e.hist_motivo || null,
     JSON.stringify(e.raw ?? {})],
  );
}

/** ICS = tipo_valor_id '1'. Es el universo del backtest (bancos y FIBRAs fuera). */
async function emisorasIcs() {
  return sql(`select * from bmv_emisoras where tipo_valor_id = '1' order by emisora`);
}
async function emisoraPorClave(clave) {
  const r = await sql(`select * from bmv_emisoras where emisora = $1`, [clave]);
  return r[0] || null;
}
async function censoResumen() {
  const [porTipo, porEstatus, total] = await Promise.all([
    sql(`select coalesce(tipo_valor_id,'(null)') as tipo, count(*)::int as n
           from bmv_emisoras group by 1 order by 2 desc`),
    sql(`select coalesce(estatus,'(null)') as estatus, count(*)::int as n
           from bmv_emisoras where tipo_valor_id = '1' group by 1 order by 2 desc`),
    sql(`select count(*)::int as n from bmv_emisoras`),
  ]);
  return { total: total[0] ? total[0].n : 0, por_tipo: porTipo, ics_por_estatus: porEstatus };
}

/* ─────────────────── financieros ─────────────────── */

async function upsertFinancieros(f) {
  const cols = CAMPOS.map((c) => c).join(', ');
  const ph = CAMPOS.map((_, i) => `$${6 + i}`).join(', ');
  const set = CAMPOS.map((c) => `${c} = excluded.${c}`).join(',\n       ');
  await sql(
    `insert into bmv_financieros
       (emisora, anio, trimestre, fecha_cierre, raw, ${cols}, faltantes, cosechado_at)
     values ($1,$2,$3,$4,$5::jsonb, ${ph}, $${6 + CAMPOS.length}::jsonb, now())
     on conflict (emisora, anio, trimestre) do update set
       fecha_cierre = excluded.fecha_cierre,
       raw = excluded.raw,
       ${set},
       faltantes = excluded.faltantes,
       cosechado_at = now()`,
    [f.emisora, f.anio, f.trimestre, f.fecha_cierre, JSON.stringify(f.raw ?? {}),
     ...CAMPOS.map((c) => (f.valores && f.valores[c] !== undefined ? f.valores[c] : null)),
     f.faltantes ? JSON.stringify(f.faltantes) : null],
  );
}

/* ─────────────────── precios ─────────────────── */

const COLS_PRECIO = ['cierre', 'apertura', 'maximo', 'minimo', 'volumen', 'importe'];

/**
 * Inserta en lotes. Un INSERT por fila serían ~116,000 round-trips a Neon;
 * a 500 filas por sentencia son ~230, y 500 × 8 columnas = 4,000 parámetros,
 * lejos del tope de 65,535 de Postgres.
 */
async function insertarPrecios(emisora, filas, lote = 500) {
  let escritas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const trozo = filas.slice(i, i + lote);
    const valores = [];
    const partes = trozo.map((f, j) => {
      const b = j * 8;
      valores.push(emisora, f.fecha, f.cierre, f.apertura, f.maximo, f.minimo, f.volumen, f.importe);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    });
    await sql(
      `insert into bmv_precios (emisora, fecha, ${COLS_PRECIO.join(', ')})
       values ${partes.join(', ')}
       on conflict (emisora, fecha) do update set
         ${COLS_PRECIO.map((c) => `${c} = excluded.${c}`).join(',\n         ')}`,
      valores,
    );
    escritas += trozo.length;
  }
  return escritas;
}

/**
 * Última fecha guardada por emisora. Es lo que hace INCREMENTAL la cosecha de
 * precios: la siguiente corrida pide sólo la cola que falta, no los 10 años
 * otra vez.
 *
 * Hace falta porque el rango del censo termina en "hoy", así que la clave del
 * ledger se movería cada día y lo ya cosechado dejaría de reconocerse como
 * cosechado — una fuga de idempotencia que, bajo un costo por dato, se paga
 * con el presupuesto entero.
 */
async function ultimaFechaPrecios() {
  const r = await sql(`select emisora, max(fecha) as hasta from bmv_precios group by 1`);
  const m = new Map();
  for (const x of r) m.set(x.emisora, String(x.hasta).slice(0, 10));
  return m;
}

/* ─────────────────── ledger ─────────────────── */

async function marcarLedger(job, emisora, clave, campos = {}) {
  await sql(
    `insert into bmv_harvest_ledger (job, emisora, clave, estado, intentos, filas, requests, error_msg, actualizado_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (job, emisora, clave) do update set
       estado    = coalesce($4, bmv_harvest_ledger.estado),
       intentos  = bmv_harvest_ledger.intentos + $5,
       filas     = coalesce($6, bmv_harvest_ledger.filas),
       requests  = bmv_harvest_ledger.requests + $7,
       error_msg = $8,
       actualizado_at = now()`,
    [job, emisora, clave, campos.estado || 'pendiente', campos.intentos ?? 1,
     campos.filas ?? 0, campos.requests ?? 0, campos.error_msg || null],
  );
}

/** Lo ya resuelto NO se vuelve a pedir: ahí vive la idempotencia. */
async function clavesHechas(job) {
  const r = await sql(
    `select emisora, clave from bmv_harvest_ledger
      where job = $1 and estado in ('hecho','vacio')`, [job]);
  return new Set(r.map((x) => `${x.emisora}|${x.clave}`));
}

async function ledgerResumen() {
  const r = await sql(
    `select job, estado, count(*)::int as n, coalesce(sum(requests),0)::int as requests
       from bmv_harvest_ledger group by 1,2 order by 1,2`);
  const errores = await sql(
    `select job, emisora, clave, intentos, error_msg
       from bmv_harvest_ledger where estado = 'error'
      order by actualizado_at desc limit 25`);
  return { por_estado: r, errores };
}

/* ─────────────────── presupuesto ─────────────────── */

async function presupuesto(mes) {
  const r = await sql(`select * from bmv_api_budget where mes = $1`, [mes]);
  return r[0] || { mes, requests: 0, creditos: 0, headers: null };
}

async function gastar(mes, { requests = 1, creditos = 0, headers = null } = {}) {
  const r = await sql(
    `insert into bmv_api_budget (mes, requests, creditos, headers, actualizado_at)
     values ($1,$2,$3,$4::jsonb, now())
     on conflict (mes) do update set
       requests = bmv_api_budget.requests + $2,
       creditos = bmv_api_budget.creditos + $3,
       headers  = coalesce($4::jsonb, bmv_api_budget.headers),
       actualizado_at = now()
     returning requests, creditos`,
    [mes, requests, creditos, headers ? JSON.stringify(headers) : null]);
  return r[0] || { requests: 0, creditos: 0 };
}

/* ─────────────────── cobertura ─────────────────── */

/**
 * El reporte que se le debe a Lety antes de correr el backtest: cuánto hay,
 * de quién, y dónde están los hoyos. "Coverage" sin hoyos visibles es la
 * forma más fácil de creerle a un dataset que no lo merece.
 */
async function cobertura() {
  const [censo, finPorAnio, finPorEmisora, precios, preciosPorEmisora, benchmark, huecos] = await Promise.all([
    censoResumen(),
    sql(`select anio, count(*)::int as filas, count(distinct emisora)::int as emisoras,
                count(basicearningslosspershare)::int as con_eps
           from bmv_financieros group by 1 order by 1`),
    sql(`select emisora, count(*)::int as trimestres,
                min(anio || '-' || trimestre) as primero,
                max(anio || '-' || trimestre) as ultimo,
                count(basicearningslosspershare)::int as con_eps
           from bmv_financieros group by 1 order by 1`),
    sql(`select count(*)::int as filas, count(distinct emisora)::int as emisoras,
                min(fecha) as desde, max(fecha) as hasta,
                count(importe)::int as con_importe
           from bmv_precios`),
    sql(`select emisora, count(*)::int as dias, min(fecha) as desde, max(fecha) as hasta,
                count(importe)::int as con_importe
           from bmv_precios group by 1 order by 1`),
    sql(`select count(*)::int as dias, min(fecha) as desde, max(fecha) as hasta
           from bmv_precios where emisora = 'NAFTRAC'`),
    // Emisoras con precios pero sin un solo financiero, y al revés: cada lado
    // es una exclusión silenciosa del universo si no se mira.
    sql(`select 'precios_sin_financieros' as caso, p.emisora
           from (select distinct emisora from bmv_precios) p
           left join (select distinct emisora from bmv_financieros) f using (emisora)
          where f.emisora is null
          union all
         select 'financieros_sin_precios', f.emisora
           from (select distinct emisora from bmv_financieros) f
           left join (select distinct emisora from bmv_precios) p using (emisora)
          where p.emisora is null
          order by 1, 2`),
  ]);
  return {
    censo,
    financieros: { por_anio: finPorAnio, por_emisora: finPorEmisora },
    precios: { total: precios[0] || null, por_emisora: preciosPorEmisora },
    benchmark: { emisora: 'NAFTRAC', ...(benchmark[0] || {}) },
    huecos,
    ledger: await ledgerResumen(),
  };
}

export {
  BMV_SCHEMA, ensureBmvSchema,
  leerMeta, guardarMeta,
  upsertEmisora, emisorasIcs, emisoraPorClave, censoResumen,
  upsertFinancieros, insertarPrecios, ultimaFechaPrecios,
  marcarLedger, clavesHechas, ledgerResumen,
  presupuesto, gastar, cobertura,
};
