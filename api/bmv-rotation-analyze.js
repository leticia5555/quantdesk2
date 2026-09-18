// ═══════════════════════════════════════════════════════════════════
// /api/bmv-rotation-analyze — Fase B. SOLO LECTURA.
//
// Una pregunta: ¿una rotación mensual Value + Momentum sobre emisoras ICS de
// la BMV bate a NAFTRAC de forma OPERABLE y sin look-ahead?
//
//   GET ?format=md          → el reporte en español (lo que se lee)
//   GET                     → JSON completo
//   GET ?canastas=1         → agrega el detalle canasta por canasta
//   GET ?sensibilidades=0   → sólo el caso base (más rápido)
//
// ── Los criterios NO se deciden acá ────────────────────────────────
// Están congelados en docs/bmv-rotation.md §3 y viven en
// `_lib/bmv-rotation.js` / `_lib/bmv-elegibilidad.js` como constantes. Este
// archivo trae filas de Neon y las pasa por esas funciones; no tiene un solo
// umbral propio. Si alguien afloja uno, el diff contra el documento lo enseña.
//
// ── SOLO LECTURA, en serio ─────────────────────────────────────────
// Cero writes. NO llama a `ensureBmvSchema()` —eso hace CREATE TABLE y ALTER—
// ni toca el ledger ni el presupuesto. Cuesta **0 créditos** de DataBursatil:
// todo sale de lo ya cosechado en la Fase A. `tests/bmv-rotation.test.mjs`
// captura toda consulta que cruce la frontera y falla si alguna no empieza
// con SELECT o WITH.
//
// ── Gate ───────────────────────────────────────────────────────────
// `Authorization: Bearer <ADMIN_SECRET>` (fallback CRON_SECRET). Sin secret
// configurado no se contesta: fail closed, mismo patrón que /api/bmv-harvest.
//
// ── Por qué no se traen 569,589 filas ──────────────────────────────
// El ranking sólo necesita el cierre del día anterior al rebalanceo y dos
// anclas de momentum: todo eso cabe en los CIERRES MENSUALES (~22,000 filas).
// Los precios diarios se piden únicamente para los nombres que la canasta
// llegó a tener y sólo durante los días que los tuvo. Traerse el histórico
// completo para calcular 111 rankings sería pagar 25× por el mismo número.
//
// ENV VARS: DATABASE_URL · ADMIN_SECRET (o CRON_SECRET)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { BENCHMARK, BENCHMARK_EMISORA, BENCHMARK_SERIE, BENCHMARK_TIPO } from './_lib/databursatil.js';
import {
  LAG_DIAS, UMBRAL_IMPORTE, PISO_CANASTA, TECHO_CANASTA, FRACCION_QUINTIL,
  TRIMESTRES_TTM, SERIES_SIN_PRECIOS, mediana,
} from './_lib/bmv-elegibilidad.js';
import {
  COSTO_BP_POR_LADO, FRACCION_DECIL, LAG_SENSIBILIDAD, UMBRAL_BP_DIVISA,
  bpNoContados, construyeCanastas, estadisticas, excesoDiario,
  regimenDeCanastas, serieBenchmark, simula, veredicto,
} from './_lib/bmv-rotation.js';

export const maxDuration = 300;

// La ventana. Arranca en 2017-07 porque el primer TTM completo necesita 4
// trimestres desde 2T2016 y, con el rezago de 65 días, el cuarto (1T2017,
// cierre 31-mar) recién está disponible en junio de 2017.
const DESDE = /* date-lint-ok: arranque declarado de la ventana, fijado por la cobertura de datos */ '2017-07-01';
const HASTA = /* date-lint-ok: cierre declarado de la ventana */ '2026-09-30';

/* ═══════════════ auth ═══════════════ */

function adminSecret() {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;
}
function authorized(req) {
  const secret = adminSecret();
  if (!secret) return false;                        // fail closed
  const h = (req.headers && req.headers.authorization) || '';
  if (h === `Bearer ${secret}`) return true;
  return !!process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`;
}

/* ═══════════════ las consultas (todas SELECT) ═══════════════ */

/** El calendario real de la BMV: los días en que algo operó. */
async function calendarioBmv(desde, hasta) {
  const r = await sql(
    `select distinct fecha::text as fecha
       from bmv_precios
      where fecha >= $1::date and fecha <= $2::date
      order by 1`, [desde, hasta]);
  return r.map((x) => x.fecha);
}

/** Primer día CON PRECIO de cada mes — el calendario manda, no el almanaque. */
async function fechasRebalanceo(desde, hasta) {
  const r = await sql(
    `select min(fecha)::text as fecha
       from bmv_precios
      where fecha >= $1::date and fecha <= $2::date
      group by date_trunc('month', fecha)
      order by 1`, [desde, hasta]);
  return r.map((x) => x.fecha);
}

/** Las series ICS del censo. El benchmark es tipo '1B' y no empata con '1'. */
async function seriesIcs() {
  return sql(
    `select emisora_serie, emisora
       from bmv_emisoras
      where tipo_valor_id = '1' and emisora_serie is not null
      order by 1`);
}

/** EPS por emisora × cierre, ordenado. El value sale de acá. */
async function epsPorCierre() {
  return sql(
    `select emisora, fecha_cierre::text as fecha_cierre,
            basicearningslosspershare as eps
       from bmv_financieros
      where basicearningslosspershare is not null
      order by emisora, fecha_cierre`);
}

/**
 * El ÚLTIMO cierre operado de cada mes, por serie.
 *
 * Es el atajo que hace barata toda la Fase B: para un rebalanceo en el primer
 * día hábil del mes M, el «cierre del día anterior» ES el último cierre de
 * M−1. El mismo mapa sirve para el ranking y para las dos anclas de momentum.
 */
async function cierresMensuales(desde, hasta) {
  return sql(
    `select distinct on (emisora_serie, date_trunc('month', fecha))
            emisora_serie,
            date_trunc('month', fecha)::date::text as mes,
            fecha::text as fecha,
            cierre
       from bmv_precios
      where cierre is not null
        and fecha >= ($1::date - interval '14 months')
        and fecha <= $2::date
      order by emisora_serie, date_trunc('month', fecha), fecha desc`,
    [desde, hasta]);
}

/** Mediana de importe operado de los últimos 3 meses, en cada rebalanceo. */
async function medianasImporte(desde, hasta) {
  return sql(
    `with fechas as (
       select min(fecha) as fecha
         from bmv_precios
        where fecha >= $1::date and fecha <= $2::date
        group by date_trunc('month', fecha)
     )
     select f.fecha::text as fecha, p.emisora_serie,
            percentile_cont(0.5) within group (order by p.importe) as mediana
       from fechas f
       join bmv_precios p
         on p.fecha > f.fecha - interval '3 months' and p.fecha <= f.fecha
      group by 1, 2`, [desde, hasta]);
}

/** Cierres diarios, SÓLO de los nombres que la canasta tuvo y cuando los tuvo. */
async function preciosDeVentanas(ventanas) {
  if (!ventanas.length) return [];
  return sql(
    `with v as (
       select x->>0 as serie, (x->>1)::date as ini, (x->>2)::date as fin
         from jsonb_array_elements($1::jsonb) as x
     )
     select v.serie as emisora_serie, p.fecha::text as fecha, p.cierre
       from v
       join bmv_precios p
         on p.emisora_serie = v.serie and p.fecha >= v.ini and p.fecha <= v.fin
      where p.cierre is not null`,
    [JSON.stringify(ventanas)]);
}

/**
 * Repartos que SÍ entran al retorno total, en las mismas ventanas.
 *
 * El `where` es la decisión congelada de §3.3 hecha consulta: efectivo, no
 * reembolso ni especie, y sin moneda extranjera pendiente de convertir.
 */
async function dividendosDeVentanas(ventanas) {
  if (!ventanas.length) return [];
  return sql(
    `with v as (
       select x->>0 as serie, (x->>1)::date as ini, (x->>2)::date as fin
         from jsonb_array_elements($1::jsonb) as x
     )
     select v.serie as emisora_serie, d.fecha_ex::text as fecha, sum(d.monto) as monto
       from v
       join bmv_distribuciones d
         on d.emisora_serie = v.serie and d.fecha_ex >= v.ini and d.fecha_ex <= v.fin
      where d.categoria = 'efectivo'
        and coalesce(d.requiere_conversion, false) = false
      group by 1, 2`,
    [JSON.stringify(ventanas)]);
}

/** La serie del benchmark: cierres diarios y sus repartos. */
async function serieDelBenchmark(desde, hasta) {
  const [precios, dividendos] = await Promise.all([
    sql(`select fecha::text as fecha, cierre
           from bmv_precios
          where emisora_serie = $1 and fecha >= $2::date and fecha <= $3::date
            and cierre is not null
          order by 1`, [BENCHMARK, desde, hasta]),
    sql(`select fecha_ex::text as fecha, sum(monto) as monto
           from bmv_distribuciones
          where emisora_serie = $1 and fecha_ex >= $2::date and fecha_ex <= $3::date
            and categoria = 'efectivo'
            and coalesce(requiere_conversion, false) = false
          group by 1 order by 1`, [BENCHMARK, desde, hasta]),
  ]);
  return { precios, dividendos };
}

/**
 * Los repartos EXCLUIDOS por moneda extranjera, con el precio de su fecha ex.
 *
 * Se trae el precio del mismo día para poder decir cuántos puntos base de
 * retorno quedaron sin contar (§3.3): excluir en silencio convertiría una
 * decisión defendible en un hueco invisible.
 */
async function repartosExcluidosPorDivisa(desde, hasta) {
  return sql(
    `select d.emisora_serie, d.fecha_ex::text as fecha, d.monto, d.divisa, p.cierre as precio
       from bmv_distribuciones d
       join bmv_emisoras e on e.emisora_serie = d.emisora_serie and e.tipo_valor_id = '1'
       left join bmv_precios p
         on p.emisora_serie = d.emisora_serie and p.fecha = d.fecha_ex
      where d.requiere_conversion = true
        and d.fecha_ex >= $1::date and d.fecha_ex <= $2::date
      order by 1, 2`, [desde, hasta]);
}

/** El caveat del encabezado: qué porcentaje de fechas ex es aproximada. */
async function coberturaFechaEx() {
  const r = await sql(
    `select count(*)::int as total,
            count(*) filter (where ex_aproximada)::int as aproximadas
       from bmv_distribuciones`);
  const f = r[0] || { total: 0, aproximadas: 0 };
  return {
    total: f.total,
    aproximadas: f.aproximadas,
    pct_ex_aproximada: f.total ? f.aproximadas / f.total : null,
  };
}

/* ═══════════════ ventanas de tenencia ═══════════════ */

/**
 * De las canastas a los intervalos (serie, desde, hasta) que hay que traer.
 *
 * Una canasta armada el día `t_k` se sostiene hasta `t_{k+1}` inclusive: el
 * cierre de `t_{k+1}` es a la vez el último día de esa canasta y la base del
 * primer retorno de la siguiente. Los intervalos de una misma serie que se
 * tocan se FUSIONAN — un nombre que sobrevive doce rebalanceos seguidos vale
 * un intervalo, no doce.
 */
function ventanasDeTenencia(listasDeCanastas, calendario) {
  const ultima = calendario[calendario.length - 1];
  const porSerie = new Map();
  for (const canastas of listasDeCanastas) {
    for (let k = 0; k < canastas.length; k++) {
      const ini = canastas[k].fecha;
      const fin = k + 1 < canastas.length ? canastas[k + 1].fecha : ultima;
      for (const serie of canastas[k].nombres) {
        if (!porSerie.has(serie)) porSerie.set(serie, []);
        porSerie.get(serie).push([ini, fin]);
      }
    }
  }
  const out = [];
  for (const [serie, rangos] of porSerie) {
    rangos.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let actual = null;
    for (const [ini, fin] of rangos) {
      if (actual && ini <= actual[1]) {
        if (fin > actual[1]) actual[1] = fin;
      } else {
        if (actual) out.push([serie, actual[0], actual[1]]);
        actual = [ini, fin];
      }
    }
    if (actual) out.push([serie, actual[0], actual[1]]);
  }
  return out;
}

/** Filas planas → Map serie → Map fecha → número. */
function indexaPorSerieYFecha(filas, campo) {
  const m = new Map();
  for (const f of filas) {
    if (!m.has(f.emisora_serie)) m.set(f.emisora_serie, new Map());
    m.get(f.emisora_serie).set(f.fecha, Number(f[campo]));
  }
  return m;
}

/* ═══════════════ una especificación completa ═══════════════ */

/**
 * Corre una especificación de punta a punta y devuelve sus cuatro series.
 *
 * Las CUATRO existen para que la asimetría sea auditable (§3.3): con canasta
 * y benchmark a precio y a total, cualquiera puede medir cuánto valían los
 * dividendos de cada lado y comprobar que la corrección no fabricó el
 * resultado. El veredicto se lee **total vs total**.
 */
function corre({ canastas, calendario, precios, dividendos, benchPrecios, benchDividendos }) {
  const total = simula({ canastas, calendario, preciosPorSerie: precios, dividendosPorSerie: dividendos, conDividendos: true });
  const precio = simula({ canastas, calendario, preciosPorSerie: precios, dividendosPorSerie: dividendos, conDividendos: false });
  if (!total || !precio) return null;

  const benchTotal = serieBenchmark({ precios: benchPrecios, dividendos: benchDividendos, fechas: total.fechas, conDividendos: true });
  const benchPrecio = serieBenchmark({ precios: benchPrecios, dividendos: benchDividendos, fechas: total.fechas, conDividendos: false });

  const exceso = excesoDiario(total.retornos, benchTotal.retornos);
  const regimen = regimenDeCanastas(canastas);
  const v = veredicto({
    exceso,
    sharpeCanasta: estadisticas(total.retornos).sharpe,
    sharpeBenchmark: estadisticas(benchTotal.retornos).sharpe,
    rebalanceos: canastas.length,
    universoMediano: mediana(canastas.map((c) => c.elegibles)),
    regimen,
  });

  return {
    veredicto: v,
    regimen,
    series: {
      canasta_total: { ...estadisticas(total.retornos, total.curva), equity_final: total.equity_final },
      canasta_precio: { ...estadisticas(precio.retornos, precio.curva), equity_final: precio.equity_final },
      naftrac_total: { ...estadisticas(benchTotal.retornos, benchTotal.curva), equity_final: benchTotal.equity_final },
      naftrac_precio: { ...estadisticas(benchPrecio.retornos, benchPrecio.curva), equity_final: benchPrecio.equity_final },
    },
    // Cuánto aportaron los dividendos de cada lado — el ~3%/año que motivó
    // medir los dos lados a retorno total deja de ser una cifra citada de oído.
    aporte_dividendos: {
      canasta_pp: pp(total, precio),
      naftrac_pp: pp(benchTotal, benchPrecio),
    },
    operativa: {
      rebalanceos: canastas.length,
      elegibles_mediano: mediana(canastas.map((c) => c.elegibles)),
      canasta_mediana: mediana(canastas.map((c) => c.tamano)),
      turnover_medio: total.turnover_medio,
      turnover_mediana: total.turnover_mediana,
      costo_total: total.costo_total,
      dividendos_reinvertidos: total.dividendos_reinvertidos,
      antiguedad_ttm_mediana_dias: mediana(canastas.map((c) => c.antiguedad_ttm_mediana)),
    },
  };
}

/** Diferencia anualizada entre la versión total y la de precio, en puntos %. */
function pp(total, precio) {
  const a = estadisticas(total.retornos).retorno_anualizado;
  const b = estadisticas(precio.retornos).retorno_anualizado;
  return a === null || b === null ? null : (a - b) * 100;
}

/* ═══════════════ el análisis completo ═══════════════ */

async function analiza({ desde = DESDE, hasta = HASTA, conSensibilidades = true, conCanastas = false } = {}) {
  const [calendario, fechas, series, eps, mensuales, medianasRaw, bench, excluidosDivisa, exAprox] =
    await Promise.all([
      calendarioBmv(desde, hasta),
      fechasRebalanceo(desde, hasta),
      seriesIcs(),
      epsPorCierre(),
      cierresMensuales(desde, hasta),
      medianasImporte(desde, hasta),
      serieDelBenchmark(desde, hasta),
      repartosExcluidosPorDivisa(desde, hasta),
      coberturaFechaEx(),
    ]);

  const epsPorEmisora = new Map();
  for (const e of eps) {
    if (!epsPorEmisora.has(e.emisora)) epsPorEmisora.set(e.emisora, []);
    epsPorEmisora.get(e.emisora).push(e);
  }
  const mensualesPorSerie = new Map();
  for (const m of mensuales) {
    if (!mensualesPorSerie.has(m.emisora_serie)) mensualesPorSerie.set(m.emisora_serie, new Map());
    const mes = Number(m.mes.slice(0, 4)) * 12 + (Number(m.mes.slice(5, 7)) - 1);
    mensualesPorSerie.get(m.emisora_serie).set(mes, { fecha: m.fecha, cierre: Number(m.cierre) });
  }
  const medianas = new Map();
  for (const m of medianasRaw) {
    medianas.set(`${m.fecha}|${m.emisora_serie}`, m.mediana === null ? null : Number(m.mediana));
  }

  const base = { fechas, series, epsPorEmisora, mensualesPorSerie, medianas };

  // Las especificaciones. La PRIMERA es el caso base; las demás son
  // atribución (§3.5) y no pueden promover nada.
  const especificaciones = [
    { clave: 'base', titulo: 'Caso base — quintil, value + momentum', opciones: {} },
  ];
  if (conSensibilidades) {
    especificaciones.push(
      { clave: 'decil', titulo: 'Sensibilidad — decil superior', opciones: { fraccion: FRACCION_DECIL } },
      { clave: 'value', titulo: 'Sensibilidad — sólo value', opciones: { score: 'value' } },
      { clave: 'momentum', titulo: 'Sensibilidad — sólo momentum', opciones: { score: 'momentum' } },
      { clave: 'lag90', titulo: 'Sensibilidad — rezago de 90 días', opciones: { lagDias: LAG_SENSIBILIDAD } },
    );
  }

  const construidas = especificaciones.map((e) => ({
    ...e, ...construyeCanastas({ ...base, ...e.opciones }),
  }));

  // UNA sola consulta de precios diarios para todas las especificaciones: sus
  // canastas se solapan mucho, así que los intervalos fusionados son bastante
  // menos que la suma de los pedazos.
  const ventanas = ventanasDeTenencia(construidas.map((c) => c.canastas), calendario);
  const [preciosRaw, dividendosRaw] = await Promise.all([
    preciosDeVentanas(ventanas),
    dividendosDeVentanas(ventanas),
  ]);
  const precios = indexaPorSerieYFecha(preciosRaw, 'cierre');
  const dividendos = indexaPorSerieYFecha(dividendosRaw, 'monto');
  const benchPrecios = new Map(bench.precios.map((p) => [p.fecha, Number(p.cierre)]));
  const benchDividendos = new Map(bench.dividendos.map((d) => [d.fecha, Number(d.monto)]));

  const resultados = {};
  for (const c of construidas) {
    const r = corre({
      canastas: c.canastas, calendario, precios, dividendos, benchPrecios, benchDividendos,
    });
    resultados[c.clave] = r ? { titulo: c.titulo, ...r, motivos: c.motivos } : { titulo: c.titulo, error: 'sin canastas' };
    if (conCanastas) resultados[c.clave].canastas = c.canastas;
  }

  const divisa = bpNoContados(excluidosDivisa, { umbral: UMBRAL_BP_DIVISA });

  return {
    endpoint: 'bmv-rotation-analyze',
    creditos: 0,
    ventana: { desde, hasta },
    // El encabezado. Los cuatro caveats van ARRIBA, no enterrados: son lo que
    // cambia cómo se lee todo lo demás.
    encabezado: {
      pct_ex_aproximada: exAprox.pct_ex_aproximada,
      fechas_ex: exAprox,
      regimen: resultados.base && resultados.base.regimen,
      bp_no_contados_por_divisa: divisa,
      series_excluidas: {
        lista: [...SERIES_SIN_PRECIOS],
        motivo: 'sin precios en /v2/historicos (HTTP 400 también con ventana corta)',
      },
    },
    criterios: {
      lag_dias: LAG_DIAS,
      umbral_importe: UMBRAL_IMPORTE,
      piso: PISO_CANASTA,
      techo: TECHO_CANASTA,
      fraccion_quintil: FRACCION_QUINTIL,
      trimestres_ttm: TRIMESTRES_TTM,
      costo_bp_por_lado: COSTO_BP_POR_LADO,
      benchmark: BENCHMARK,
      benchmark_emisora: BENCHMARK_EMISORA,
      benchmark_serie: BENCHMARK_SERIE,
      benchmark_tipo: BENCHMARK_TIPO,
    },
    insumos: {
      dias_calendario: calendario.length,
      rebalanceos: fechas.length,
      series_ics: series.length,
      filas_eps: eps.length,
      cierres_mensuales: mensuales.length,
      ventanas_de_tenencia: ventanas.length,
      filas_precio_diario: preciosRaw.length,
      filas_dividendo: dividendosRaw.length,
      dias_benchmark: bench.precios.length,
    },
    resultados,
  };
}

/* ═══════════════ markdown ═══════════════ */

const pct = (x) => (x === null || x === undefined ? 'n/d' : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 2) => (x === null || x === undefined ? 'n/d' : Number(x).toFixed(d));

function reporteMd(a) {
  const L = [];
  const b = a.resultados.base;
  L.push('# Rotación Value + Momentum sobre la BMV — Fase B', '');
  L.push(`Ventana **${a.ventana.desde} → ${a.ventana.hasta}** · benchmark **${a.criterios.benchmark}** (retorno total) · **0 créditos**.`, '');

  // ── Encabezado: los caveats que cambian cómo se lee todo ──
  const e = a.encabezado;
  L.push('> ## Antes de leer un número', '>');
  L.push(`> · **Fecha ex aproximada en ${pct(e.pct_ex_aproximada)}** de los repartos (${e.fechas_ex.aproximadas} de ${e.fechas_ex.total}).`);
  L.push('>   El histórico de la fuente no trae `fechaexcupon`; se aproxima **pago − 3 días**. Se aplica igual');
  L.push('>   a la canasta y al benchmark, así que el error se cancela a primer orden en el exceso.');
  if (e.regimen) {
    L.push(`> · **Régimen de la canasta:** piso ${pct(e.regimen.pct_piso)} · quintil ${pct(e.regimen.pct_quintil)} · techo ${pct(e.regimen.pct_techo)}.`);
    if (e.regimen.etiqueta) L.push(`>   ⚠️ **${e.regimen.etiqueta}** — el veredicto va etiquetado, pase lo que pase con |t| y Sharpe.`);
    else if (e.regimen.observacion) L.push(`>   ${e.regimen.observacion}`);
  }
  const d = e.bp_no_contados_por_divisa;
  L.push(`> · **${num(d.total_bp, 1)} bp de retorno no contados** por repartos en moneda extranjera (${d.series.length} series).`);
  L.push(`>   Umbral de revisión: **${d.umbral_bp} bp por serie**. ${d.series_sobre_umbral.length
    ? `⚠️ Lo superan: **${d.series_sobre_umbral.join(', ')}** — hay que resolverlo con /v2/divisas ANTES de leer el veredicto.`
    : 'Ninguna serie lo supera: la exclusión es inmaterial.'}`);
  L.push(`> · **Series excluidas del universo:** ${e.series_excluidas.lista.join(', ')} — ${e.series_excluidas.motivo}.`);
  L.push('>', '');

  if (!b || b.error) {
    L.push(`**No hubo canastas que simular.** ${b ? b.error : ''}`);
    return L.join('\n');
  }

  // ── Veredicto ──
  const v = b.veredicto;
  L.push(`## Veredicto: **${v.dictamen}**`, '', `${v.porque}.`, '');
  if (v.etiqueta_regimen) L.push(`> ⚠️ **Etiqueta: «${v.etiqueta_regimen}».** Es un experimento válido, pero no probó un quintil superior.`, '');
  L.push(`> ${v.advertencia_signo}`, '');

  L.push('| Puerta | Valor | |', '|---|---:|:-:|');
  for (const p of v.puertas) {
    L.push(`| ${p.puerta} | ${typeof p.valor === 'number' ? num(p.valor, 3) : (p.valor ?? 'n/d')} | ${p.pasa ? '✅' : '❌'} |`);
  }
  L.push('');

  // ── Las cuatro series ──
  L.push('## Las cuatro series', '');
  L.push('| Serie | Retorno anual | Vol anual | Sharpe | Máx. drawdown |', '|---|---:|---:|---:|---:|');
  const fila = (nombre, s) => L.push(`| ${nombre} | ${pct(s.retorno_anualizado)} | ${pct(s.vol_anualizada)} | ${num(s.sharpe)} | ${pct(s.max_drawdown)} |`);
  fila('**Canasta — total**', b.series.canasta_total);
  fila('**NAFTRAC — total**', b.series.naftrac_total);
  fila('Canasta — precio', b.series.canasta_precio);
  fila('NAFTRAC — precio', b.series.naftrac_precio);
  L.push('');
  L.push(`**El veredicto se lee total vs total.** Las de precio existen para que la asimetría sea auditable: los dividendos aportaron **${num(b.aporte_dividendos.canasta_pp, 2)} pp/año** a la canasta y **${num(b.aporte_dividendos.naftrac_pp, 2)} pp/año** a NAFTRAC.`, '');

  // ── Operativa ──
  const o = b.operativa;
  L.push('## Operativa', '', '| | |', '|---|---:|');
  L.push(`| Rebalanceos | ${o.rebalanceos} |`);
  L.push(`| Elegibles mediano | ${o.elegibles_mediano} |`);
  L.push(`| Canasta mediana | ${o.canasta_mediana} |`);
  L.push(`| Turnover medio por rebalanceo | ${pct(o.turnover_medio)} |`);
  L.push(`| Costo acumulado (${a.criterios.costo_bp_por_lado} bp/lado) | ${pct(o.costo_total)} del capital inicial |`);
  L.push(`| Antigüedad mediana del TTM | ${o.antiguedad_ttm_mediana_dias} días |`);
  L.push('');

  // ── Sensibilidades ──
  const otras = Object.entries(a.resultados).filter(([k]) => k !== 'base');
  if (otras.length) {
    L.push('## Sensibilidades — atribución, **nunca** promoción', '');
    L.push('| Especificación | Retorno anual | Sharpe | Exceso anual | t |', '|---|---:|---:|---:|---:|');
    L.push(`| **${b.titulo}** | ${pct(b.series.canasta_total.retorno_anualizado)} | ${num(b.series.canasta_total.sharpe)} | ${pct(b.veredicto.exceso_anualizado)} | ${num(b.veredicto.t)} |`);
    for (const [, r] of otras) {
      if (r.error) { L.push(`| ${r.titulo} | — | — | — | — |`); continue; }
      L.push(`| ${r.titulo} | ${pct(r.series.canasta_total.retorno_anualizado)} | ${num(r.series.canasta_total.sharpe)} | ${pct(r.veredicto.exceso_anualizado)} | ${num(r.veredicto.t)} |`);
    }
    L.push('');
    L.push('> Si el caso base sale NO-GO y alguna sensibilidad sale bonita, **el veredicto sigue siendo NO-GO**. Estas filas explican de dónde viene el resultado del caso base; no son candidatas a reemplazarlo.', '');
  }

  L.push('---', '');
  L.push(`Criterios: rezago **${a.criterios.lag_dias} días** · umbral de liquidez **${a.criterios.umbral_importe.toLocaleString('es-MX')}** pesos · canasta \`clamp(${a.criterios.fraccion_quintil} × E, ${a.criterios.piso}, ${a.criterios.techo})\` equal-weight · TTM = ${a.criterios.trimestres_ttm} trimestres · costos **${a.criterios.costo_bp_por_lado} bp por lado**.`);
  L.push('', 'Todos congelados en `docs/bmv-rotation.md` §3 **antes** de correr esto. El diff contra ese documento es la verificación.');
  return L.join('\n');
}

/* ═══════════════ handler ═══════════════ */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // La autorización va ANTES de abrir Neon. Al revés, una petición sin
  // credenciales ya habría gastado una conexión antes de su 401.
  if (!authorized(req)) {
    return res.status(401).json({
      error: 'no autorizado',
      como: adminSecret() ? 'header Authorization: Bearer <ADMIN_SECRET>' : 'falta ADMIN_SECRET en el entorno (fail closed)',
    });
  }

  const q = (req.query || {});
  try {
    const a = await analiza({
      desde: q.desde ? String(q.desde).slice(0, 10) : DESDE,
      hasta: q.hasta ? String(q.hasta).slice(0, 10) : HASTA,
      conSensibilidades: String(q.sensibilidades ?? '1') !== '0',
      conCanastas: String(q.canastas ?? '0') === '1',
    });
    if (String(q.format || '') === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(200).send(reporteMd(a));
    }
    return res.status(200).json(a);
  } catch (err) {
    return res.status(500).json({ error: `bmv-rotation-analyze: ${err.message}` });
  }
}

export {
  analiza, calendarioBmv, corre, indexaPorSerieYFecha, reporteMd, ventanasDeTenencia,
};
