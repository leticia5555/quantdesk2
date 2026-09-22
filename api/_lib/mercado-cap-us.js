// ═══════════════════════════════════════════════════════════════════════
// LA CAPITALIZACIÓN DE LOS ADR, Y POR QUÉ TSM SALÍA MÁS GRANDE QUE NVDA
//
// El mapa dimensiona por capitalización, así que una cap mal medida no es un
// número feo en una tabla: es un cuadro que MIENTE DE TAMAÑO, y miente en la
// dirección que más se nota — el nombre más grande de la pantalla.
//
// De dónde salía. `/api/mercado-r0` guarda `metric.marketCapitalization × 1e6`
// y la trata como USD. Para una emisora estadounidense eso está bien. Para un
// ADR **no tiene por qué estarlo**: Finnhub reporta la cap en la moneda de
// reporte de la empresa, y `profile2` trae ese dato en `currency` — un campo
// que la cosecha PEDÍA Y TIRABA, porque sólo se quedaba con `name` e
// `industria`. Por eso ninguna prueba podía atraparlo: el dato que delataba el
// error nunca entró al sistema.
//
// Cómo se decide acá. NO se elige una fuente y se le cree. Se calculan dos
// estimaciones INDEPENDIENTES de la cap en USD y se exige que concuerden:
//
//   (a) la declarada  — `marketCapitalization × 1e6`, válida sólo si la
//       moneda de reporte es USD;
//   (b) la reconstruida — `shareOutstanding × 1e6 × último cierre en USD`,
//       con el precio que ya tenemos en `mercado_precios_us`.
//
// Si difieren más del umbral (5%, el mismo congelado de G2), la emisora sale
// **gris punteada**: se pinta sin tamaño y dice por qué, exactamente como
// LASITE en México. Nunca un tamaño inventado, nunca una conversión de moneda
// a ojo.
//
// Esto atrapa el caso por CONSTRUCCIÓN y no por adivinanza: da igual si el
// desajuste viene de la moneda (TWD leído como USD), del ratio del ADR (1 ADR
// = N ordinarias) o de que la cap esté en unidades y no en millones. Las tres
// rompen la concordancia, y el `multiplo` que se reporta dice de un vistazo
// cuál fue: ~32× huele a tipo de cambio, ~5× a ratio de ADR, ~1e6 a unidades.
// ═══════════════════════════════════════════════════════════════════════
import { CRITERIOS, errorPct } from './mercado-fase0.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Finnhub da cap y acciones en MILLONES. Un sitio, una vez. */
export const MILLON = 1e6;

/**
 * Las dos estimaciones de cap en USD para un símbolo.
 *
 * `moneda` es `profile2.currency`. Cuando NO se conoce se trata como
 * desconocida y no como USD: suponer USD es justo la suposición que rompió
 * TSM, y el contrato dice fallar cerrado.
 */
export function candidatasCapUs({ declarada, moneda, acciones, precio_usd }) {
  const cand = [];
  const dec = num(declarada);
  const acc = num(acciones);
  const px = num(precio_usd);
  const mon = moneda ? String(moneda).toUpperCase() : null;

  if (dec != null && dec > 0) {
    cand.push({
      serie: 'finnhub:metric',
      cap: dec * MILLON,
      // La declarada sólo es USD si alguien lo dijo. `null` no es USD.
      usd: mon === 'USD',
      moneda: mon,
    });
  }
  if (acc != null && acc > 0 && px != null && px > 0) {
    cand.push({ serie: 'acciones×precio', cap: acc * MILLON * px, usd: true, moneda: 'USD' });
  }
  return cand;
}

/**
 * Veredicto por símbolo, con la misma forma y el mismo umbral que
 * `veredictoCapMx`. Devolver la MISMA forma no es cosmética: el mapa ya sabe
 * pintar `gris_punteado` con su motivo, y un segundo vocabulario para el
 * mismo concepto es cómo se terminan teniendo dos opiniones sobre qué está
 * verificado — el bug que #241 y #245 ya costaron.
 */
export function veredictoCapUs(entrada, umbral = CRITERIOS.g2_max_error_pct) {
  const { symbol, moneda } = entrada || {};
  const cand = candidatasCapUs(entrada || {});
  const decl = cand.find((c) => c.serie === 'finnhub:metric');
  const recon = cand.find((c) => c.serie === 'acciones×precio');
  const base = { symbol, moneda: moneda ? String(moneda).toUpperCase() : null };

  // Sin reconstrucción no hay con qué contrastar. Una sola fuente no se
  // "verifica" a sí misma; a lo sumo se le cree, y creerle es lo que falló.
  if (!recon) {
    return {
      ...base, estado: 'gris_punteado', cap_usd: null, error_pct: null, multiplo: null,
      motivo: !decl ? 'sin capitalización de ninguna fuente'
        : 'no se puede reconstruir la cap (faltan acciones en circulación o precio en USD)',
    };
  }

  // Sin declarada, la reconstruida queda sola: mismo argumento.
  if (!decl) {
    return {
      ...base, estado: 'gris_punteado', cap_usd: null, error_pct: null, multiplo: null,
      motivo: 'sólo hay acciones×precio, sin una segunda fuente que la confirme',
    };
  }

  const e = errorPct(decl.cap, recon.cap);
  const multiplo = recon.cap ? decl.cap / recon.cap : null;

  // La moneda manda ANTES que el error. Una cap en TWD puede coincidir por
  // casualidad con la reconstruida de otra emisora; lo que la descalifica no
  // es el número, es no saber en qué unidad está.
  if (!decl.usd) {
    return {
      ...base, estado: 'gris_punteado', cap_usd: null, error_pct: e, multiplo,
      motivo: decl.moneda
        ? `la cap declarada viene en ${decl.moneda}, no en USD`
        : 'no se sabe en qué moneda viene la cap declarada',
    };
  }

  if (e == null) {
    return { ...base, estado: 'gris_punteado', cap_usd: null, error_pct: null, multiplo, motivo: 'las dos fuentes no son comparables' };
  }

  const ok = Math.abs(e) <= umbral;
  return {
    ...base,
    estado: ok ? 'verificada' : 'gris_punteado',
    // La cap que viaja es la DECLARADA, no un promedio: promediar dos fuentes
    // que discrepan fabrica un número que ninguna midió.
    cap_usd: ok ? decl.cap : null,
    error_pct: e,
    multiplo,
    motivo: ok ? null
      : `la cap declarada difiere ${e.toFixed(1)}% de acciones×precio (${multiplo.toFixed(2)}×), techo ${umbral}%`,
  };
}

/**
 * La auditoría entera. Devuelve el conteo que hay que reportar y la lista de
 * los que fallan, ordenada por cuánto mienten.
 */
export function auditaCapUs(filas = [], umbral = CRITERIOS.g2_max_error_pct) {
  const veredictos = filas.map((f) => veredictoCapUs(f, umbral));
  const grises = veredictos.filter((v) => v.estado === 'gris_punteado');
  const porMoneda = {};
  for (const v of veredictos) {
    const k = v.moneda || 'desconocida';
    porMoneda[k] = (porMoneda[k] || 0) + 1;
  }
  return {
    total: veredictos.length,
    verificadas: veredictos.length - grises.length,
    gris_punteado: grises.length,
    no_usd: veredictos.filter((v) => v.moneda && v.moneda !== 'USD').length,
    por_moneda: porMoneda,
    umbral_pct: umbral,
    // Los peores primero: el que más miente de tamaño es el que más se ve.
    peores: grises
      .slice()
      .sort((a, b) => Math.abs(b.error_pct ?? 0) - Math.abs(a.error_pct ?? 0))
      .slice(0, 50),
    veredictos,
  };
}
