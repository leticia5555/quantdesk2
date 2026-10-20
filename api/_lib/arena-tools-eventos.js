// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-tools-eventos.js — la QUINTA herramienta: eventos(ticker).
//
// Los 8-K recientes de un nombre, desde EDGAR. SOLO el item y una línea por
// evento — nunca el cuerpo del filing:
//
//   2026-10-15 · 8-K · 2.02 resultados · 7.01 Regulation FD
//   2026-10-02 · 8-K · 5.02 cambio de directivo
//
// ── POR QUÉ SOLO EL ITEM ─────────────────────────────────────────────
// Un 8-K completo son decenas de miles de tokens (anexos, press release,
// tablas). El presupuesto de contexto del loop es de 30K para TODA la
// corrida. Lo que el PM necesita saber es QUE pasó algo y de qué clase; si
// le importa el contenido, `noticias` del mismo ticker trae el titular.
//
// El 9.01 (estados financieros y anexos) se omite de la línea: acompaña a
// casi todos los 8-K y no dice nada por sí solo. Se DECLARA en la cabecera,
// para que su ausencia no se lea como "no hubo anexos".
//
// ── EL CERO Y LA FALLA SON DOS COSAS ─────────────────────────────────
//   · "Sin 8-K en N días"           → se consultó EDGAR y no hay. rows: 0.
//   · "eventos: sin datos hoy"      → EDGAR no contestó. error: true.
// La segunda NO se cachea (el ejecutor no cachea errores) y la publica
// `avisos` de /api/liga/libros. Una falla que se lee como "no hubo eventos"
// es exactamente lo que la tarea 6 existe para evitar.
//
// ── LA CACHÉ ─────────────────────────────────────────────────────────
// Por día, la del ejecutor (`cacheKey` por contenido de argumentos): dos
// agentes que piden eventos de MU pagan una sola bajada. El mapa
// ticker → CIK (~1 MB) se memoriza además en el proceso, por día de mercado,
// para no bajarlo en cada llamada de una misma lambda caliente.
//
// Fuente: data.sec.gov/submissions/CIK##########.json, `filings.recent`
// (forma, fecha, items). Usa el cliente de _lib/edgar.js, que respeta el UA
// y el techo de tasa de la SEC.
// ═══════════════════════════════════════════════════════════════

import { crearCliente, bajarTickerMap, urlSubmissions } from './edgar.js';
import { glosarItem } from './historia-glosario.js';

// Las cuatro que Lety nombró, con SU redacción. El resto sale del glosario
// de HISTORIA (la glosa corta en español, marcada como nuestra allá).
export const ETIQUETA_ITEM = {
  '2.02': 'resultados',
  '1.01': 'acuerdo material',
  '5.02': 'cambio de directivo',
  '8.01': 'otros eventos',
};
export const ITEM_OMITIDO = '9.01';
export const DIAS_DEFAULT = 14;
export const DIAS_MAX = 60;
export const MAX_EVENTOS = 15;

export function etiquetaItem(codigo) {
  const c = String(codigo || '').trim();
  if (ETIQUETA_ITEM[c]) return ETIQUETA_ITEM[c];
  const g = glosarItem(c, 'es');
  return (g && g.glosa) ? g.glosa : `item ${c}`;
}

// submissions.json → las líneas de 8-K dentro de la ventana. PURA: se prueba
// con un JSON de mentira, sin red.
export function eventosDeSubmissions(sub, { desde, max = MAX_EVENTOS } = {}) {
  const r = sub && sub.filings && sub.filings.recent;
  if (!r || !Array.isArray(r.form)) return { eventos: [], revisados: 0, total: 0 };
  const eventos = [];
  let total = 0;
  for (let i = 0; i < r.form.length; i++) {
    const forma = String(r.form[i] || '');
    if (forma !== '8-K' && forma !== '8-K/A') continue;
    const fecha = String((r.filingDate || [])[i] || '');
    if (desde && fecha < desde) continue;
    total++;
    if (eventos.length >= max) continue;
    const items = String((r.items || [])[i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const utiles = items.filter((c) => c !== ITEM_OMITIDO);
    eventos.push({
      fecha, forma,
      items: utiles,
      linea: `${fecha} · ${forma} · ${utiles.length
        ? utiles.map((c) => `${c} ${etiquetaItem(c)}`).join(' · ')
        : (items.length ? 'solo anexos (9.01)' : 'sin items declarados')}`,
    });
  }
  // EDGAR ya los da del más nuevo al más viejo; se ordena igual por si acaso.
  eventos.sort((a, b) => b.fecha.localeCompare(a.fecha));
  return { eventos, revisados: r.form.length, total };
}

// ── EL MAPA TICKER → CIK, memorizado por día en el proceso ───────────
let memoMapa = { dia: null, promesa: null };
export function _resetMemoMapa() { memoMapa = { dia: null, promesa: null }; }

function clienteDeLaHerramienta(deps) {
  // Corto y con UN reintento: esto corre dentro del reloj del loop del agente.
  // Los 30s del cliente de la ingesta de HISTORIA se comerían una vuelta.
  return deps.edgarCliente || crearCliente({ timeoutMs: 8000, reintentos: 1 });
}

async function mapaDeTickers(deps, dia) {
  if (deps.tickerMap) return deps.tickerMap();
  if (memoMapa.dia !== dia || !memoMapa.promesa) {
    const cli = clienteDeLaHerramienta(deps);
    memoMapa = { dia, promesa: bajarTickerMap(cli).then((x) => x.map) };
    // Un fallo no se memoriza: la próxima llamada vuelve a intentar.
    memoMapa.promesa.catch(() => { memoMapa = { dia: null, promesa: null }; });
  }
  return memoMapa.promesa;
}

export async function runEventos(args, ctx) {
  const tk = String(args.ticker || '').trim().toUpperCase();
  if (!tk) return { text: 'eventos necesita un ticker.', rows: 0, error: true };
  const deps = (ctx && ctx.deps) || {};
  const now = (ctx && ctx.now) || new Date();
  const dias = args.days || DIAS_DEFAULT;
  const desde = new Date(now.getTime() - dias * 86400000).toISOString().slice(0, 10);
  const dia = now.toISOString().slice(0, 10);

  let sub;
  try {
    const mapa = await mapaDeTickers(deps, dia);
    // EDGAR escribe las clases con guion (BRK-B); el universo, con punto.
    const fila = mapa[tk] || mapa[tk.replace(/\./g, '-')] || null;
    if (!fila) {
      return {
        text: `eventos: ${tk} no está en el padrón de tickers de EDGAR (puede ser un ETF o un emisor que no presenta 8-K). No significa que no haya noticias: no hay 8-K que consultar.`,
        rows: 0, sin_cik: true,
      };
    }
    sub = deps.submissions
      ? await deps.submissions(fila.cik)
      : (await clienteDeLaHerramienta(deps).json(urlSubmissions(fila.cik), { kind: 'submissions' })).json;
  } catch (e) {
    return {
      text: `eventos: sin datos hoy — EDGAR no respondió (${String((e && e.message) || e).slice(0, 160)}). NO significa que ${tk} no haya presentado 8-K: no se pudo consultar.`,
      rows: null, error: true, fallo: 'EDGAR no respondió',
    };
  }

  const { eventos, revisados, total } = eventosDeSubmissions(sub, { desde });
  if (!eventos.length) {
    return {
      text: `Sin 8-K de ${tk} en los últimos ${dias} día(s) (se revisaron los ${revisados} filings más recientes de EDGAR).`,
      rows: 0,
    };
  }
  const header = `${total} 8-K de ${tk}, últimos ${dias} día(s)${total > eventos.length ? ` — se muestran los ${eventos.length} más recientes` : ''}. Solo el item, no el texto del filing. (9.01 anexos se omite.)`;
  return { text: [header, ...eventos.map((e) => e.linea)].join('\n'), rows: eventos.length };
}
