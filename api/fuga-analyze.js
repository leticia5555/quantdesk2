// ═══════════════════════════════════════════════════════════════════
// /api/fuga-analyze — "FUGA PRE-EARNINGS", backtest pre-registrado, SOLO LECTURA.
//
// ¿Un run-up de ≥6% sobre SPY en las 5 sesiones previas al reporte predice la
// reacción al reporte? Los umbrales están CONGELADOS en _lib/fuga-analyze.js
// (CRITERIOS_FUGA) — se fijaron antes de correr y no se mueven. Ver
// docs/fuga-backtest-scope.md.
//
//   GET /api/fuga-analyze                    → JSON completo
//   GET /api/fuga-analyze?format=md          → resumen en español
//   GET /api/fuga-analyze?solo=cobertura     → SOLO la cobertura (paso 1:
//                                              revisarla antes de leer resultados)
//   GET /api/fuga-analyze?obs=1              → incluye el detalle evento a evento
//   GET /api/fuga-analyze?anios=3            → ventana de análisis (default 3)
//
// ── SOLO LECTURA ───────────────────────────────────────────────────
// Un SELECT sobre pead_earnings + pead_event_hour. Ni ensurePeadSchema() ni
// heartbeat. Precios en vivo de Yahoo (_lib/yahoo-daily.js), no se guardan.
// tests/fuga-analyze.test.mjs intercepta toda query y falla si alguna no es
// SELECT.
//
// ── Gate ───────────────────────────────────────────────────────────
// Igual que /api/pead-analyze: con CRON_SECRET puesta, sin el secret (header
// `Authorization: Bearer ...` o `?secret=`) → 401. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { recortaVelasIncompletas, alineaAlCalendario } from './_lib/pead-analyze.js';
import { CRITERIOS_FUGA, corre, renderResumenMarkdown, TIENE_HORA } from './_lib/fuga-analyze.js';
import { bajaSeries } from './_lib/yahoo-daily.js';

// ~100 símbolos de Yahoo + principal + 7 sensibilidades/exploratorios.
export const maxDuration = 300;

const BENCHMARK = 'SPY';

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

  const format = String(q.format || 'json').toLowerCase();
  const anios = Math.max(1, Math.min(10, Number(q.anios) || CRITERIOS_FUGA.anios_ventana));
  const soloCobertura = String(q.solo || '') === 'cobertura';
  const conObs = String(q.obs || '') === '1';
  const range = anios <= 4 ? '5y' : '10y';

  try {
    // ── 1. Eventos desde Neon. UN SOLO SELECT. ──
    // +1 año de colchón: los reportes previos a la ventana también vedan
    // sesiones del placebo, y la formación necesita velas anteriores.
    const eventos = await sql(
      `select e.symbol, to_char(e.reported_date, 'YYYY-MM-DD') as reported_date,
              h.hour, h.source as hour_source
         from pead_earnings e
         left join pead_event_hour h
           on h.symbol = e.symbol and h.reported_date = e.reported_date
        where e.reported_date >= (current_date - ($1 || ' years')::interval)
          and e.reported_date <= current_date
        order by e.reported_date asc, e.symbol asc`,
      [String(anios + 1)]
    );
    if (!eventos.length) {
      return res.status(200).json({ error: 'pead_earnings vacío en la ventana pedida — corre primero la cosecha del PEAD.', solo_lectura: true, anios });
    }
    const simbolos = [...new Set(eventos.map((e) => e.symbol))];

    // ── 2. Precios: Yahoo en vivo. Calendario canónico = SPY. ──
    const crudas = await bajaSeries([BENCHMARK, ...simbolos], range);
    const spy = crudas[BENCHMARK] ? recortaVelasIncompletas(crudas[BENCHMARK]) : null;
    if (!spy) return res.status(502).json({ error: `Sin serie de ${BENCHMARK}: no hay benchmark, no hay análisis.` });
    const calendario = spy.fechas;
    const spyCloses = alineaAlCalendario(spy, calendario).closes;
    const seriesAlineadas = {};
    const sinPrecios = [];
    for (const s of simbolos) {
      if (!crudas[s]) { sinPrecios.push(s); continue; }
      seriesAlineadas[s] = alineaAlCalendario(recortaVelasIncompletas(crudas[s]), calendario);
    }

    const hasta = calendario[calendario.length - 1];
    const desdeD = new Date(hasta + 'T00:00:00Z');
    desdeD.setUTCFullYear(desdeD.getUTCFullYear() - anios);
    const desde = desdeD.toISOString().slice(0, 10);
    const enVentana = eventos.filter((e) => e.reported_date >= desde);
    const h = (e) => (e.hour || '').toLowerCase();
    const base = { eventos, calendario, seriesAlineadas, spyCloses, desde, criterios: CRITERIOS_FUGA };

    // ── 3. ESPECIFICACIÓN PRINCIPAL (la única que decide) ──
    const principal = corre({ ...base, politicaHora: 'amc' });

    const datos = {
      eventos_en_tabla: eventos.length,
      simbolos: simbolos.length,
      sin_precios: sinPrecios,
      calendario: { sesiones: calendario.length, desde: calendario[0], hasta },
      ventana_analisis: { desde, hasta },
      en_ventana: enVentana.length,
      con_hora: enVentana.filter((e) => TIENE_HORA(e.hour)).length,
      sin_hora: enVentana.filter((e) => !TIENE_HORA(e.hour)).length,
      pct_con_hora: enVentana.length ? enVentana.filter((e) => TIENE_HORA(e.hour)).length / enVentana.length : null,
      por_hora: {
        bmo: enVentana.filter((e) => h(e) === 'bmo').length,
        amc: enVentana.filter((e) => h(e) === 'amc').length,
        dmh: enVentana.filter((e) => h(e) === 'dmh').length,
      },
    };

    const salida = {
      pregunta: '¿El exceso de retorno pre-anuncio (≥ +6% vs SPY en 5 sesiones) predice la reacción al anuncio?',
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      solo_cobertura: soloCobertura,
      criterios: CRITERIOS_FUGA,
      datos,
      principal,
      veredicto: soloCobertura ? null : principal.veredicto,
      sensibilidades: [],
      exploratorio: [],
    };

    if (!soloCobertura) {
      // ── 4. Sensibilidades pre-registradas: se reportan, NO deciden ──
      const C = CRITERIOS_FUGA;
      const ef = (o) => o.hora_efectiva;
      salida.sensibilidades = [
        { nombre: `Formación ${C.sens_ventana_formacion} sesiones (excess_${C.sens_ventana_formacion} ≥ +6%)`, resultado: corre({ ...base, k: C.sens_ventana_formacion }) },
        ...C.sens_umbrales.map((u) => ({ nombre: `Umbral ${u * 100}% (solo forma, no se elige)`, resultado: corre({ ...base, umbral: u }) })),
        { nombre: 'Split: solo BMO (incluye DMH)', resultado: corre({ ...base, filtroSenal: (o) => ef(o) === 'bmo' }) },
        { nombre: 'Split: solo AMC (incluye sin hora imputados)', resultado: corre({ ...base, filtroSenal: (o) => ef(o) === 'amc' }) },
        { nombre: 'Eventos sin hora: descartados', resultado: corre({ ...base, politicaHora: 'drop' }) },
        { nombre: `Tenencia ${C.sens_tenencia} sesiones post-anuncio`, resultado: corre({ ...base, tenencia: C.sens_tenencia }) },
      ];
      // ── 5. EXPLORATORIO etiquetado ──
      salida.exploratorio = [{
        nombre: 'sin hora → BMO (D = E−1)',
        por_que: 'en este diseño imputar AMC puede meter look-ahead si el reporte fue BMO; imputar BMO nunca lo mete (a lo sumo pierde la reacción).',
        resultado: corre({ ...base, politicaHora: 'bmo' }),
      }];
    }

    // El detalle por evento solo con ?obs=1 (engorda la respuesta).
    for (const r of [principal, ...salida.sensibilidades.map((x) => x.resultado), ...salida.exploratorio.map((x) => x.resultado)]) {
      if (!conObs) delete r._obs;
    }
    if (soloCobertura) { delete principal.grupos; delete principal.diferencias; delete principal.cumple; delete principal.veredicto; delete principal.hallazgo_reversion; }

    res.setHeader('Cache-Control', 'no-store');
    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'fuga-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
