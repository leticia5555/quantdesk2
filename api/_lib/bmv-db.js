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
import { BENCHMARK, CAMPOS } from './databursatil.js';

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

  // Distribuciones de TODAS las emisoras, no sólo del benchmark. Llegan DENTRO
  // de la respuesta de /v2/emisoras, así que no cuestan un request extra.
  //
  // Existen porque los DOS lados del backtest son de RETORNO TOTAL: el
  // benchmark (NAFTRAC reparte, y su precio pelón le resta ~3%/año) y la
  // canasta (las emisoras también reparten, y medirla a precio contra un
  // benchmark total sería el mismo error con el signo volteado).
  // La fecha es la EX-CUPÓN, no la de pago: reinvertir en la de pago
  // adelantaría el flujo y metería look-ahead por la puerta de atrás.
  `create table if not exists bmv_distribuciones (
     emisora    text not null,
     fecha_ex   date not null,
     monto      numeric not null,
     cosechado_at timestamptz not null default now(),
     primary key (emisora, fecha_ex)
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

  // ── MIGRACIÓN: la SERIE ───────────────────────────────────────────
  // El probe reveló que /v2/historicos no se pide por emisora sino por
  // `emisora_serie` (WALMEX*, FEMSAUBD, AMXB, LIVEPOLC-1, NAFTRAC ISHRS), y
  // que una emisora puede tener más de una serie. O sea que la llave natural
  // de precios y del censo es la SERIE, no la emisora.
  //
  // Va como ALTER y no como CREATE porque las tablas YA existen en prod: el
  // probe corrió `ensureBmvSchema()` y las creó con la forma vieja, vacías.
  // `create table if not exists` no las tocaría, y la forma vieja se quedaría
  // ahí en silencio hasta que la cosecha fallara.
  //
  // `emisora` se queda como columna aparte: los FINANCIEROS siguen siendo por
  // emisora (ese endpoint no conoce series), así que el cruce precio↔financiero
  // se hace por ella.
  // La ENUMERACIÓN de trimestres reportados, no sólo los extremos:
  // `rango_financieros` llega como lista ("1T_2017, 1T_2018, ..., 2T_2016") y
  // puede tener huecos. Con la lista se pide sólo lo que existe.
  `alter table bmv_emisoras add column if not exists fin_periodos jsonb`,
  `alter table bmv_emisoras add column if not exists serie text`,
  `alter table bmv_emisoras add column if not exists emisora_serie text`,
  `update bmv_emisoras set emisora_serie = emisora where emisora_serie is null`,
  `alter table bmv_emisoras drop constraint if exists bmv_emisoras_pkey`,
  `create unique index if not exists bmv_emisoras_serie_uidx on bmv_emisoras (emisora_serie)`,
  `create index if not exists bmv_emisoras_emisora_idx on bmv_emisoras (emisora)`,

  `alter table bmv_precios add column if not exists emisora_serie text`,
  `update bmv_precios set emisora_serie = emisora where emisora_serie is null`,
  `alter table bmv_precios drop constraint if exists bmv_precios_pkey`,
  `create unique index if not exists bmv_precios_uidx on bmv_precios (emisora_serie, fecha)`,
  `create index if not exists bmv_precios_emisora_idx on bmv_precios (emisora)`,

  `alter table bmv_distribuciones add column if not exists emisora_serie text`,
  `update bmv_distribuciones set emisora_serie = emisora where emisora_serie is null`,
  `alter table bmv_distribuciones drop constraint if exists bmv_distribuciones_pkey`,

  // ── La forma real del reparto ─────────────────────────────────────
  // La llave de fecha que manda la API es la de **PAGO**; la ex viene en
  // `fechaexcupon` y SÓLO en el bloque "reciente". Todo el histórico llega sin
  // ella, así que se aproxima (pago − 3 días) y la fila queda MARCADA.
  //
  // Se re-llavea por (emisora_serie, fecha_pago) y no por fecha_ex: la de pago
  // es la que la fuente garantiza siempre. Con la ex de llave, una aproximación
  // podría chocar con una ex real de otro reparto y perderse una fila.
  `alter table bmv_distribuciones add column if not exists fecha_pago date`,
  `alter table bmv_distribuciones add column if not exists ex_aproximada boolean`,
  `alter table bmv_distribuciones add column if not exists tipo text`,
  `alter table bmv_distribuciones add column if not exists divisa text`,
  `alter table bmv_distribuciones add column if not exists es_efectivo boolean`,
  // Marca las filas donde dos repartos del MISMO día se sumaron. Existe porque
  // la alternativa —elegir uno en silencio— pierde dinero sin dejar rastro.
  `alter table bmv_distribuciones add column if not exists pago_consolidado boolean`,
  // Clasificación EXPLÍCITA del reparto (efectivo/reembolso/especie/desconocido)
  // y bandera de moneda extranjera. Las dos existen para que la decisión de qué
  // entra al retorno total sea una consulta, no un regex enterrado en el parser.
  `alter table bmv_distribuciones add column if not exists categoria text`,
  `alter table bmv_distribuciones add column if not exists requiere_conversion boolean`,
  `update bmv_distribuciones set fecha_pago = fecha_ex where fecha_pago is null`,
  `drop index if exists bmv_distribuciones_uidx`,
  `create unique index if not exists bmv_distribuciones_pago_uidx on bmv_distribuciones (emisora_serie, fecha_pago)`,
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
       (emisora, serie, emisora_serie, razon_social, tipo_valor_id, estatus,
        fin_desde, fin_hasta, fin_motivo, fin_periodos, hist_desde, hist_hasta,
        hist_motivo, raw, actualizado_at)
     values ($1,$12,$13,$2,$3,$4,$5,$6,$7,$14::jsonb,$8,$9,$10,$11::jsonb, now())
     on conflict (emisora_serie) do update set
       emisora = excluded.emisora,
       fin_periodos = excluded.fin_periodos,
       serie = excluded.serie,
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
     JSON.stringify(e.raw ?? {}), e.serie ?? null, e.emisora_serie || e.emisora,
     e.fin_periodos ? JSON.stringify(e.fin_periodos) : null],
  );
}

/** ICS = tipo_valor_id '1'. Es el universo del backtest (bancos y FIBRAs fuera). */
async function emisorasIcs() {
  return sql(`select * from bmv_emisoras where tipo_valor_id = '1' order by emisora, serie`);
}
async function emisoraPorClave(clave) {
  const r = await sql(
    `select * from bmv_emisoras where emisora_serie = $1 or emisora = $1
      order by (emisora_serie = $1) desc limit 1`, [clave]);
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

/* ─────────────────── distribuciones ─────────────────── */

async function insertarDistribuciones(emisora, emisora_serie, filas) {
  if (!filas.length) return 0;

  // RED DE SEGURIDAD, no la lógica principal. Postgres rechaza la sentencia
  // entera con "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // si la misma llave aparece dos veces en el mismo VALUES — y eso tumbó una
  // corrida completa de reparse. La consolidación de verdad vive en
  // `consolidarDistribuciones`, donde se puede decidir con criterio; esto sólo
  // garantiza que ninguna ruta futura vuelva a mandar duplicados a la base.
  const porFecha = new Map();
  for (const f of filas) {
    if (!f || !f.fecha_pago) continue;
    const previa = porFecha.get(f.fecha_pago);
    // Ante empate, gana la que traiga la fecha ex real.
    if (!previa || (previa.ex_aproximada === true && f.ex_aproximada === false)) {
      porFecha.set(f.fecha_pago, f);
    }
  }
  const unicas = [...porFecha.values()];
  if (!unicas.length) return 0;

  const valores = [];
  const partes = unicas.map((f, j) => {
    const b = j * 12;
    valores.push(emisora, emisora_serie, f.fecha_pago, f.fecha_ex,
      f.ex_aproximada === true, f.monto, f.tipo ?? null, f.divisa ?? null,
      f.es_efectivo !== false, f.pago_consolidado === true,
      f.categoria ?? 'efectivo', f.requiere_conversion === true);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`;
  });
  await sql(
    `insert into bmv_distribuciones
       (emisora, emisora_serie, fecha_pago, fecha_ex, ex_aproximada, monto, tipo,
        divisa, es_efectivo, pago_consolidado, categoria, requiere_conversion)
     values ${partes.join(', ')}
     on conflict (emisora_serie, fecha_pago) do update set
       emisora = excluded.emisora,
       fecha_ex = excluded.fecha_ex,
       ex_aproximada = excluded.ex_aproximada,
       monto = excluded.monto,
       tipo = excluded.tipo,
       divisa = excluded.divisa,
       es_efectivo = excluded.es_efectivo,
       pago_consolidado = excluded.pago_consolidado,
       categoria = excluded.categoria,
       requiere_conversion = excluded.requiere_conversion`,
    valores);
  return unicas.length;
}

/**
 * Las filas de financieros con su crudo, paginadas. Es el insumo del re-parseo
 * de 0 créditos: la respuesta completa ya está guardada, así que corregir la
 * normalización no cuesta nada más que CPU.
 */
async function financierosCrudos({ limite = 200, desde = null } = {}) {
  const cond = desde
    ? `where (emisora, anio, trimestre) > ($2, $3, $4)`
    : '';
  const params = desde ? [limite, desde.emisora, desde.anio, desde.trimestre] : [limite];
  return sql(
    `select emisora, anio, trimestre, raw
       from bmv_financieros ${cond}
      order by emisora, anio, trimestre
      limit $1`, params);
}

/** Actualiza SÓLO los campos normalizados; el crudo no se toca. */
async function actualizarFinancieros(f) {
  const set = CAMPOS.map((c, i) => `${c} = $${4 + i}`).join(', ');
  await sql(
    `update bmv_financieros set ${set}, faltantes = $${4 + CAMPOS.length}::jsonb
      where emisora = $1 and anio = $2 and trimestre = $3`,
    [f.emisora, f.anio, f.trimestre,
     ...CAMPOS.map((c) => (f.valores && f.valores[c] !== undefined ? f.valores[c] : null)),
     f.faltantes ? JSON.stringify(f.faltantes) : null]);
}

/* ─────────────────── precios ─────────────────── */

const COLS_PRECIO = ['cierre', 'apertura', 'maximo', 'minimo', 'volumen', 'importe'];

/**
 * Inserta en lotes. Un INSERT por fila serían ~116,000 round-trips a Neon;
 * a 500 filas por sentencia son ~230, y 500 × 8 columnas = 4,000 parámetros,
 * lejos del tope de 65,535 de Postgres.
 */
async function insertarPrecios(emisora, emisora_serie, filas, lote = 500) {
  let escritas = 0;
  for (let i = 0; i < filas.length; i += lote) {
    const trozo = filas.slice(i, i + lote);
    const valores = [];
    const partes = trozo.map((f, j) => {
      const b = j * 9;
      valores.push(emisora, emisora_serie, f.fecha, f.cierre, f.apertura, f.maximo, f.minimo, f.volumen, f.importe);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    });
    await sql(
      `insert into bmv_precios (emisora, emisora_serie, fecha, ${COLS_PRECIO.join(', ')})
       values ${partes.join(', ')}
       on conflict (emisora_serie, fecha) do update set
         emisora = excluded.emisora,
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
  const r = await sql(`select emisora_serie, max(fecha) as hasta from bmv_precios group by 1`);
  const m = new Map();
  for (const x of r) m.set(x.emisora_serie, String(x.hasta).slice(0, 10));
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

// Tope de reintentos por clave. Un 400 no se arregla martillando: VISTAC llevaba
// 6 intentos y GAVB 10, y cada corrida los volvía a pedir porque 'error' no
// contaba como resuelto. A la tercera se deja de intentar y se reporta.
const MAX_INTENTOS = 3;

/**
 * Lo ya resuelto NO se vuelve a pedir: ahí vive la idempotencia.
 *
 * `vacio`/`sin_campos` también cuentan como resueltos: la respuesta está
 * guardada en crudo, así que arreglarlos es re-parsear (0 créditos), no
 * re-pedirlos. Y un `error` con demasiados intentos se para: seguir pidiéndolo
 * cada corrida es gastar créditos en el mismo 400.
 */
async function clavesHechas(job, { reintentar = false } = {}) {
  const r = await sql(
    `select emisora, clave from bmv_harvest_ledger
      where job = $1
        and (estado in ('hecho','vacio','sin_campos')
             or (estado = 'error' and intentos >= $2))`,
    [job, reintentar ? 1e9 : MAX_INTENTOS]);
  return new Set(r.map((x) => `${x.emisora}|${x.clave}`));
}

/** Las claves que se dejaron de intentar, para que no desaparezcan del reporte. */
async function clavesAgotadas(job) {
  return sql(
    `select emisora, clave, intentos, error_msg
       from bmv_harvest_ledger
      where job = $1 and estado = 'error' and intentos >= $2
      order by intentos desc limit 25`, [job, MAX_INTENTOS]);
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
  const [censo, finPorAnio, finPorEmisora, precios, preciosPorEmisora, benchmark,
         dist, distIcs, divisas, tipos, categorias, extranjeras, icsSinReparto, huecos] = await Promise.all([
    censoResumen(),
    sql(`select anio, count(*)::int as filas, count(distinct emisora)::int as emisoras,
                count(basicearningslosspershare)::int as con_eps,
                count(revenue)::int as con_revenue,
                count(assets)::int as con_assets
           from bmv_financieros group by 1 order by 1`),
    sql(`select emisora, count(*)::int as trimestres,
                min(anio || '-' || trimestre) as primero,
                max(anio || '-' || trimestre) as ultimo,
                count(basicearningslosspershare)::int as con_eps
           from bmv_financieros group by 1 order by 1`),
    sql(`select count(*)::int as filas, count(distinct emisora_serie)::int as series,
                count(distinct emisora)::int as emisoras,
                min(fecha) as desde, max(fecha) as hasta,
                count(importe)::int as con_importe
           from bmv_precios`),
    sql(`select emisora_serie, emisora, count(*)::int as dias,
                min(fecha) as desde, max(fecha) as hasta,
                count(importe)::int as con_importe
           from bmv_precios group by 1,2 order by 1`),
    sql(`select count(*)::int as dias, min(fecha) as desde, max(fecha) as hasta
           from bmv_precios where emisora_serie = $1`, [BENCHMARK]),
    sql(`select count(*)::int as n, min(fecha_ex) as desde, max(fecha_ex) as hasta,
                coalesce(sum(monto),0)::numeric as suma
           from bmv_distribuciones where emisora_serie = $1`, [BENCHMARK]),
    // Sin dividendos por emisora, la canasta NO se puede medir a retorno total
    // y la simetría se rompe justo en los nombres que faltan. Se reporta
    // cuántas ICS tienen reparto y cuántas no: un hueco aquí subestima a la
    // canasta contra un benchmark que sí los trae.
    sql(`select count(distinct d.emisora)::int as emisoras_con_reparto,
                count(*)::int as filas,
                min(d.fecha_ex) as desde, max(d.fecha_ex) as hasta,
                count(*) filter (where d.ex_aproximada)::int as ex_aproximadas,
                count(*) filter (where not coalesce(d.es_efectivo, true))::int as no_efectivo,
                count(*) filter (where d.pago_consolidado)::int as consolidados,
                count(*) filter (where abs(d.monto) < 0.0001)::int as bajo_umbral,
                count(*) filter (where d.requiere_conversion)::int as requieren_conversion
           from bmv_distribuciones d
           join bmv_emisoras e on e.emisora = d.emisora and e.tipo_valor_id = '1'`),
    // Una divisa distinta de MXN exige conversión. Asumirla en silencio es la
    // clase de bug que este proyecto lleva cuatro rondas cazando.
    sql(`select coalesce(divisa,'(sin divisa)') as divisa, count(*)::int as n
           from bmv_distribuciones group by 1 order by 2 desc`),
    sql(`select coalesce(tipo,'(sin tipo)') as tipo, count(*)::int as n
           from bmv_distribuciones group by 1 order by 2 desc`),
    sql(`select coalesce(categoria,'(sin categoria)') as categoria, count(*)::int as n,
                coalesce(sum(monto),0)::numeric as suma
           from bmv_distribuciones group by 1 order by 2 desc`),
    // QUÉ series están afectadas por la divisa extranjera, y si están en el
    // universo ICS. Sin esta lista, "hay 14 repartos en moneda extranjera" no
    // se puede accionar: lo que importa es a quién le pegan.
    sql(`select d.emisora_serie, d.divisa, count(*)::int as n,
                coalesce(sum(d.monto),0)::numeric as suma,
                e.tipo_valor_id, e.estatus
           from bmv_distribuciones d
           left join bmv_emisoras e on e.emisora_serie = d.emisora_serie
          where d.requiere_conversion
          group by 1,2,5,6 order by 3 desc`),
    sql(`select e.emisora
           from bmv_emisoras e
           left join (select distinct emisora from bmv_distribuciones) d
             on d.emisora = e.emisora
          where e.tipo_valor_id = '1' and d.emisora is null
          order by 1`),
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
    benchmark: { emisora: BENCHMARK, ...(benchmark[0] || {}), distribuciones: dist[0] || null },
    // Insumo del retorno total de la CANASTA. Se reporta aparte del benchmark
    // porque un hueco aquí no es un hueco cualquiera: rompe la simetría.
    distribuciones_ics: (() => {
      const d = distIcs[0] || {};
      return {
        ...d,
        // El porcentaje, no sólo el conteo: "12 aproximadas" no dice nada sin
        // saber si son 12 de 15 o 12 de 4,000.
        pct_ex_aproximada: d.filas ? Math.round((100 * (d.ex_aproximadas || 0)) / d.filas) : 0,
        por_divisa: divisas,
        por_tipo: tipos,
        por_categoria: categorias,
        // La lista accionable: series con reparto en moneda extranjera.
        series_divisa_extranjera: extranjeras,
        series_divisa_extranjera_ics: extranjeras.filter((x) => x.tipo_valor_id === '1'),
        ics_sin_reparto: icsSinReparto.map((x) => x.emisora),
      };
    })(),
    huecos,
    ledger: await ledgerResumen(),
  };
}

export {
  BMV_SCHEMA, ensureBmvSchema,
  leerMeta, guardarMeta,
  upsertEmisora, emisorasIcs, emisoraPorClave, censoResumen,
  MAX_INTENTOS,
  upsertFinancieros, insertarPrecios, insertarDistribuciones, ultimaFechaPrecios,
  marcarLedger, clavesHechas, clavesAgotadas, ledgerResumen, financierosCrudos,
  actualizarFinancieros,
  presupuesto, gastar, cobertura,
};
