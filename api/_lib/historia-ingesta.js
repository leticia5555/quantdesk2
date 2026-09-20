// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-ingesta.js — de EDGAR a las tablas.
//
// El transporte (api/_lib/edgar.js) baja bytes; el esquema
// (api/_lib/historia-db.js) los guarda. Esto es lo del medio: leer el índice
// de filings y el companyfacts, y convertirlos en filas que se puedan CITAR.
//
// La regla que ordena todo el archivo: **un hecho que no se puede citar no
// entra**. No se guarda con la cita en blanco, no se guarda "para después".
// Se descarta, se cuenta y el conteo viaja en el resultado — porque un hueco
// declarado es un dato y un hueco silencioso es un bug esperando.
//
// ── LAS CUATRO COSAS QUE NO SON OBVIAS ──────────────────────────────
//
// **1. Q4 no existe como hecho.** Un emisor reporta Q1–Q3 en 10-Q y el AÑO en
// 10-K. Hay que derivarlo, `Q4 = FY − 9M`, y eso trae una consecuencia que el
// memo no había visto: el valor depende de DOS filings, así que lleva DOS
// citas (`accession` del 10-K, `accession_aux` del 10-Q). El emparejamiento
// exige el MISMO inicio de año fiscal, no solo fechas cercanas: un 9M que
// arranca en otra fecha es de otro año, y restarlo daría un número plausible
// y falso.
//
// **2. La serie cambia de tag a mitad de camino.** ASC 606 partió `Revenues`
// en `RevenueFromContractWithCustomer…`. La familia une los alias para que la
// película no se corte en 2018 — pero el rango (historia-db.js) decide cuál
// gana en cada periodo, así que acá solo se etiqueta: `familia` y
// `familia_rango` viajan con cada hecho y la vista hace el resto.
//
// **3. Las páginas viejas del índice no traen la columna `items`.** Un
// `undefined` ahí no explota: se cuela como "8-K sin item" y ensucia el censo
// en silencio. Es el bug que la Fase 0 del Congreso pagó con dos corridas, y
// por eso el aplanado normaliza cada columna en vez de confiar en que esté.
//
// **4. Concatenar páginas rompe el orden.** EDGAR devuelve cada página en
// reverse-cron, pero la principal trae lo nuevo y las extra lo viejo: pegadas
// sin ordenar, cualquier ventana de "últimos N años" sale mal.
//
// ── LO QUE ESTA CAPA NO HACE ────────────────────────────────────────
// No decide qué mostrar, no narra y no interpreta la guía: G5 midió 0/4
// conceptos de guía etiquetados (§11), así que **no se guarda ningún número
// de guía** — se guarda el 8-K con item 2.02 y su `accession`, y quien quiera
// la guía abre el documento. Es la salida 1 de §3, congelada en la decisión 4.
// ═══════════════════════════════════════════════════════════════

import {
  bajarSubmissionsCompleto, bajarCompanyFacts, bajarTickerMap,
  urlDocumento, urlIndice, pad10,
} from './edgar.js';
import { mapearConcepto } from './historia-db.js';

// Decisión 3 de §10: 5 años de índice de filings, 3 de serie trimestral.
export const ANIOS_FILINGS = 5;
export const ANIOS_FACTS = 3;

const DIA_MS = 86400000;
export const hoyISO = (ahora = Date.now()) => new Date(ahora).toISOString().slice(0, 10);
export const restarAnios = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};
export const dias = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS);
export const sumarDias = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);

// `Number(null)` es 0, y `Number('')` también. En una tabla cuyo punto entero
// es que nada esté inventado, eso habría convertido un hecho SIN valor en un
// cero perfectamente creíble — el peor error posible acá, porque no se ve.
// Todo lo que no sea un número de verdad sale NaN y se descarta contado.
export function aNumero(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  return Number(v);
}

// ─────────────────────────────────────────────────────────────────────────
// El índice de filings
// ─────────────────────────────────────────────────────────────────────────

// Aplana `filings.recent` y las páginas extra a una lista ordenada por fecha.
// Cada columna se normaliza: las páginas viejas no traen `items`, y un
// `undefined` que se cuela como '' cuenta un 8-K como "sin item" sin avisar.
export function aplanarSubmissions({ principal, paginas = [] } = {}) {
  const bloques = [];
  if (principal?.filings?.recent) bloques.push(principal.filings.recent);
  for (const p of paginas) if (p?.json) bloques.push(p.json);

  const filas = [];
  for (const b of bloques) {
    const n = (b.accessionNumber || []).length;
    for (let i = 0; i < n; i++) {
      const accession = b.accessionNumber[i];
      const filed = b.filingDate?.[i] || null;
      // Sin accession o sin fecha no hay fila: la clave primaria es
      // (cik, accession) y un filing sin fecha no se puede ubicar en ninguna
      // ventana. Se cuenta afuera, no se inventa.
      if (!accession || !filed) continue;
      filas.push({
        accession,
        form: String(b.form?.[i] || '').toUpperCase(),
        filed,
        reportDate: b.reportDate?.[i] || null,
        items: String(b.items?.[i] ?? ''),
        primaryDocument: String(b.primaryDocument?.[i] ?? ''),
        isXBRL: Boolean(Number(b.isXBRL?.[i] ?? 0)),
        size: Number(b.size?.[i] ?? 0) || null,
      });
    }
  }
  // La principal trae lo nuevo y las extra lo viejo: sin ordenar, una ventana
  // de "últimos 5 años" corta por donde no es.
  filas.sort((a, b) => (a.filed === b.filed ? (a.accession < b.accession ? 1 : -1) : (a.filed < b.filed ? 1 : -1)));
  return filas;
}

// '5.02,9.01' → ['5.02', '9.01']. Lo que no matchea N.NN se descarta: un item
// mal formado guardado como si fuera bueno haría que "dame los 5.02" mienta.
export function itemsDe(raw) {
  return [...new Set(
    String(raw || '')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => /^\d{1,2}\.\d{2}$/.test(s)),
  )];
}

// El perfil que clasifica G6 y decide la etiqueta de cobertura. Se MIDE del
// índice, no se asume del ticker: el memo creía que MELI era un 20-F filer y
// la corrida 2 lo desmintió (§11).
export function perfilDe(filas) {
  const formas = new Set(filas.map((f) => f.form));
  const anual = ['10-K', '20-F', '40-F'].find((f) => formas.has(f)) || null;
  const extranjero = formas.has('20-F') || formas.has('40-F');
  return {
    formaAnual: anual,
    // La regla del encargo: el extranjero NO se esconde, se etiqueta. Sale del
    // cálculo de cobertura (company_cobertura.cuenta_para_cobertura), no del
    // módulo.
    cobertura: extranjero ? 'parcial' : 'completa',
    tiene10Q: formas.has('10-Q'),
    tiene8K: formas.has('8-K'),
    tiene6K: formas.has('6-K'),
  };
}

// Filas listas para company_filings. `desde` recorta la ventana.
export function filingsParaGuardar(cik, filas, { desde = null } = {}) {
  const enVentana = desde ? filas.filter((f) => f.filed >= desde) : filas;
  return enVentana.map((f) => ({
    cik,
    accession: f.accession,
    form: f.form,
    items_raw: f.items,
    filed: f.filed,
    report_date: f.reportDate || null,
    primary_doc: f.primaryDocument || null,
    // Sin documento primario no hay a qué enlazar la cita. La URL del
    // directorio igual sirve, así que se guarda ésa y no una rota.
    url: f.primaryDocument ? urlDocumento(cik, f.accession, f.primaryDocument) : urlIndice(cik, f.accession),
    index_url: urlIndice(cik, f.accession),
    is_xbrl: f.isXBRL,
    size_bytes: f.size,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Los hechos XBRL
// ─────────────────────────────────────────────────────────────────────────

// Clasificación por LARGO del periodo. Los rangos son anchos a propósito: un
// trimestre fiscal real va de 13 semanas (91 días) a un 4-5-4 que estira.
export function clasePeriodo(d) {
  if (d >= 60 && d <= 115) return 'Q';
  if (d >= 150 && d <= 200) return 'H1';
  if (d >= 240 && d <= 300) return '9M';
  if (d >= 330 && d <= 400) return 'FY';
  return 'OTRO';
}

// units.{USD,shares,…} → lista plana. La unidad viaja: un EPS en USD/shares y
// unos ingresos en USD no son la misma serie aunque compartan periodo.
export function hechosDe(nodo, unidadesMax = Infinity) {
  const out = [];
  let i = 0;
  for (const [unit, filas] of Object.entries(nodo?.units || {})) {
    if (++i > unidadesMax) break;
    for (const f of filas || []) {
      out.push({
        unit,
        start: f.start || null,
        end: f.end || null,
        val: f.val,
        fy: f.fy ?? null,
        fp: f.fp ?? null,
        form: f.form ?? null,
        filed: f.filed ?? null,
        accn: f.accn || null,
      });
    }
  }
  return out;
}

// Q4 = FY − 9M.
//
// El emparejamiento exige el MISMO `start`: un 9M que arranca en otra fecha
// pertenece a otro año fiscal, y restarlo daría un número plausible y falso.
// Además el 9M elegido es el más reciente presentado HASTA la fecha del 10-K:
// así el Q4 derivado es consistente con lo que la empresa sabía al cerrar el
// año, en vez de mezclar una re-expresión posterior con un anual viejo.
//
// Devuelve hechos derivados con SUS DOS CITAS. Sin las dos, no se derivan.
export function derivarQ4(hechos) {
  const anuales = hechos.filter((h) => h.start && h.end && clasePeriodo(dias(h.start, h.end)) === 'FY');
  const nueveMeses = hechos.filter((h) => h.start && h.end && clasePeriodo(dias(h.start, h.end)) === '9M');
  const out = [];

  for (const fy of anuales) {
    if (!fy.accn || !Number.isFinite(aNumero(fy.val))) continue;
    const candidatos = nueveMeses.filter((m) => (
      m.start === fy.start                      // mismo año fiscal
      && m.unit === fy.unit                     // misma unidad
      && m.accn                                 // citable
      && Number.isFinite(aNumero(m.val))
      && dias(m.end, fy.end) >= 60 && dias(m.end, fy.end) <= 115   // cierra ~un trimestre antes
      && (!fy.filed || !m.filed || m.filed <= fy.filed)            // lo que se sabía al cerrar el año
    ));
    if (!candidatos.length) continue;
    // El más reciente de los que califican.
    candidatos.sort((a, b) => String(a.filed).localeCompare(String(b.filed)));
    const m9 = candidatos[candidatos.length - 1];

    out.push({
      unit: fy.unit,
      start: sumarDias(m9.end, 1),   // el Q4 arranca el día después del 9M
      end: fy.end,
      val: aNumero(fy.val) - aNumero(m9.val),
      fy: fy.fy ?? null,
      fp: 'Q4',
      form: fy.form ?? null,
      filed: fy.filed ?? null,
      accn: fy.accn,
      accnAux: m9.accn,
      derived: true,
    });
  }
  return out;
}

// companyfacts crudo → filas de company_facts.
//
// Descarta, cuenta y devuelve el conteo. Tres motivos, todos declarados:
//   · `sin_accn`  — no se puede citar. La corrida 2 midió 0 en los cuatro
//                   emisores: si aparece uno, es nuestro, no de EDGAR (§10, G7).
//   · `sin_valor` — val ausente o no numérico.
//   · `sin_fecha` — sin `end` o sin `filed` no se ubica en el tiempo.
export function normalizarFacts(companyfacts, { cik, desde = null } = {}) {
  const filas = [];
  const descartados = { sin_accn: 0, sin_valor: 0, sin_fecha: 0 };
  const taxonomias = companyfacts?.facts || {};

  for (const [taxonomy, conceptos] of Object.entries(taxonomias)) {
    for (const [concept, nodo] of Object.entries(conceptos || {})) {
      const mapeo = mapearConcepto(taxonomy, concept);
      const hechos = hechosDe(nodo);
      // Los derivados solo tienen sentido para las familias de duración; en
      // un instante (inventario, caja) no hay nada que restar.
      const conDerivados = mapeo && mapeo.tipo === 'instante'
        ? hechos
        : [...hechos, ...derivarQ4(hechos)];

      for (const h of conDerivados) {
        if (!h.end || !h.filed) { descartados.sin_fecha++; continue; }
        if (desde && h.end < desde) continue;
        if (!h.accn) { descartados.sin_accn++; continue; }
        const val = aNumero(h.val);
        if (!Number.isFinite(val)) { descartados.sin_valor++; continue; }

        const clase = h.start ? clasePeriodo(dias(h.start, h.end)) : 'INSTANT';
        filas.push({
          cik,
          taxonomy,
          concept,
          familia: mapeo ? mapeo.familia : null,
          familia_rango: mapeo ? mapeo.rango : null,
          unit: h.unit,
          period_start: h.start,
          period_end: h.end,
          period_class: clase,
          fy: h.fy,
          fp: h.fp,
          form: h.form,
          filed: h.filed,
          accession: h.accn,
          accession_aux: h.accnAux || null,
          val,
          derived: Boolean(h.derived),
        });
      }
    }
  }
  return { filas, descartados };
}

// ─────────────────────────────────────────────────────────────────────────
// La orquestación
// ─────────────────────────────────────────────────────────────────────────

// Ingiere un emisor entero. Devuelve el resumen de lo que hizo — no imprime,
// no decide reintentos: eso es del job que lo llama.
export async function ingerirEmisor(cli, repo, { cik, ticker = null, nombre = null }, opciones = {}) {
  const hoy = opciones.hoy || hoyISO();
  const desdeFilings = opciones.desdeFilings || restarAnios(hoy, ANIOS_FILINGS);
  const desdeFacts = opciones.desdeFacts || restarAnios(hoy, ANIOS_FACTS);
  const cikPad = pad10(cik);

  const t0 = Date.now();
  const sub = await bajarSubmissionsCompleto(cli, cikPad, { desde: desdeFilings });
  const crudas = aplanarSubmissions(sub);
  const perfil = perfilDe(crudas.filter((f) => f.filed >= desdeFilings));

  // El emisor se guarda ANTES que los filings: company_filing_items tiene una
  // FK a company_filings, y el perfil es lo que la página necesita para poder
  // decir "cobertura parcial" aunque la serie venga vacía.
  await repo.guardarEmisor({
    cik: cikPad,
    ticker,
    nombre: nombre || sub.principal?.name || null,
    formaAnual: perfil.formaAnual,
    cobertura: perfil.cobertura,
    sic: sub.principal?.sic || null,
    estado: 'ingiriendo',
  });

  const filings = filingsParaGuardar(cikPad, crudas, { desde: desdeFilings });
  await repo.guardarFilings(filings);

  // Los items solo de las formas que los usan. Un 10-Q no trae items y pedir
  // su lista sería una transacción por nada.
  let itemsGuardados = 0;
  for (const f of filings) {
    if (!f.items_raw) continue;
    const items = itemsDe(f.items_raw);
    if (!items.length) continue;
    itemsGuardados += await repo.guardarItems(cikPad, f.accession, items);
  }

  const { facts } = await bajarCompanyFacts(cli, cikPad);
  const { filas, descartados } = normalizarFacts(facts, { cik: cikPad, desde: desdeFacts });
  await repo.guardarFacts(filas);

  return {
    cik: cikPad,
    ticker,
    nombre: sub.principal?.name || nombre || null,
    perfil,
    filings: filings.length,
    paginasIndice: sub.paginas.length,
    indiceTruncado: sub.truncado,
    items: itemsGuardados,
    hechos: filas.length,
    derivados: filas.filter((f) => f.derived).length,
    descartados,
    // El que importa vigilar: la corrida 2 midió 0 en los cuatro emisores.
    sinCita: descartados.sin_accn,
    ms: Date.now() - t0,
  };
}

// Resuelve tickers a CIK y los siembra en el ledger. Es lo que convierte una
// lista de tickers en un universo ingerible por goteo.
export async function sembrarUniverso(cli, repo, tickers) {
  const { map } = await bajarTickerMap(cli);
  const sembrados = [];
  const desconocidos = [];
  for (const t of tickers.map((x) => String(x).toUpperCase())) {
    const hit = map[t];
    if (!hit) { desconocidos.push(t); continue; }
    await repo.guardarEmisor({ cik: hit.cikPad, ticker: t, nombre: hit.nombre, estado: 'pendiente' });
    sembrados.push({ ticker: t, cik: hit.cikPad });
  }
  // Un ticker que no está en EDGAR no es un error del sistema: es un ADR sin
  // registro o un símbolo con sufijo. Se devuelve y se dice, no se traga.
  return { sembrados, desconocidos };
}

// Un turno del goteo. `limite` sale de G4: 42 s por ticker y 300 s de lambda.
export async function correrGoteo(cli, repo, { limite = 7, masViejoQue = null, hoy = null } = {}) {
  await repo.asegurarEsquema();
  const pendientes = await repo.pendientes(limite, { masViejoQue });
  const resultados = [];

  for (const p of pendientes) {
    try {
      const r = await ingerirEmisor(cli, repo, { cik: p.cik, ticker: p.ticker, nombre: p.nombre }, { hoy });
      await repo.marcarIngesta(p.cik, { estado: 'ok' });
      resultados.push({ ...r, estado: 'ok' });
    } catch (e) {
      // Un emisor que falla no tumba el turno: se anota con su error en la
      // misma tabla donde se elige a quién ingerir, y el goteo sigue.
      await repo.marcarIngesta(p.cik, { estado: 'error', error: String(e && e.message ? e.message : e).slice(0, 500) });
      resultados.push({ cik: p.cik, ticker: p.ticker, estado: 'error', error: String(e && e.message ? e.message : e) });
    }
  }

  return {
    intentados: resultados.length,
    ok: resultados.filter((r) => r.estado === 'ok').length,
    errores: resultados.filter((r) => r.estado === 'error').length,
    sinCita: resultados.reduce((a, r) => a + (r.sinCita || 0), 0),
    resultados,
  };
}
