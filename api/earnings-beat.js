// ═══════════════════════════════════════════════════════════════════
// /api/earnings-beat — FASE 0 del experimento "earnings-beat": CENSO + SMOKE.
//
// Pregunta del experimento: ¿QuantDesk predice beat/miss de EPS mejor que
// Polymarket? Ver docs/earnings-beat-scope.md.
//
//   GET /api/earnings-beat?smoke=1            → censo completo (JSON)
//   GET /api/earnings-beat?smoke=1&format=md  → el mismo censo, en español
//   GET /api/earnings-beat?vista=live         → vista EN VIVO (pública, para
//                                               la tab EARNINGS): mercados
//                                               abiertos + base histórica
//   GET /api/earnings-beat?vista=live&diag=MU,COST
//                                             → base histórica de esos
//                                               símbolos (solo DB), con los
//                                               3 trimestres más extremos
//   GET /api/earnings-beat?vista=live&diag=escala
//   GET /api/earnings-beat?vista=live&diag=desacuerdos   → la fila en la mano:
//       pregunta literal del mercado, umbral declarado, nivel de EPS y dictamen
//                                             → cuántos de los 99 tienen
//                                               estimados de escala chica
//                                               (medición, no cambia la UI)
//   GET /api/earnings-beat                    → qué es esto + en qué fase va
//
// Parámetros del censo (todos opcionales):
//   ?meses=12      ventana hacia atrás (default 12; la Fase 0 pidió "desde
//                  septiembre del año pasado" y 12 meses la cubre SIN tatuar
//                  la fecha en el código — lint tests/no-hardcoded-dates)
//   ?desde=...     fecha exacta de corte, gana sobre ?meses
//   ?ejemplos=3    cuántos mercados traen precio del Yes a T-24h
//   ?indice=0      arranca en el N-ésimo cruzado: para partir en dos corridas
//                  y sumar (el censo publica índice inicial, final y restantes)
//   ?max_precios=400  tope de mercados a los que se les pide el precio T-24h
//                  (el conteo del candado). Si no entran, trunca y lo declara
//   ?detalle=1     incluye el detalle mercado por mercado del T-24h
//   ?simbolos=99   cuántos símbolos del universo v0 se buscan uno por uno
//                  (camino D, el que decide el candado). &simbolos=0 lo apaga
//   ?barrido=1     además, corre el barrido por offset como CONTROL (apagado
//                  por defecto: Gamma topa el offset con 422 y el barrido ve
//                  ~500 de decenas de miles — ciego, no concluyente)
//   ?paginas=20 · ?limite=500   solo aplican al barrido de control
//
// ── POR QUÉ ESTO CORRE EN VERCEL Y NO EN UNA LAPTOP ────────────────
// La Fase 0 no pregunta "¿existe la API?" sino "¿la vemos DESDE DONDE VA A
// VIVIR EL CRON?". Una IP de datacenter puede recibir otro trato que una
// residencial (misma lección que el G3 del Congreso). Este endpoint es el
// censo ejecutable desde el sitio exacto donde viviría la cosecha.
//
// ── SOLO LECTURA ───────────────────────────────────────────────────
// Cero writes a Neon: un solo SELECT sobre pead_earnings para el cruce. NO
// llama a ensurePeadSchema() (haría CREATE TABLE) ni a beat() — latir acá
// enmascararía un cron muerto, y además todavía no hay cron que lata.
//
// ── Gate ───────────────────────────────────────────────────────────
// CRON_SECRET por header (Authorization: Bearer ...) o por query (?secret=...,
// para abrir el markdown en el navegador). Mismo patrón que pead-analyze.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opc) · FINNHUB_API_KEY (opc, nombres
//           de empresa + sonda de revisiones) · ALPHAVANTAGE_API_KEY (opc,
//           sonda de revisiones)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { gamma, clob } from './_lib/polymarket.js';
import {
  descubrePorBusqueda, descubrePorSimbolo, descubrePorTags, descubrePorCluster,
  cosechaDeBusqueda, filasDe, aplanaMercados, formaDe, precioDeUnMercado,
  LIMITE_BUSQUEDA, CONCURRENCIA_CLOB,
} from './_lib/earnings-beat-descubrir.js';
import {
  CRITERIOS, normalizaMercado, pareceEarnings, resuelveSimbolo, construyeIndiceNombres,
  extraeConsensoEps, outcomeResuelto, tokenYes, precioEnT24h, cruzaConPead, evaluaFuentePIT,
  isoDia, ts, resumenMarkdown, extraeTags, extraeCluster, FRASES_BUSQUEDA, detectaTopeUniforme,
  analizaDesfases, clasificaT24h, clasificaParaV1, comparaEmparejamiento,
  estadisticasHistoricas, evaluaDesacuerdo, CRITERIOS_DESACUERDO, indiceYes, num, escalaDelEstimado, PISO_ESCALA,
} from './_lib/earnings-beat.js';
import { V0_UNIVERSE } from './_lib/pead-universe.js';
import { getSymbolMap } from './earnings.js';

// Paginar Gamma + bajar historiales del CLOB + sondas de revisiones no entra
// en los 60s de default. Misma medicina que pead-analyze/pead-harvest.
export const maxDuration = 300;

const PRESUPUESTO_MS = 240000;   // corte duro del censo: reporta truncado, no 504
const LIMITE_SONDA = 100;        // explícito: las sondas miran esquema, no catálogo
const UMBRAL_RUIDO = 100;        // filas traídas por un símbolo para llamarlo ruidoso

// ─────────────────── sondas de esquema ───────────────────
// NO se asume qué contesta cada endpoint: se sondea con `limit` chico y se
// reporta status, HTTP y LAS CLAVES REALES de la primera fila. Son el censo
// del ESQUEMA, no el método para juntar mercados — eso lo hace el
// descubrimiento dirigido de más abajo. Un 404 es un hecho del censo, no un
// crash; y un 422 queda anotado en `topes_de_offset`.
const ESTRATEGIAS = [
  {
    nombre: 'markets_cerrados_por_fecha', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false', end_date_min: c.desde + 'T00:00:00Z' }),
  },
  {
    nombre: 'markets_cerrados', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false' }),
  },
  {
    nombre: 'events_cerrados', api: 'gamma', path: '/events',
    params: (c, offset) => ({ closed: 'true', limit: c.limite, offset, order: 'endDate', ascending: 'false' }),
  },
  {
    nombre: 'markets_sin_filtros', api: 'gamma', path: '/markets',
    params: (c, offset) => ({ limit: c.limite, offset }),
  },
];

// ─────────────────── descubrimiento dirigido ───────────────────
//
// POR QUÉ NO SE BARRE EL CATÁLOGO (cicatriz de la primera corrida):
// paginar `/markets` con offset creciente muere con **HTTP 422 en la página 6**
// — Gamma tiene un TOPE DE OFFSET, no es rate limit. El barrido llegó a ver
// ~500 mercados de decenas de miles, así que su "0 mercados de earnings" no
// era un hallazgo sobre Polymarket: era ceguera del método. Un censo que
// confunde "no vi" con "no hay" miente con números.
//
// Ahora el descubrimiento es DIRIGIDO, por tres caminos que se miden por
// separado para saber cuál vale la pena en la Fase 1:
//   A. búsqueda por las frases reales con que se redactan estos mercados;
//   B. tags/categorías sacados de los mercados que A encontró, paginando
//      DENTRO del filtro (ahí el offset sí alcanza);
//   C. el racimo (evento/serie) al que pertenece un mercado de earnings.
// El barrido queda como control opcional (&barrido=1), nunca como el método.

// ── Censo de ESCALA del universo (?vista=live&diag=escala) ────────────────
// Antes de decidir si la fragilidad por escala se MUESTRA, hay que saber a
// cuántos de los 99 les aplica: si son tres, es una nota al pie; si son
// treinta, es una columna. `frontera` (beats ≤ $0.01 en dólares absolutos) se
// le escapa a INTC, cuyos estimados rondan el centavo: un beat de $0.28 es
// +2800% y no cae en "frontera", pero esa racha es frágil de otra manera.
// Esto MIDE. No cambia la tarjeta.
async function censoDeEscala() {
  const universo = [...new Set(V0_UNIVERSE)];
  const ph = universo.map((_, i) => `$${i + 1}`).join(', ');
  const filas = await sql(
    `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, estimated_eps
       from pead_earnings
      where symbol in (${ph}) and estimated_eps is not null
      order by reported_date desc`,
    universo
  );
  const porSimbolo = new Map();
  for (const f of filas) {
    if (!porSimbolo.has(f.symbol)) porSimbolo.set(f.symbol, []);
    porSimbolo.get(f.symbol).push(f);
  }
  const medidos = universo.map((s) => ({ symbol: s, ...escalaDelEstimado(porSimbolo.get(s) || []) }));
  const conDatos = medidos.filter((m) => m.estimado_mediano !== null);
  const chicos = conDatos.filter((m) => m.escala_chica).sort((a, b) => a.estimado_mediano - b.estimado_mediano);
  return {
    diag: 'escala',
    pregunta: '¿A cuántos de los 99 símbolos les aplicaría una señal de fragilidad por escala del estimado?',
    piso: PISO_ESCALA,
    universo: universo.length,
    con_datos: conDatos.length,
    sin_datos: universo.length - conDatos.length,
    escala_chica: chicos.length,
    simbolos: chicos.map((m) => ({ symbol: m.symbol, estimado_mediano: m.estimado_mediano, trimestres: m.trimestres_usados })),
    // Para calibrar el piso con datos en vez de con una corazonada.
    percentiles: (() => {
      const v = conDatos.map((m) => m.estimado_mediano).sort((a, b) => a - b);
      const p = (q) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null);
      return { p10: p(0.10), p25: p(0.25), mediana: p(0.50), p75: p(0.75) };
    })(),
    nota: 'MEDICIÓN, no decisión: la señal NO se muestra en la tarjeta. Con este conteo se decide si vale una nota al pie, una columna, o nada.',
  };
}

// ── Diag de DESACUERDOS (?vista=live&diag=desacuerdos) ────────────────────
// "Quiero el diagnóstico con la fila en la mano, no con el código."
//
// Un hueco de 70 puntos entre el precio y la tasa histórica tiene dos causas
// posibles, y desde la tarjeta no se distinguen. Este diag imprime, por cada
// mercado abierto, LA PREGUNTA LITERAL del mercado, el umbral que declara, el
// nivel reciente de EPS y el dictamen — que es lo único con lo que se puede
// decidir si el hueco es información o es que el mercado pregunta otra cosa.
//
// Corre la vista completa y la aplana: mismo descubrimiento, mismos números
// que la pantalla. Si dijera otra cosa que la tarjeta, no serviría de nada.
async function diagDesacuerdos() {
  const live = await vistaLive({});
  const filas = [];
  for (const e of live.empresas || []) {
    for (const m of e.mercados || []) {
      const d = m.desacuerdo || {};
      filas.push({
        symbol: e.symbol,
        // La pregunta LITERAL, sin recortar a 90 como en la tarjeta: acá es la
        // evidencia, y recortada no se puede leer si pide un umbral distinto.
        pregunta: m.titulo,
        slug: m.slug,
        url: m.url,
        fecha_resolucion: m.fecha_resolucion,
        precio_yes_pct: m.polymarket_yes_pct,
        umbral_declarado: m.consenso_eps,
        nivel_eps_reciente: d.instrumento ? d.instrumento.nivel_eps_reciente : null,
        desvio_umbral_pct: d.instrumento ? d.instrumento.desvio_umbral_pct : null,
        umbral_lejos_del_nivel: d.instrumento ? d.instrumento.umbral_lejos_del_nivel : null,
        tasa_historica_pct: d.tasa_historica_pct,
        trimestres: d.trimestres ?? null,
        gap_puntos: d.gap_puntos,
        clasificacion: d.clasificacion,
        motivo: d.motivo,
        instrumento_primero: d.instrumento_primero ?? null,
        mercados_de_la_empresa: (e.desacuerdos || {}).cuantos_mercados ?? null,
        varios_umbrales: (e.desacuerdos || {}).varios_umbrales ?? null,
      });
    }
  }
  // Mayor hueco arriba: es lo que se viene a mirar. Los no comparables al final.
  filas.sort((a, b) => Math.abs(b.gap_puntos || 0) - Math.abs(a.gap_puntos || 0));
  const porMotivo = {};
  for (const f of filas) {
    const k = f.clasificacion === 'desacuerdo' || f.clasificacion === 'coincide' ? f.clasificacion : (f.motivo || 'no_comparable');
    porMotivo[k] = (porMotivo[k] || 0) + 1;
  }
  return {
    diag: 'desacuerdos',
    pregunta: '¿Qué mercados abiertos están lejos de la tasa histórica, y el hueco es información o es que el mercado pregunta otra cosa?',
    generado_en: live.generado_en,
    mercados: filas.length,
    por_clasificacion: porMotivo,
    criterios: CRITERIOS_DESACUERDO,
    filas,
    como_leerlo: [
      'Un `umbral_declarado` lejos de `nivel_eps_reciente` (mirá `desvio_umbral_pct`) quiere decir que el mercado NO pregunta "¿superó el consenso?" — ahí el hueco no significa nada.',
      '`varios_umbrales: true` quiere decir que la empresa tiene varios mercados abiertos sobre el mismo reporte: solo uno es comparable con la tasa histórica.',
      'La tasa histórica es un CONTEO de trimestres pasados. No es predicción, y la Fase 2 dio NO-GO: QuantDesk todavía no emite probabilidad propia.',
      'Nada de esto es señal de compra ni de venta. Es dónde mirar.',
    ],
  };
}

// ── Diagnóstico por símbolo (?vista=live&diag=MU,COST) ────────────────────
// Solo DB, sin tocar Gamma: sirve para mirar la base histórica de una empresa
// AUNQUE no tenga mercados abiertos. Nació de un número que se veía imposible
// en la tarjeta (MU: promedio −26% con 13 beats al hilo) y la evidencia estaba
// en la tabla, no en la pantalla. Ahora la evidencia se pide sin re-desplegar.
async function diagnosticoSimbolos(simbolos) {
  const limpios = [...new Set(simbolos.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  if (!limpios.length) return { diag: [], error: 'sin símbolos' };
  const ph = limpios.map((_, i) => `$${i + 1}`).join(', ');
  const filas = await sql(
    `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date,
            reported_eps, estimated_eps, surprise_pct
       from pead_earnings
      where symbol in (${ph})
      order by reported_date desc`,
    limpios
  );
  const porSimbolo = new Map();
  for (const f of filas) {
    if (!porSimbolo.has(f.symbol)) porSimbolo.set(f.symbol, []);
    porSimbolo.get(f.symbol).push(f);
  }
  return {
    diag: limpios.map((s) => ({
      symbol: s,
      trimestres_en_tabla: (porSimbolo.get(s) || []).length,
      // `trimestres_en_tabla` cuenta filas; `completo.total` cuenta las que
      // tienen reportado Y estimado. La diferencia está en
      // `historico.descartados_sin_cifras` y NO es un error de conteo.
      historico: estadisticasHistoricas(porSimbolo.get(s) || []),
    })),
    como_leerlo: [
      'historico.sorpresa.distorsionado = el promedio y la mediana cuentan historias distintas. `causa_probable` dice cuál de las dos: artefacto de denominador (estimado cero/negativo/de centavos) o COLAS REALES (una cíclica con trimestres de pérdida de verdad).',
      'historico.sorpresa.signo_discrepante = filas donde el % de Alpha Vantage y el nuestro no coinciden en el SIGNO. Lo que se muestra es siempre el nuestro, calculado con |estimado|. Si este contador deja de ser cero, hay algo que mirar en la fuente.',
      'filas_en_tabla vs completo.total: la diferencia son los trimestres a los que AV no les dio estimado (o reportado). Sin las dos cifras no se puede decir si superó, así que no se cuentan — `descartados_sin_cifras` los cuenta.',
      'ventana vs completo: el titular mira 5 años. En una empresa CÍCLICA los dos números difieren de verdad, y esa diferencia es información, no un error.',
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════
// VISTA EN VIVO (?vista=live) — lo que ve la tab EARNINGS.
//
// Mercados ABIERTOS de Polymarket + la base histórica de beats de
// pead_earnings, por empresa. Mismo descubrimiento que el censo
// (_lib/earnings-beat-descubrir.js) y MISMO filtro v1: si la vista usara otro
// criterio que la cosecha, la pantalla y la tabla contarían cosas distintas.
//
// ── LO QUE ESTA VISTA NO HACE, Y NO VA A HACER HASTA LA FASE 2 ─────
// NO emite una probabilidad de QuantDesk. El histórico es un CONTEO —
// "superó 26 de 32" — y presentarlo como "81% de probabilidad" sería inventar
// un pronóstico que nada validó todavía. El campo `probabilidad_quantdesk`
// existe en la respuesta y vale `null` a propósito: así la ausencia es una
// decisión visible y no un olvido que alguien "complete" más adelante.
//
// PRESUPUESTO: la vista se sirve cacheada, pero la primera petición la paga
// un usuario. Por eso el camino de frases (rápido, ~8 requests) corre entero
// y el de símbolos corre mientras quede presupuesto, declarando cuántos
// alcanzó a probar. Mejor una vista parcial que dice que es parcial, que una
// vista completa que llega tarde.
const PRESUPUESTO_LIVE_MS = 90000;

async function vistaLive(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_LIVE_MS - (Date.now() - t0);
  const gamma1 = (path, params, opts) => gamma(path, params, opts);
  const universo = new Set(V0_UNIVERSE);

  const crudos = new Map();
  const suma = (camino, filas) => {
    for (const raw of filas || []) {
      const id = raw && raw.id !== undefined && raw.id !== null ? String(raw.id)
        : raw && raw.slug ? 'slug:' + raw.slug : null;
      if (!id || crudos.has(id)) continue;
      crudos.set(id, { ...raw, _via: camino, _etiqueta: raw._etiqueta || null });
    }
  };

  const ctxDesc = { simbolos: 99, limite: 100 };
  const busqueda = await descubrePorBusqueda(ctxDesc, gamma1, restante);
  suma('busqueda', busqueda.filas);
  let simbolosProbados = 0;
  if (restante() > 25000) {
    const porSimbolo = await descubrePorSimbolo(ctxDesc, gamma1, restante, universo);
    suma('simbolo', porSimbolo.filas);
    simbolosProbados = porSimbolo.probados;
  }

  // ── Filtro v1 + solo ABIERTOS del universo ──
  const indice = construyeIndiceNombres({ nombres: null, universo });
  const abiertos = [];
  const descartes = { no_abierto: 0, fuera_del_universo: 0, filtro_v1: 0 };
  for (const raw of crudos.values()) {
    const m = normalizaMercado(raw);
    if (!m) continue;
    const simbolo = resuelveSimbolo(m, indice, universo);
    const v1 = clasificaParaV1({ ...m, symbol: simbolo.symbol }, { etiqueta: raw._etiqueta || null, universo });
    if (!v1.acepta) { descartes.filtro_v1++; continue; }
    if (!simbolo.symbol || !universo.has(simbolo.symbol)) { descartes.fuera_del_universo++; continue; }
    // ABIERTO = todavía sin outcome resuelto. Un mercado ya resuelto no tiene
    // nada que aportar a una vista "en vivo".
    if (outcomeResuelto(m)) { descartes.no_abierto++; continue; }

    const consenso = extraeConsensoEps(m.descripcion || '') || extraeConsensoEps(m.pregunta || '');
    const iYes = indiceYes(m.outcomes);
    const precioYes = iYes !== null ? num(m.precios_outcome[iYes]) : null;
    abiertos.push({
      market_id: m.id,
      slug: m.slug,
      titulo: m.pregunta,
      url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
      symbol: simbolo.symbol,
      fecha_resolucion: isoDia(m.fin),
      consenso_eps: consenso ? consenso.valor : null,
      // Precio ACTUAL del Yes, tal como lo publica Gamma en `outcomePrices`.
      // La fuente se cita en la respuesta y en la tarjeta: es el precio de
      // Polymarket, no una opinión nuestra.
      polymarket_yes: precioYes,
      polymarket_yes_pct: precioYes === null ? null : Math.round(precioYes * 100),
      fuente_precio: 'Polymarket · Gamma outcomePrices',
      volumen: m.volumen,
    });
  }

  // Más próximo a reportar primero: es el orden en que la información caduca.
  abiertos.sort((a, b) => String(a.fecha_resolucion || '9999').localeCompare(String(b.fecha_resolucion || '9999')));

  // ── Base histórica desde pead_earnings (SELECT, nada más) ──
  const simbolos = [...new Set(abiertos.map((m) => m.symbol))];
  const historico = {};
  let errorHistorico = null;
  if (simbolos.length) {
    try {
      const ph = simbolos.map((_, i) => `$${i + 1}`).join(', ');
      const filas = await sql(
        `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date,
                reported_eps, estimated_eps, surprise_pct
           from pead_earnings
          where symbol in (${ph})
          order by reported_date desc`,
        simbolos
      );
      const porSimbolo = new Map();
      for (const f of filas) {
        if (!porSimbolo.has(f.symbol)) porSimbolo.set(f.symbol, []);
        porSimbolo.get(f.symbol).push(f);
      }
      for (const s of simbolos) historico[s] = estadisticasHistoricas(porSimbolo.get(s) || []);
    } catch (e) {
      errorHistorico = String((e && e.message) || e).slice(0, 200);
    }
  }

  // ── Una tarjeta por EMPRESA, no por mercado ──
  // Una misma empresa puede tener varios mercados abiertos a la vez (distintos
  // umbrales de EPS sobre el mismo reporte). Como la tarjeta es por empresa y
  // el histórico también, agrupar acá evita que la pantalla repita cuatro veces
  // el mismo "superó 26 de 32" con precios distintos al lado.
  const porEmpresa = new Map();
  for (const m of abiertos) {
    if (!porEmpresa.has(m.symbol)) porEmpresa.set(m.symbol, []);
    porEmpresa.get(m.symbol).push(m);
  }
  // El día de hoy se calcula UNA vez y viaja por parámetro: `evaluaDesacuerdo`
  // no lee el reloj, así el test puede fijar el día.
  const hoy = new Date().toISOString().slice(0, 10);

  const empresas = [...porEmpresa.entries()].map(([symbol, lista]) => {
    const hist = historico[symbol] || null;
    // El desacuerdo se mide POR MERCADO, no por empresa: cada mercado tiene su
    // propio umbral de EPS, y la tasa de beats solo es comparable con el que
    // pregunta por el consenso. Restarle la tasa al precio del mercado
    // equivocado es el error que esta estructura hace imposible.
    const mercados = lista.map((m) => ({
      ...m,
      desacuerdo: evaluaDesacuerdo({
        historico: hist,
        precio_mercado: m.polymarket_yes,
        consenso_declarado: m.consenso_eps,
        fecha_reporte: m.fecha_resolucion,
        hoy,
      }),
    }));
    // Varios mercados abiertos de la misma empresa = varios umbrales sobre el
    // mismo reporte. Ahí el instrumento NO es opcional: antes de leer un hueco
    // hay que saber cuál de los umbrales se está mirando.
    const variosUmbrales = mercados.length > 1;
    const comparables = mercados.filter((m) => m.desacuerdo && m.desacuerdo.clasificacion === 'desacuerdo');
    const destacado = comparables.length
      ? comparables.slice().sort((a, b) => Math.abs(b.desacuerdo.gap_puntos) - Math.abs(a.desacuerdo.gap_puntos))[0]
      : null;
    return {
      symbol,
      // La fecha que manda es la del mercado que resuelve primero.
      fecha_resolucion: lista[0].fecha_resolucion,
      mercados,
      historico: hist,
      desacuerdos: {
        cuantos_mercados: mercados.length,
        varios_umbrales: variosUmbrales,
        instrumento_obligatorio: variosUmbrales,
        aviso_varios_umbrales: variosUmbrales
          ? `${mercados.length} mercados abiertos de ${symbol} sobre el mismo reporte, con umbrales distintos. La tasa histórica solo es comparable con el que pregunta por el consenso — el hueco de los otros no significa nada.`
          : null,
        destacado: destacado
          ? { market_id: destacado.market_id, titulo: destacado.titulo, url: destacado.url,
              gap_puntos: destacado.desacuerdo.gap_puntos,
              instrumento_primero: destacado.desacuerdo.instrumento_primero || variosUmbrales }
          : null,
      },
      // EXPLÍCITO Y NULO. Ver el comentario de arriba: la ausencia es la
      // decisión, no un campo que falta.
      probabilidad_quantdesk: null,
      probabilidad_quantdesk_estado: 'en validación (Fase 2) — QuantDesk todavía no emite probabilidad propia',
    };
  }).sort((a, b) => String(a.fecha_resolucion || '9999').localeCompare(String(b.fecha_resolucion || '9999')));

  // Estado vacío HONESTO: por qué no hay nada, no un error genérico.
  let vacio = null;
  if (!empresas.length) {
    vacio = {
      motivo: crudos.size === 0
        ? 'Polymarket no devolvió mercados en esta consulta'
        : descartes.no_abierto > 0
          ? 'hay mercados de earnings, pero todos ya resolvieron: no hay ninguno abierto ahora mismo'
          : descartes.fuera_del_universo > 0
            ? 'hay mercados de earnings abiertos, pero ninguno de las 99 empresas que seguimos'
            : 'ningún mercado pasó el filtro de beat/miss de EPS',
      revisados: crudos.size,
      descartes,
    };
  }

  return {
    vista: 'live',
    generado_en: new Date().toISOString(),
    empresas,
    mercados_abiertos: abiertos.length,
    vacio,
    cobertura: {
      mercados_revisados: crudos.size,
      simbolos_probados: simbolosProbados,
      de: universo.size,
      parcial: simbolosProbados < universo.size,
      nota: simbolosProbados < universo.size
        ? 'búsqueda por símbolo incompleta por presupuesto de tiempo: puede faltar algún mercado abierto'
        : null,
      descartes,
    },
    historico_error: errorHistorico,
    fuentes: {
      mercados_y_precio: 'Polymarket (Gamma API, pública)',
      historico_eps: 'Alpha Vantage EARNINGS vía pead_earnings',
    },
    aviso: {
      es: 'El histórico es un conteo de trimestres pasados, NO una predicción. QuantDesk todavía no emite probabilidad propia: está en validación.',
      en: 'The track record counts past quarters — it is NOT a forecast. QuantDesk does not publish its own probability yet: it is still being validated.',
    },
    ms: Date.now() - t0,
  };
}

// ─────────────────── el censo ───────────────────

async function corre(ctx) {
  const t0 = Date.now();
  const restante = () => PRESUPUESTO_MS - (Date.now() - t0);
  const headersVistos = {};
  const topes_de_offset = [];
  let http_429 = 0;
  // Envoltorio de gamma(): anota headers de rate limit y — sobre todo — deja
  // registrado cada 422 con su offset. El tope de offset es un HECHO del censo
  // y tiene que quedar escrito para que no vuelva a morder.
  const gamma1 = async (path, params, opts) => {
    const r = await gamma(path, params, opts);
    for (const [k, v] of Object.entries((r && r.headers) || {})) headersVistos[k] = v;
    if (r && r.status === 'ratelimit') http_429++;
    if (r && r.http === 422) {
      topes_de_offset.push({ endpoint: 'gamma' + path, offset: (params && params.offset) ?? null,
        limit: (params && params.limit) ?? null, mensaje: String(r.message || '').slice(0, 160) });
    }
    return r;
  };
  const clob1 = async (path, params, opts) => {
    const r = await clob(path, params, opts);
    for (const [k, v] of Object.entries((r && r.headers) || {})) headersVistos[k] = v;
    if (r && r.status === 'ratelimit') http_429++;
    return r;
  };

  // ── 1. Sondas: ¿qué contesta cada endpoint, y con qué esquema? ──
  // Con `limit` chico: son para el CENSO del esquema, no para juntar datos.
  const sondas = [];
  for (const e of ESTRATEGIAS) {
    if (restante() < 60000) break;
    const r = await gamma1(e.path, { ...e.params(ctx, 0), limit: LIMITE_SONDA });
    const filas = r.status === 'ok' ? filasDe(r.body) : [];
    sondas.push({
      estrategia: e.nombre, endpoint: 'gamma' + e.path, status: r.status, http: r.http ?? null,
      // `filas` de una sonda está TOPADA por su propio límite: es el censo del
      // ESQUEMA, no un conteo del catálogo. Se publica el tope al lado para que
      // nadie vuelva a leer "5" como si fuera el tamaño del universo.
      ms: r.ms, filas: filas.length, limite_de_la_sonda: LIMITE_SONDA,
      forma: r.status === 'ok' ? formaDe(r.body) : null,
      claves_primera_fila: filas.length ? Object.keys(filas[0]).slice(0, 40) : null,
      mensaje: r.message ? String(r.message).slice(0, 200) : null,
    });
  }

  // ── 2. Descubrimiento dirigido (A → B/C, que se apoyan en lo que A halló) ──
  const universo = new Set(V0_UNIVERSE);
  const crudosPorId = new Map();
  const aportes = {};
  let sinId = 0;
  const suma = (camino, filas) => {
    let nuevos = 0;
    for (const raw of filas || []) {
      const id = raw && raw.id !== undefined && raw.id !== null ? String(raw.id)
        : raw && raw.slug ? 'slug:' + raw.slug : null;
      if (!id) { sinId++; continue; }
      if (crudosPorId.has(id)) continue;
      crudosPorId.set(id, { ...raw, _via: camino, _etiqueta: raw._etiqueta || null });
      nuevos++;
    }
    aportes[camino] = (aportes[camino] || 0) + nuevos;
    return nuevos;
  };

  const busqueda = await descubrePorBusqueda(ctx, gamma1, restante);
  suma('busqueda', busqueda.filas);

  // Camino D ANTES de tags/racimo: es el que más semillas produce, y tags y
  // racimo fallaron la vuelta pasada por falta de semillas, no por no existir.
  const porSimbolo = ctx.simbolos > 0
    ? await descubrePorSimbolo(ctx, gamma1, restante, universo)
    : { camino: 'simbolo', intentos: [{ nota: 'apagado con &simbolos=0' }], filas: [], traidas: {}, probados: 0, de: 0 };
  suma('simbolo', porSimbolo.filas);

  // Semillas para B y C: los mercados de earnings que A sí encontró. Si A no
  // encontró ninguno, B y C se declaran no disponibles en vez de inventarse
  // un tag plausible.
  const todasLasSemillas = [...crudosPorId.values()]
    .filter((raw) => pareceEarnings(normalizaMercado(raw)).si);
  const semillas = todasLasSemillas.slice(0, 8);
  // ¿Los mercados traen tags/evento cuando hay más de dos? La vuelta pasada
  // tags y racimo quedaron "no disponibles" por falta de semillas; con este
  // conteo se distingue "no había semillas" de "las semillas no traen tags".
  const semillas_info = {
    total: todasLasSemillas.length,
    usadas: semillas.length,
    con_tags: todasLasSemillas.filter((raw) => extraeTags(raw).length > 0).length,
    con_racimo: todasLasSemillas.filter((raw) => {
      const c = extraeCluster(raw);
      return !!(c.evento_id || c.evento_slug || c.serie_id || c.serie_slug);
    }).length,
  };

  const porTags = await descubrePorTags(ctx, gamma1, restante, semillas);
  suma('tags', porTags.filas);
  const porCluster = await descubrePorCluster(ctx, gamma1, restante, semillas);
  suma('cluster', porCluster.filas);

  // ── 2b. Barrido: CONTROL opcional, nunca el método ──
  const barrido = { corrido: false, nota: 'apagado por defecto: el tope de offset lo vuelve ciego (&barrido=1 para correrlo igual)' };
  if (ctx.barrido) {
    delete barrido.nota;   // corrió: la nota de "apagado" dejaría de ser cierta
    Object.assign(barrido, { corrido: true, paginas: 0, filas: 0, truncado: false, motivo_corte: null });
    for (let pagina = 0; pagina < ctx.paginas; pagina++) {
      if (restante() < 70000) { barrido.truncado = true; barrido.motivo_corte = 'presupuesto_de_tiempo'; break; }
      const r = await gamma1('/markets', { closed: 'true', limit: ctx.limite, offset: pagina * ctx.limite, order: 'endDate', ascending: 'false' });
      if (r.status !== 'ok') {
        barrido.truncado = true;
        barrido.motivo_corte = (r.http === 422 ? 'tope_de_offset_422' : r.status) + ' en offset ' + (pagina * ctx.limite);
        break;
      }
      const filas = filasDe(r.body);
      barrido.paginas++;
      barrido.filas += filas.length;
      if (!filas.length) { barrido.motivo_corte = 'fin_del_catalogo'; break; }
      suma('barrido', filas.flatMap(aplanaMercados));
      if (pagina === ctx.paginas - 1) { barrido.truncado = true; barrido.motivo_corte = 'tope_de_paginas'; }
    }
  }

  // ── 3. Clasificación ──
  let nombres = null;
  if (ctx.finnhubKey) {
    try { nombres = await getSymbolMap(ctx.finnhubKey); } catch (e) { nombres = null; }
  }
  const indice = construyeIndiceNombres({ nombres, universo });

  const claves = new Map();
  const mercados = [];
  const descartados = [];
  // Cada descarte con su motivo Y su muestra: un filtro que no se puede
  // auditar es el que dejó pasar 26 mercados del símbolo equivocado.
  const motivos_filtro = {};
  const muestras_filtro = {};
  for (const raw of crudosPorId.values()) {
    for (const k of Object.keys(raw || {})) claves.set(k, (claves.get(k) || 0) + 1);
    const m = normalizaMercado(raw);
    if (!m) continue;
    const fecha = isoDia(m.fin);
    const simbolo = resuelveSimbolo(m, indice, universo);
    // El filtro v1 necesita el símbolo YA resuelto para poder aplicar la regla
    // dura de "resuelto != buscado".
    const v1 = clasificaParaV1({ ...m, symbol: simbolo.symbol }, { etiqueta: raw._etiqueta || null, universo });
    motivos_filtro[v1.motivo] = (motivos_filtro[v1.motivo] || 0) + 1;
    if (!v1.acepta) {
      const muestra = (muestras_filtro[v1.motivo] = muestras_filtro[v1.motivo] || []);
      if (muestra.length < 4 && (m.pregunta || m.slug)) {
        muestra.push({
          texto: String(m.pregunta || m.slug).slice(0, 100),
          buscado: raw._etiqueta || null, resuelto: simbolo.symbol || null,
        });
      }
      if (descartados.length < 8 && m.pregunta) descartados.push(m.pregunta.slice(0, 110));
      continue;
    }
    if (fecha && fecha < ctx.desde) continue;   // fuera de ventana: no se cuenta
    const esEarnings = { senales: v1.senales };
    const consenso = extraeConsensoEps(m.descripcion || '') || extraeConsensoEps(m.pregunta || '');
    const outcome = outcomeResuelto(m);
    mercados.push({
      id: m.id, slug: m.slug, pregunta: m.pregunta, via: raw._via || null, etiqueta: raw._etiqueta || null,
      fecha_resolucion: fecha, fin_declarado: m.fin_declarado, fin_real: m.fin_real,
      // La fecha de creación viaja hasta el cruce: es la que decide CONTRA QUÉ
      // REPORTE apunta el mercado. Sin ella la regla nueva no actúa (y el
      // censo lo grita en `sin_fecha_de_creacion`).
      creado: m.creado,
      cerrado: m.cerrado, uma: m.uma, volumen: m.volumen,
      senales: esEarnings.senales, senales_eps: v1.senales_eps || [],
      symbol: simbolo.symbol, symbol_via: simbolo.via, symbol_ambiguo: !!simbolo.ambiguo,
      en_universo_v0: simbolo.symbol ? universo.has(simbolo.symbol) : false,
      consenso_pm: consenso ? consenso.valor : null,
      consenso_patron: consenso ? consenso.patron : null,
      consenso_fragmento: consenso ? consenso.fragmento : null,
      outcome: outcome ? outcome.outcome : null,
      outcome_es_yes: outcome ? outcome.es_yes : null,
      token_yes: tokenYes(m),
    });
  }

  // ── Auditoría del ruido de la búsqueda por subcadena ──
  // "NOW" trae las películas "Now You See Me"; "ON", "ALL" y "KEY" son peores.
  // El filtro de earnings los descarta, pero "el filtro descartó bien" es una
  // afirmación que hay que PODER COMPROBAR: por eso se publica, por cada
  // símbolo ruidoso, cuántas filas trajo, cuántas sobrevivieron, y una muestra
  // de las ACEPTADAS para leerlas a ojo.
  const traidasPorEtiqueta = new Map(Object.entries(porSimbolo.traidas || {}));
  const aceptadasPorEtiqueta = new Map();
  for (const m of mercados) {
    if (!m.etiqueta) continue;
    if (!aceptadasPorEtiqueta.has(m.etiqueta)) aceptadasPorEtiqueta.set(m.etiqueta, []);
    aceptadasPorEtiqueta.get(m.etiqueta).push(m);
  }
  const ruidosos = [...traidasPorEtiqueta.entries()]
    .filter(([, n]) => n >= UMBRAL_RUIDO)
    .sort((a, b) => b[1] - a[1])
    .map(([sym, traidas]) => {
      const aceptados = aceptadasPorEtiqueta.get(sym) || [];
      return {
        symbol: sym, filas_traidas: traidas, aceptados: aceptados.length,
        descartadas: traidas - aceptados.length,
        // La prueba de que no se coló basura no es un porcentaje: son las
        // preguntas aceptadas, leídas.
        muestra_aceptados: aceptados.slice(0, 3).map((m) => ({
          pregunta: (m.pregunta || m.slug || '').slice(0, 90),
          symbol_resuelto: m.symbol, coincide_con_la_busqueda: m.symbol === sym,
        })),
        // Un aceptado cuyo símbolo resuelto NO es el que se buscó es
        // exactamente el modo de falla que esta auditoría persigue.
        aceptados_con_otro_simbolo: aceptados.filter((m) => m.symbol && m.symbol !== sym).length,
      };
    });

  // Qué camino encontró MÁS mercados de earnings (no crudos: earnings).
  const porCamino = {};
  for (const m of mercados) porCamino[m.via || 'desconocido'] = (porCamino[m.via || 'desconocido'] || 0) + 1;
  const ganadora = Object.entries(porCamino).sort((a, b) => b[1] - a[1])[0] || null;

  const resueltos = mercados.filter((m) => m.outcome !== null);
  const conSimbolo = mercados.filter((m) => m.symbol);

  // ── 4. Cruce con pead_earnings (SELECT, nada más) ──
  // VA PRIMERO, antes del CLOB: el conteo del candado se mide sobre los
  // mercados CRUZADOS, así que hay que saber cuáles son antes de gastar el
  // presupuesto pidiendo precios.
  const cruce = { consultado: false, filas_pead: 0, error: null, cruzados: 0, en_universo_v0: 0, sin_cruce: {} };
  let cruzados = [];
  let desfases = null;
  try {
    const filas = await sql(
      `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date
         from pead_earnings
        where reported_date >= ($1)::date - 7
          and reported_date <= current_date + 7
        order by reported_date asc`,
      [ctx.desde]
    );
    cruce.consultado = true;
    cruce.filas_pead = filas.length;
    // Emparejamiento corregido (solo reportes POSTERIORES a la creación del
    // mercado) + la comparación contra el viejo, para poder decir qué pasó con
    // los casos que antes caían en "fecha fuera de tolerancia".
    const comparacion = comparaEmparejamiento(mercados, filas);
    const todos = comparacion.ahora;
    cruce.emparejamiento = {
      regla: 'el reporte tiene que ser POSTERIOR a la creación del mercado; tolerancia sigue en ±' + CRITERIOS.tolerancia_dias_cruce + ' día',
      cruzados_con_regla_vieja: comparacion.cruzados_antes,
      cruzados_ahora: comparacion.cruzados_ahora,
      casos_que_antes_caian_fuera_de_tolerancia: comparacion.fuera_de_tolerancia_antes,
      destino_de_esos_casos: comparacion.destino_de_esos_casos,
      dejaron_de_casar_con_la_regla_nueva: comparacion.dejaron_de_casar_con_la_regla_nueva,
      sin_fecha_de_creacion: comparacion.sin_fecha_de_creacion,
      nota_sin_creacion: comparacion.nota_sin_creacion,
    };
    cruzados = todos.filter((m) => m.cruce);
    cruce.cruzados = cruzados.length;
    cruce.en_universo_v0 = cruzados.filter((m) => m.en_universo_v0).length;
    for (const m of todos) {
      if (m.cruce) continue;
      const k = m.motivo_sin_cruce || 'desconocido';
      cruce.sin_cruce[k] = (cruce.sin_cruce[k] || 0) + 1;
    }
    // ¿Los que no cruzan por fecha son un desfase sistemático o ruido?
    desfases = analizaDesfases(todos);
  } catch (e) {
    cruce.error = String((e && e.message) || e).slice(0, 200);
  }

  // ── 5. EL CONTEO DEL CANDADO: precio del Yes a T-24h en TODOS los cruzados ──
  // Tres ejemplos no miden nada: el candado exige ≥100 mercados cruzados CON
  // precio a T-24h, así que hay que pedirle el precio a CADA uno. Se procesa
  // en lotes con concurrencia, y si el presupuesto se acaba se declara
  // truncado con cuántos alcanzó a ver — un conteo parcial que se sabe parcial
  // sigue siendo útil; uno parcial que se cree total, no.
  // `&indice=N` arranca en el N-ésimo cruzado: si los 312 no entran en una
  // corrida, se parte en dos y se suman — con los índices publicados para que
  // la suma no sea a ojo.
  const universoPrecios = cruzados.length ? cruzados
    : mercados.filter((m) => m.token_yes && m.fecha_resolucion);
  const objetivo = universoPrecios.slice(ctx.indice, ctx.indice + ctx.max_precios);
  const sobre = cruzados.length ? 'mercados_cruzados' : 'mercados_de_earnings (sin cruce disponible)';

  const t24 = {
    sobre, universo: universoPrecios.length,
    indice_inicial: ctx.indice, indice_final: ctx.indice + objetivo.length - 1,
    restantes_despues_de_esta_corrida: Math.max(0, universoPrecios.length - (ctx.indice + objetivo.length)),
    total: objetivo.length, procesados: 0, truncado: false, motivo_corte: null,
    conteo: { valido: 0, rancio: 0, sin_ticks: 0, sin_ticks_antes: 0, sin_precio: 0, error: 0, sin_token: 0 },
    formas: {}, detalle: [],
  };

  for (let i = 0; i < objetivo.length; i += CONCURRENCIA_CLOB) {
    if (restante() < 35000) {
      t24.truncado = true;
      t24.motivo_corte = `presupuesto_de_tiempo tras ${t24.procesados} de ${objetivo.length}`;
      break;
    }
    if (t24.procesados >= ctx.max_precios) {
      t24.truncado = true;
      t24.motivo_corte = `tope &max_precios=${ctx.max_precios}`;
      break;
    }
    if (t24.procesados >= objetivo.length) break;
    const lote = objetivo.slice(i, i + CONCURRENCIA_CLOB);
    const resultados = await Promise.all(lote.map((m) => precioDeUnMercado(m, clob1)));
    for (const r of resultados) {
      t24.procesados++;
      t24.conteo[r.clase] = (t24.conteo[r.clase] || 0) + 1;
      t24.formas[r.forma] = (t24.formas[r.forma] || 0) + 1;
      t24.detalle.push(r.fila);
    }
  }

  // Los "ejemplos" salen del mismo lote: cero requests extra.
  const ejemplos = t24.detalle.filter((d) => d.yes_t24h && d.yes_t24h.precio !== null).slice(0, ctx.ejemplos);
  if (!ctx.detalle_precios) t24.detalle = undefined;

  // ── 6. Revisiones de estimados — CERRADO: fuera de v1 ──
  // Resuelto en la corrida anterior con la fila cruda a la vista: lo que hay
  // son CONTEOS de revisiones y promedios ancla (7/30 días), sin valores
  // fechados. No es point-in-time. La sonda se sigue corriendo (es barata y
  // una fuente puede cambiar), pero el feature NO entra a v1 y el veredicto
  // de la Fase 0 ya no depende de ella.
  const revisiones = [];
  if (ctx.finnhubKey && restante() > 15000) {
    for (const path of ['/stock/eps-estimate', '/stock/revision']) {
      revisiones.push(await sondaPIT('finnhub' + path,
        `https://finnhub.io/api/v1${path}?symbol=AAPL&freq=quarterly&token=${ctx.finnhubKey}`));
    }
  } else {
    revisiones.push({ fuente: 'finnhub', status: 'sin_key', pit: false, motivo: 'FINNHUB_API_KEY no está en el entorno' });
  }
  if (ctx.avKey && restante() > 10000) {
    revisiones.push(await sondaPIT('alphavantage/EARNINGS_ESTIMATES',
      `https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=AAPL&apikey=${ctx.avKey}`));
  } else {
    revisiones.push({ fuente: 'alphavantage', status: 'sin_key', pit: false, motivo: 'ALPHAVANTAGE_API_KEY no está en el entorno' });
  }

  // Autodefensa: ¿todas las búsquedas trajeron el mismo número? Entonces lo
  // que se está midiendo es un tope, no una población (cicatriz de la 2ª
  // corrida). El censo lo dice arriba de todo y los conteos quedan marcados
  // como NO legibles.
  const sospecha_de_tope = detectaTopeUniforme(
    [...busqueda.intentos, ...porSimbolo.intentos], LIMITE_BUSQUEDA);

  return {
    ventana: { desde: ctx.desde, hasta: new Date().toISOString().slice(0, 10), meses: ctx.meses },
    sospecha_de_tope,
    sondas,
    descubrimiento: {
      metodo: 'dirigido (búsqueda → tags → racimo). El barrido por offset quedó como control opcional.',
      busqueda: { intentos: busqueda.intentos },
      simbolo: { intentos: porSimbolo.intentos, probados: porSimbolo.probados, de: porSimbolo.de },
      semillas: semillas_info,
      ruido_por_subcadena: {
        umbral: UMBRAL_RUIDO,
        nota: 'La búsqueda por símbolo es por SUBCADENA: un ticker que es palabra común trae de todo. Acá se ve cuánto trajo, cuánto sobrevivió al filtro, y una muestra de lo aceptado.',
        simbolos: ruidosos,
        aceptados_totales_de_ruidosos: ruidosos.reduce((a, r) => a + r.aceptados, 0),
        aceptados_con_simbolo_distinto: ruidosos.reduce((a, r) => a + r.aceptados_con_otro_simbolo, 0),
      },
      tags: { intentos: porTags.intentos, tags_vistos: porTags.tags_vistos || [] },
      cluster: { intentos: porCluster.intentos },
      aportes_crudos: aportes,
      mercados_de_earnings_por_camino: porCamino,
      estrategia_ganadora: ganadora ? { camino: ganadora[0], mercados_de_earnings: ganadora[1] } : null,
      sin_id_descartados: sinId,
    },
    topes_de_offset,
    barrido,
    esquema_observado: {
      claves_mas_frecuentes: [...claves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k} (${n})`),
      mercados_crudos: crudosPorId.size,
    },
    filtro_v1: {
      regla: 'v1 = SOLO beat/miss de EPS. Fuera: mercados de mención ("Will X say Y during the call"), otras métricas de earnings (volumen, guidance), y cualquiera cuyo símbolo resuelto no sea el buscado salvo que el título lo nombre explícitamente.',
      motivos: motivos_filtro,
      muestras: muestras_filtro,
    },
    conteos: {
      mercados_de_earnings_en_ventana: mercados.length,
      resueltos: resueltos.length,
      con_simbolo: conSimbolo.length,
      sin_simbolo: mercados.length - conSimbolo.length,
      en_universo_v0: mercados.filter((m) => m.en_universo_v0).length,
      con_consenso_en_descripcion: mercados.filter((m) => m.consenso_pm !== null).length,
      con_token_yes: mercados.filter((m) => m.token_yes).length,
      simbolo_ambiguo: mercados.filter((m) => m.symbol_ambiguo).length,
      sin_fecha_de_resolucion: mercados.filter((m) => !m.fecha_resolucion).length,
      universo_v0: universo.size,
      nombres_finnhub: nombres ? Object.keys(nombres).length : 0,
    },
    ejemplos,
    t24h: t24,
    cruce: { ...cruce, desfases },
    revisiones,
    estado_revisiones: 'CERRADO — fuera de v1 (conteos y promedios ancla, sin valores fechados)',
    rate_limit: {
      headers_observados: headersVistos,
      http_429,
      nota: 'El 422 NO es rate limit: es tope de offset de Gamma, y va aparte en topes_de_offset.',
    },
    muestras: {
      earnings: mercados.slice(0, 5).map((m) => ({ pregunta: m.pregunta, symbol: m.symbol, via: m.symbol_via, camino: m.via, fecha: m.fecha_resolucion, outcome: m.outcome, consenso: m.consenso_pm })),
      sin_simbolo: mercados.filter((m) => !m.symbol).slice(0, 5).map((m) => m.pregunta),
      descartados_por_el_filtro: descartados,
    },
    ms_totales: Date.now() - t0,
  };
}

// Sonda de una fuente de revisiones. Pregunta única: ¿da un valor por FECHA DE
// CORTE, o solo "el estimado de hoy"? Lo segundo NO sirve y se dice así.
async function sondaPIT(fuente, url) {
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return { fuente, status: 'neterror', pit: false, motivo: String((e && e.message) || e).slice(0, 120) };
  }
  if (!r.ok) {
    return { fuente, status: r.status === 403 || r.status === 401 ? 'premium_o_sin_permiso' : 'httperror', http: r.status, pit: false, motivo: `HTTP ${r.status}` };
  }
  let body = null;
  try { body = await r.json(); } catch (e) { return { fuente, status: 'nonjson', http: r.status, pit: false, motivo: 'cuerpo no-JSON' }; }
  // Alpha Vantage rate-limitea con HTTP 200 + {Note|Information} (trampa
  // documentada en _lib/av-earnings.js): sin esto, un 200 vacío parecería GO.
  if (body && (body.Note || body.Information)) {
    return { fuente, status: 'premium_o_rate_limit', http: 200, pit: false, motivo: String(body.Note || body.Information).slice(0, 160) };
  }
  const ev = evaluaFuentePIT(body);
  return { fuente, status: 'ok', http: r.status, ...ev };
}

// ─────────────────── handler ───────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};

  // ── VISTA EN VIVO: pública, ANTES del gate ────────────────────────
  // La consume la tab EARNINGS desde el navegador, así que no puede pedir
  // CRON_SECRET. Es SOLO LECTURA (un SELECT a pead_earnings) y no expone nada
  // que la app no muestre ya: precios públicos de Polymarket e historial de
  // EPS. El censo (?smoke=1) sigue detrás del gate.
  if (String(q.vista || '').toLowerCase() === 'live') {
    try {
      // ?diag=MU,COST → base histórica de esos símbolos, sin pasar por Gamma.
      if (q.diag) {
        const cual = String(q.diag).toLowerCase();
        const out = cual === 'escala' ? await censoDeEscala()
          : cual === 'desacuerdos' ? await diagDesacuerdos()
          : await diagnosticoSimbolos(String(q.diag).split(','));
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        return res.status(200).json(out);
      }
      const out = await vistaLive({});
      // El precio se mueve, pero no cada segundo: 5 min de CDN con revalidación
      // en segundo plano. Sin esto, cada visita pagaría ~100 requests a Gamma.
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
      return res.status(200).json(out);
    } catch (err) {
      // Un fallo acá NO es un estado vacío: se dice que falló y por qué.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ vista: 'live', error: 'earnings-beat live: ' + ((err && err.message) || 'unknown'), empresas: [] });
    }
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }

  res.setHeader('Cache-Control', 'no-store');

  if (String(q.smoke || '') !== '1') {
    return res.status(200).json({
      que: 'Experimento earnings-beat: ¿QuantDesk predice beat/miss de EPS mejor que Polymarket?',
      fase: 0,
      estado: 'censo + smoke. Cero código de modelo hasta que la Fase 0 pase.',
      uso: '/api/earnings-beat?smoke=1 (agregá &format=md para leerlo en español)',
      criterios_congelados: CRITERIOS,
      doc: 'docs/earnings-beat-scope.md',
    });
  }

  const meses = Math.max(1, Math.min(60, Number(q.meses) || 12));
  let desde = /^\d{4}-\d{2}-\d{2}$/.test(String(q.desde || '')) ? String(q.desde) : null;
  if (!desde) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - meses);
    desde = d.toISOString().slice(0, 10);
  }
  const ctx = {
    desde, meses,
    barrido: String(q.barrido || '') === '1',
    // Cuántos símbolos del universo v0 se buscan uno por uno (camino D).
    // Default: todos. &simbolos=0 lo apaga.
    simbolos: q.simbolos === undefined ? 99 : Math.max(0, Math.min(200, Number(q.simbolos) || 0)),
    // Tope de mercados a los que se les pide precio (el conteo del candado).
    max_precios: Math.max(1, Math.min(500, Number(q.max_precios) || 400)),
    // Índice de arranque dentro de los cruzados (segunda pasada sumable).
    indice: Math.max(0, Number(q.indice) || 0),
    detalle_precios: String(q.detalle || '') === '1',
    paginas: Math.max(1, Math.min(60, Number(q.paginas) || 20)),
    limite: Math.max(1, Math.min(500, Number(q.limite) || 500)),
    ejemplos: Math.max(1, Math.min(10, Number(q.ejemplos) || 3)),
    finnhubKey: process.env.FINNHUB_API_KEY || null,
    avKey: process.env.ALPHAVANTAGE_API_KEY || null,
  };

  try {
    const censo = await corre(ctx);
    const salida = {
      pregunta: '¿Se puede construir el dataset del experimento earnings-beat con la API pública de Polymarket?',
      fase: 0, solo_lectura: true,
      generado_en: new Date().toISOString(),
      criterios_congelados: CRITERIOS,
      ...censo,
    };
    if (String(q.format || '').toLowerCase() === 'md' || String(q.format || '').toLowerCase() === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(resumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'earnings-beat: ' + ((err && err.message) || 'unknown') });
  }
}

export { corre, ESTRATEGIAS };
export { filasDe, aplanaMercados, cosechaDeBusqueda, formaDe } from './_lib/earnings-beat-descubrir.js';
