// ═══════════════════════════════════════════════════════════════════
// /api/reaccion-analyze — ¿qué parte de un reporte explica el movimiento?
//
//   GET ?fase=0                      → CENSO de los tres frentes (sin análisis)
//   GET ?fase=0&frente=precios       → solo un frente (cada uno tiene su
//   GET ?fase=0&frente=ingresos         propio presupuesto de 300 s; correrlos
//   GET ?fase=0&frente=guia             por separado es lo más seguro)
//   GET ?fase=1                      → el ANÁLISIS pre-registrado
//   … &format=md                     → resumen en español
//
// ── EL ORDEN NO SE SALTEA ──────────────────────────────────────────
// La Fase 0 mide si hay con qué y NO dictamina ninguna señal. La Fase 1 aplica
// los criterios congelados en CRITERIOS_REACCION (api/_lib/reaccion.js),
// incluida la regla de que un frente con <50% de cobertura NO entra — y esa
// regla la aplica el código, no la memoria de quien lee el censo.
//
// ── LA UNIDAD ES EL REPORTE, NO EL MERCADO ─────────────────────────
// pm_earnings_markets puede tener VARIOS mercados del mismo reporte (umbrales
// distintos). Contar un reporte tres veces inflaría la n y fabricaría
// significancia. Se deduplica por (símbolo, fecha) y se publican los dos
// conteos.
//
// ── SOLO LECTURA en Neon ───────────────────────────────────────────
// SELECT a pm_earnings_markets, pead_earnings y pead_event_hour. Sin
// ensureSchema, sin heartbeat. Las fuentes externas se leen en vivo y no se
// guardan.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional) · FMP_API_KEY ·
//           FINNHUB_API_KEY · ALPHAVANTAGE_API_KEY · SEC_USER_AGENT (opcional) ·
//           REACCION_FINNHUB_PAUSA_MS (opcional, default 1100)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { bajaSerie, bajaSeries } from './_lib/yahoo-daily.js';
import {
  CRITERIOS_REACCION, retornoVentana, retornoSaltoNocturno, sorpresaEps, sorpresaIngresos, clasificaFuenteEstimado,
  ingresoDelEvento, analizaReaccion, advertenciasFijas, renderCensoMd, renderAnalisisMd, diagnosticaCobertura,
} from './_lib/reaccion.js';
import {
  fmpAnalystEstimatesTrimestral, fmpEarnings, finnhubCalendario, avEarningsEstimates,
  sondaFuente, cruzaFila, barreFuente, ingresosReportadosEdgar, guiaDeSimbolo,
  crearCliente, bajarTickerMap,
} from './_lib/reaccion-fuentes.js';

export const maxDuration = 300;
// Margen bajo los 300 s de Vercel: lo que no entra se DECLARA cortado, no se
// pierde en un timeout que no dice qué alcanzó a hacer.
const PRESUPUESTO_MS = 270000;
const RANGO_PRECIOS = '10y';
// Finnhub gratis corta a 60/min: 1.1 s entre pedidos deja margen. Es una perilla
// operativa (si el plan cambia, se ajusta sin tocar código); los tests la ponen
// en 0 porque su red es simulada.
const FINNHUB_PAUSA_MS = (() => {
  const n = Number(process.env.REACCION_FINNHUB_PAUSA_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1100;
})();
// Desde dónde se piden filings y estimados. Un HECHO FIJO, no una referencia a
// "hoy": es donde arranca la historia de las fuentes que se usan (los 88 meses
// de grades de FMP empiezan en 2019-01) y cubre todos los eventos del universo.
const DESDE_FUENTES = /* date-lint-ok: inicio fijo de la historia de las fuentes (2019-01), no una referencia a hoy */ '2019-01-01';

// La guía NO entra al análisis en esta versión, y el motivo es fijo: no es una
// opinión sobre los párrafos, es que faltan las dos piezas para hacer un número.
const MOTIVO_GUIA_NO_ENTRA = 'La guía como VARIABLE necesita dos piezas que hoy no existen: (1) el número de la guía extraído del texto SIN LLM, y (2) el consenso del trimestre siguiente con fecha anterior al reporte. El censo devuelve los párrafos crudos para ver si la primera es factible; como variable, la cobertura es 0%.';

// ── Los eventos: un REPORTE por (símbolo, fecha) ──
async function cargaEventos() {
  const filas = await sql(
    `select m.symbol,
            to_char(m.report_date, 'YYYY-MM-DD') as report_date,
            to_char(p.fiscal_date_ending, 'YYYY-MM-DD') as fiscal_date_ending,
            p.reported_eps, p.estimated_eps
       from pm_earnings_markets m
       left join pead_earnings p
         on p.symbol = m.symbol and p.reported_date = m.report_date
      where m.outcome is not null and m.report_date is not null
      order by m.report_date asc, m.symbol asc`
  );
  const porReporte = new Map();
  for (const f of filas) {
    const k = `${f.symbol}|${f.report_date}`;
    if (!porReporte.has(k)) porReporte.set(k, { ...f, mercados: 0 });
    porReporte.get(k).mercados++;
  }
  // La hora del reporte (BMO/AMC) no entra a la variable: se reporta por la
  // nota de la ventana. La tabla puede no existir en un despliegue viejo.
  let horas = new Map(), errorHora = null;
  try {
    const hs = await sql(`select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, hour from pead_event_hour`);
    horas = new Map(hs.map((h) => [`${h.symbol}|${h.reported_date}`, h.hour]));
  } catch (e) { errorHora = String((e && e.message) || e).slice(0, 200); }

  const eventos = [...porReporte.values()].map((e) => ({ ...e, hour: horas.get(`${e.symbol}|${e.report_date}`) || null }));
  return { eventos, mercados: filas.length, errorHora };
}

// ── Precios: la variable dependiente ──
async function preciosDeEventos(eventos, { deadline }) {
  const simbolos = [...new Set(eventos.map((e) => e.symbol))].sort();
  const [spy, series] = await Promise.all([bajaSerie('SPY', RANGO_PRECIOS), bajaSeries(simbolos, RANGO_PRECIOS)]);
  const ret = new Map(), salto = new Map();
  for (const e of eventos) {
    const k = `${e.symbol}|${e.report_date}`;
    ret.set(k, retornoVentana(series[e.symbol], spy, e.report_date));
    // La SENSIBILIDAD pre-registrada: solo con hora BMO/AMC conocida. Se mide
    // con las mismas series, en la misma pasada — no hay una bajada aparte que
    // pueda traer otros datos.
    salto.set(k, retornoSaltoNocturno(series[e.symbol], spy, e.report_date, e.hour));
  }
  return {
    ret, salto,
    series: { pedidas: simbolos.length, ok: simbolos.filter((s) => series[s]).length, spy: !!spy },
    simbolos_sin_serie: simbolos.filter((s) => !series[s]),
    cortado: Date.now() > deadline,
  };
}

// ── Ingresos estimados: sondas, barrido de las fuentes que pueden servir, y la
// elección con la regla congelada. Lo usan la Fase 0 Y la Fase 1, para que el
// análisis use exactamente la fuente que el censo habría elegido.
async function estimadosDeIngresos(eventos, { deadline, hoy, conSondasCaras = true }) {
  const simbolos = [...new Set(eventos.map((e) => e.symbol))].sort();
  const sondas = [];

  if (conSondasCaras) {
    // FMP analyst-estimates trimestral: el encargo dice que es de pago. Se
    // CONFIRMA. Si el 402 nombra `symbol` (la empresa no está en el plan) eso no
    // dice nada de `period`: se prueba con la siguiente, hasta 3.
    for (const s of simbolos.slice(0, 3)) {
      const sd = await sondaFuente(fmpAnalystEstimatesTrimestral, s, { hoy });
      sondas.push(sd);
      if (sd.motivo !== 'sin_acceso_al_simbolo') break;
    }
    // AV: UN símbolo. La cuota (25/día) es la del PEAD.
    sondas.push({ ...(await sondaFuente(avEarningsEstimates, simbolos[0], { hoy })),
      nota_cuota: 'Sondeada con UN símbolo a propósito: la cuota de Alpha Vantage es de 25/día y la usa el PEAD.' });
  }

  // Las dos fuentes con forma de "estimado del evento" se BARREN: el barrido es
  // la medición. Gatear el barrido con una sonda de un símbolo repetiría el
  // error del censo de Polymarket — concluir sobre la fuente por un solo dato.
  const barridos = [
    { fuente: 'FMP earnings', fn: fmpEarnings, opts: { concurrencia: 2 } },
    { fuente: 'Finnhub calendar/earnings', fn: finnhubCalendario,
      // Finnhub corta a 60/min: un hilo y un poco más de un segundo entre pedidos.
      opts: { concurrencia: 1, pausaMs: FINNHUB_PAUSA_MS, opciones: { desde: DESDE_FUENTES, hasta: hoy } } },
  ];
  const cobertura = [];
  const filasElegibles = {};
  for (const b of barridos) {
    const r = await barreFuente(b.fn, simbolos, { ...b.opts, deadline });
    // La CLASE se dicta con la forma CRUDA de la primera respuesta buena.
    const clase = r.crudasPrimera ? clasificaFuenteEstimado(r.crudasPrimera, { hoy }) : null;
    const sirve = !!clase && (clase.clase === 'pit_con_fecha' || clase.clase === 'estimado_del_evento');
    const conDato = eventos.filter((e) => cruzaFila(r.porSimbolo.get(e.symbol), e.report_date)).length;
    const motivosFallo = Object.values(r.fallos).reduce((a, f) => { a[f.motivo] = (a[f.motivo] || 0) + 1; return a; }, {});
    sondas.push({
      fuente: b.fuente, symbol: '(barrido)', ok: r.porSimbolo.size > 0,
      status: null, motivo: r.porSimbolo.size ? null : Object.keys(motivosFallo)[0] || 'sin_respuestas',
      detalle: `${r.porSimbolo.size} de ${r.pedidos} símbolos respondieron` + (Object.keys(motivosFallo).length ? ` · fallos: ${Object.entries(motivosFallo).map(([k, v]) => `${k}: ${v}`).join(', ')}` : '') + (r.cortado ? ' · CORTADO por presupuesto' : ''),
      clase: clase ? clase.clase : null, sirve, nota: clase ? (clase.nota || clase.motivo || null) : null,
      fila_cruda: clase ? clase.fila_cruda : null,
      body_sample: r.porSimbolo.size ? null : (Object.values(r.fallos)[0] || {}).detalle || null,
    });
    cobertura.push({ fuente: b.fuente, clase: clase ? clase.clase : null, sirve, con_dato: conDato, total: eventos.length,
      cobertura: eventos.length ? +(conDato / eventos.length).toFixed(3) : 0,
      simbolos_sin_acceso: Object.entries(r.fallos).filter(([, f]) => f.motivo === 'sin_acceso_al_simbolo').map(([s]) => s),
      cortado: r.cortado,
      // ¿El conteo de arriba es un HECHO de la fuente o un BUG del cruce? Lo
      // decide esto: rango de fechas devuelto, filas con las dos cifras, cuántas
      // caen en la ventana de los eventos, y la distancia a la fila más cercana.
      diagnostico: diagnosticaCobertura(eventos, r.porSimbolo) });
    if (sirve) filasElegibles[b.fuente] = r.porSimbolo;
  }

  // ── LA ELECCIÓN, con la regla congelada ──
  // Mayor cobertura entre las que SIRVEN; empate → la que trae fecha de corte.
  // Nunca se mezclan.
  const candidatas = cobertura.filter((c) => c.sirve)
    .sort((a, b) => (b.cobertura - a.cobertura) || ((b.clase === 'pit_con_fecha') - (a.clase === 'pit_con_fecha')));
  const elegida = candidatas[0] || null;
  return {
    sondas, cobertura_por_fuente: cobertura,
    elegida: elegida ? elegida.fuente : null,
    cobertura_elegida: elegida ? elegida.cobertura : 0,
    porque_eleccion: elegida
      ? `${candidatas.length} fuente(s) con la forma que la regla acepta; se elige la de mayor cobertura (${(elegida.cobertura * 100).toFixed(0)}%). ${CRITERIOS_REACCION.regla_fuente_ingresos.replace(/_/g, ' ')}.`
      : 'Ninguna fuente devolvió estimados de ingresos con una forma que la regla acepte (estimado anterior al reporte).',
    filas: elegida ? filasElegibles[elegida.fuente] : null,
  };
}

// ── Ingresos REPORTADOS en EDGAR: censo y auditoría de la fuente elegida ──
async function reportadosEdgar(eventos, { deadline, filasFuente }) {
  const simbolos = [...new Set(eventos.map((e) => e.symbol))].sort();
  let cli, mapa;
  try {
    cli = crearCliente();
    ({ map: mapa } = await bajarTickerMap(cli));
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200), simbolos_pedidos: simbolos.length, simbolos_con_dato: 0,
      eventos_con_dato: 0, total: eventos.length, cobertura: 0, q4_derivados: 0 };
  }
  const porSimbolo = new Map(), tags = {}, sinCik = [];
  let cortado = false;
  for (const s of simbolos) {
    if (Date.now() > deadline) { cortado = true; break; }
    const ent = mapa[s];
    if (!ent) { sinCik.push(s); continue; }
    const r = await ingresosReportadosEdgar(cli, ent.cik);
    if (r.ok) { porSimbolo.set(s, r.trimestres); tags[s] = r.tag; }
  }
  let conDato = 0, q4 = 0, comparados = 0, coinciden = 0;
  for (const e of eventos) {
    const t = ingresoDelEvento(porSimbolo.get(e.symbol), e.fiscal_date_ending);
    if (!t) continue;
    conDato++;
    if (t.derivado) q4++;
    // La AUDITORÍA: ¿el ingreso real de la fuente elegida es el de EDGAR?
    const f = filasFuente ? cruzaFila(filasFuente.get(e.symbol), e.report_date) : null;
    if (f && f.revenueActual) {
      comparados++;
      if (Math.abs(f.revenueActual - t.valor) / Math.abs(t.valor) * 100 <= CRITERIOS_REACCION.tolerancia_acuerdo_ingresos_pct) coinciden++;
    }
  }
  return {
    simbolos_pedidos: simbolos.length, simbolos_con_dato: porSimbolo.size, simbolos_sin_cik: sinCik,
    eventos_con_dato: conDato, total: eventos.length,
    cobertura: eventos.length ? +(conDato / eventos.length).toFixed(3) : 0,
    q4_derivados: q4, tags_usados: tags,
    acuerdo_con_fuente: filasFuente ? { comparados, coinciden } : null,
    cortado,
  };
}

// ── La guía: 10 símbolos, el párrafo crudo ──
// NKE va primero si está entre los eventos (es el caso que motiva el
// experimento); después, alfabético. `?simbolos_guia=` lo reemplaza: es un
// CENSO, elegir a quién leer no mueve ninguna portería.
async function censoDeGuia(eventos, { deadline, override }) {
  const disponibles = [...new Set(eventos.map((e) => e.symbol))].sort();
  const elegidos = override && override.length ? override
    : [...(disponibles.includes('NKE') ? ['NKE'] : []), ...disponibles.filter((s) => s !== 'NKE')].slice(0, CRITERIOS_REACCION.simbolos_guia);
  let cli, mapa;
  try {
    cli = crearCliente();
    ({ map: mapa } = await bajarTickerMap(cli));
  } catch (e) {
    return { simbolos: [], filings_leidos: 0, filings_con_guia: 0, error: String((e && e.message) || e).slice(0, 200) };
  }
  const out = [];
  for (const s of elegidos) {
    if (Date.now() > deadline) { out.push({ symbol: s, motivo: 'cortado_por_presupuesto', filings: [] }); continue; }
    const ent = mapa[s];
    if (!ent) { out.push({ symbol: s, motivo: 'sin_cik_en_edgar', filings: [] }); continue; }
    const r = await guiaDeSimbolo(cli, ent.cik, { desde: DESDE_FUENTES });
    out.push({ symbol: s, motivo: r.ok ? null : r.motivo, filings: r.filings || [] });
  }
  const filings = out.flatMap((x) => x.filings);
  return {
    simbolos: out,
    filings_leidos: filings.length,
    filings_con_guia: filings.filter((f) => (f.parrafos || []).some((p) => !p.parece_safe_harbor)).length,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const fase = String(q.fase || '0');
  const esMd = ['md', 'markdown'].includes(String(q.format || '').toLowerCase());
  const deadline = Date.now() + PRESUPUESTO_MS;
  const hoy = new Date().toISOString().slice(0, 10);

  try {
    const { eventos, mercados, errorHora } = await cargaEventos();
    if (!eventos.length) {
      return res.status(200).json({ error: 'pm_earnings_markets no tiene reportes resueltos — corré primero la cosecha del earnings-beat.' });
    }
    const empresas = new Set(eventos.map((e) => e.symbol)).size;
    const conEps = eventos.filter((e) => sorpresaEps(e.reported_eps, e.estimated_eps).ok).length;

    if (fase === '0') {
      const frente = ['precios', 'ingresos', 'guia'].includes(String(q.frente)) ? String(q.frente) : 'todos';
      const frentes = {};
      const corre = (f) => frente === 'todos' || frente === f;

      if (corre('precios')) {
        const p = await preciosDeEventos(eventos, { deadline });
        const vals = [...p.ret.values()];
        const ok = vals.filter((r) => r.ok).length;
        const descartes = {};
        for (const r of vals) if (!r.ok) descartes[r.motivo] = (descartes[r.motivo] || 0) + 1;
        const cob = eventos.length ? ok / eventos.length : 0;
        frentes.precios = {
          total: eventos.length, con_retorno: ok, cobertura: +cob.toFixed(3), descartes,
          series: p.series, simbolos_sin_serie: p.simbolos_sin_serie,
          con_hora: eventos.filter((e) => e.hour).length, error_hora: errorHora,
          // La cobertura de la SENSIBILIDAD, contada en el censo para que la
          // decisión de cuánto pesa se tome con este número y no con el resultado.
          sensibilidad: (() => {
            const ss = [...p.salto.values()];
            const ok = ss.filter((x) => x.ok).length;
            const motivos = {};
            for (const x of ss) if (!x.ok) motivos[x.motivo] = (motivos[x.motivo] || 0) + 1;
            return { rol: 'sensibilidad — no reemplaza a la principal', ventana: `BMO: ${CRITERIOS_REACCION.sensibilidad_salto_nocturno.bmo} · AMC: ${CRITERIOS_REACCION.sensibilidad_salto_nocturno.amc}`,
              con_salto: ok, de: eventos.length, alcanza_el_candado: ok >= CRITERIOS_REACCION.min_eventos, descartes: motivos };
          })(),
          entra: cob >= CRITERIOS_REACCION.min_cobertura_frente,
          porque: cob >= CRITERIOS_REACCION.min_cobertura_frente
            ? `${(cob * 100).toFixed(0)}% de los eventos tiene la ventana completa: la variable dependiente existe.`
            : `Solo ${(cob * 100).toFixed(0)}% de los eventos tiene la ventana completa: sin variable dependiente, la Fase 1 sale INCONCLUSO entera.`,
        };
      }

      if (corre('ingresos')) {
        const est = await estimadosDeIngresos(eventos, { deadline, hoy });
        const rep = await reportadosEdgar(eventos, { deadline, filasFuente: est.filas });
        const entra = !!est.elegida && est.cobertura_elegida >= CRITERIOS_REACCION.min_cobertura_frente;
        frentes.ingresos = {
          estimados: { ...est, filas: undefined }, reportados_edgar: rep,
          cobertura: est.cobertura_elegida, entra,
          porque: !est.elegida
            ? 'NO ENTRA: ninguna fuente gratis da el estimado de ingresos ANTERIOR al reporte. Los ingresos reportados de EDGAR solos no hacen una sorpresa.'
            : entra
              ? `ENTRA con ${est.elegida}: ${(est.cobertura_elegida * 100).toFixed(0)}% de los eventos tiene estimado y real del mismo reporte.`
              : `NO ENTRA: la mejor fuente (${est.elegida}) cubre ${(est.cobertura_elegida * 100).toFixed(0)}% de los eventos, bajo el mínimo de ${CRITERIOS_REACCION.min_cobertura_frente * 100}%.`,
        };
      }

      if (corre('guia')) {
        const override = String(q.simbolos_guia || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        const g = await censoDeGuia(eventos, { deadline, override });
        frentes.guia = { ...g, cobertura_como_variable: 0, entra: false, porque: `NO ENTRA. ${MOTIVO_GUIA_NO_ENTRA}` };
      }

      const salida = {
        fase: 0, frente, generado_en: new Date().toISOString(), solo_lectura_en_neon: true,
        pregunta: '¿Hay con qué medir qué parte del reporte explica el movimiento? (cobertura por frente, sin análisis)',
        eventos: { total: eventos.length, mercados, nota_unidad: 'Un evento es un REPORTE (símbolo, fecha). Varios mercados del mismo reporte cuentan una vez.',
          empresas, con_eps: conEps, cobertura_eps: +(conEps / eventos.length).toFixed(3) },
        frentes, criterios: CRITERIOS_REACCION, advertencias: advertenciasFijas(),
        cortado_por_presupuesto: Date.now() > deadline,
      };
      if (esMd) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(renderCensoMd(salida)); }
      return res.status(200).json(salida);
    }

    if (fase === '1') {
      // ── FASE 1. Las mismas mediciones que el censo, y la regla del 50%
      // aplicada por el código. ──
      const p = await preciosDeEventos(eventos, { deadline });
      const est = await estimadosDeIngresos(eventos, { deadline, hoy, conSondasCaras: false });
      const ingresosEntra = !!est.elegida && est.cobertura_elegida >= CRITERIOS_REACCION.min_cobertura_frente;

      const filas = eventos.map((e) => {
        const f = ingresosEntra ? cruzaFila(est.filas.get(e.symbol), e.report_date) : null;
        return {
          symbol: e.symbol, report_date: e.report_date,
          ret: p.ret.get(`${e.symbol}|${e.report_date}`),
          salto: p.salto.get(`${e.symbol}|${e.report_date}`),
          eps: sorpresaEps(e.reported_eps, e.estimated_eps),
          // Real y estimado de la MISMA fuente: mezclar el real de EDGAR con el
          // estimado de otra fuente compararía dos definiciones de "ingresos".
          ingresos: f ? sorpresaIngresos(f.revenueActual, f.revenueEstimate) : null,
          guia: null,
        };
      });
      const a = analizaReaccion(filas, {
        motivosNoEntra: {
          ingresos: est.elegida
            ? `La mejor fuente (${est.elegida}) no alcanza el mínimo.`
            : 'Ninguna fuente gratis da el estimado de ingresos anterior al reporte.',
          guia: MOTIVO_GUIA_NO_ENTRA,
        },
      });
      const salida = {
        fase: 1, pre_registrado: true, generado_en: new Date().toISOString(), solo_lectura_en_neon: true,
        pregunta: '¿Qué parte del reporte explica el movimiento cierre(T-1) → apertura(T+1), ajustado por SPY?',
        unidad: { reportes: eventos.length, mercados },
        fuente_ingresos: { elegida: est.elegida, cobertura: est.cobertura_elegida, porque: est.porque_eleccion },
        ...a,
      };
      if (String(q.eventos || '') === '1') salida.detalle_eventos = filas.map((f) => ({ symbol: f.symbol, report_date: f.report_date,
        ret_ajustado: f.ret && f.ret.ok ? +f.ret.ret_ajustado.toFixed(5) : null,
        eps_w: f.eps && f.eps.ok ? +f.eps.winsorizada.toFixed(3) : null,
        ingresos: f.ingresos && f.ingresos.ok ? +f.ingresos.valor.toFixed(3) : null }));
      if (esMd) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(renderAnalisisMd(salida)); }
      return res.status(200).json(salida);
    }

    return res.status(400).json({ error: '?fase= tiene que ser 0 (censo) o 1 (análisis).' });
  } catch (err) {
    return res.status(500).json({ error: 'reaccion-analyze: ' + ((err && err.message) || 'unknown') });
  }
}

export { cargaEventos, MOTIVO_GUIA_NO_ENTRA };
