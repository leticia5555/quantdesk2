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
import { veredictoCapEdgar } from './mercado-edgar.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Finnhub da cap y acciones en MILLONES. Un sitio, una vez. */
export const MILLON = 1e6;

// ── LA RAZÓN DEL ADR ───────────────────────────────────────────────────
// Un ADR de TSM no es una acción de TSM: son varias. Finnhub cuenta ORDINARIAS
// y nosotros cosechamos el precio del ADR, así que `acciones × precio` sale
// multiplicado por la razón — encima de estar la cap en otra moneda.
//
// La referencia manual de Yahoo NO se pinta (regla del archivo de referencias,
// la misma de México). Sirve para despejar la razón UNA vez:
//
//     razón_cruda = (acciones × precio) ÷ cap_referencia
//
// y lo que se dibuja es `acciones ÷ razón_redondeada × precio`, con nuestro
// cierre de cada día. Si se usara la razón cruda, el resultado sería idéntico
// a la cap de Yahoo: pintar la referencia con otro nombre, y clavada en la
// fecha de captura para siempre.
export const TOLERANCIA_RAZON_PCT = 2;

/** Las proporciones que un ADR puede tener de verdad: N ordinarias por ADR, o 1/N. */
export function razonesPlausibles(max = 20) {
  const out = [];
  for (let n = 1; n <= max; n++) out.push(n);
  for (let n = 2; n <= max; n++) out.push(1 / n);
  return out;
}

/**
 * La razón que explica el desajuste, o nada.
 *
 * Fallar cerrado es el punto: si la razón cruda no se parece a ninguna
 * proporción plausible, NO se fuerza la más cercana. Que no se parezca
 * significa que lo que está mal es otra cosa —la captura quedó vieja, las
 * acciones son de otra clase— y darle un tamaño igual sería exactamente el
 * bug que esto vino a cerrar.
 */
export function razonAdr({ cap_referencia_usd, acciones_millones, precio_usd, tolerancia = TOLERANCIA_RAZON_PCT }) {
  const ref = num(cap_referencia_usd);
  const acc = num(acciones_millones);
  const px = num(precio_usd);
  if (ref == null || ref <= 0) return { ok: false, motivo: 'la referencia manual no trae una cap en USD utilizable' };
  if (acc == null || acc <= 0 || px == null || px <= 0) {
    return { ok: false, motivo: 'faltan acciones en circulación o cierre para despejar la razón del ADR' };
  }

  const crudo = (acc * MILLON * px) / ref;
  let razon = null, mejor = Infinity;
  for (const cand of razonesPlausibles()) {
    const err = Math.abs(errorPct(crudo, cand) ?? Infinity);
    if (err < mejor) { mejor = err; razon = cand; }
  }
  const ok = mejor <= tolerancia;
  return {
    ok, crudo, razon: ok ? razon : null, razon_cercana: razon, error_pct: mejor,
    etiqueta: ok ? (razon >= 1 ? `${razon}:1` : `1:${Math.round(1 / razon)}`) : null,
    motivo: ok ? null
      : `la razón cruda ${crudo.toFixed(3)} no se parece a ninguna proporción de ADR (la más cercana, ${razon}, queda a ${mejor.toFixed(1)}%, techo ${tolerancia}%)`,
  };
}

// ── LA VIGENCIA NO APAGA NADA ──────────────────────────────────────────
// Primera versión de esto: al vencer la referencia, el cuadro se iba a gris. Es
// la misma trampa que los 14 días de #248 — un reloj que apaga datos buenos
// solo. Y acá es peor, porque LA RAZÓN DEL ADR ES ESTRUCTURAL: que 1 ADR de TSM
// equivalga a N ordinarias no cambia porque pase un trimestre. Lo que envejece
// es la CAP de Yahoo, y la cap de Yahoo no se pinta.
//
// Así que vencer significa una sola cosa: hay que recapturar para volver a
// CONFIRMAR la razón. El mapa sigue dibujando con la razón vigente y la tarea
// aparece en `referencias_a_recapturar` de /api/cron-status, donde se ve venir.
//
// Lo único que SÍ pone gris el cuadro es que la razón cruda deje de parecerse a
// una proporción plausible: ahí cambió algo de verdad —un split del ADR, un
// cambio de ratio, una captura mal leída— y el tamaño deja de estar sostenido.
export function referenciaVigente(ref, hoy = new Date()) {
  if (!ref) return { hay: false };
  const hasta = ref.vigente_hasta ? String(ref.vigente_hasta) : null;
  const dia = hoy instanceof Date ? hoy.toISOString().slice(0, 10) : String(hoy).slice(0, 10);
  if (!hasta) {
    return { hay: true, vigente: false, sin_fecha: true, a_recapturar: true, vigente_hasta: null,
      motivo: 'la referencia manual no declara hasta cuándo vale: recapturala para ponerle fecha' };
  }
  const vigente = dia <= hasta;
  return {
    hay: true, vigente, a_recapturar: !vigente, vigente_hasta: hasta,
    motivo: vigente ? null
      : `la referencia venció el ${hasta}: recapturá la cap en Yahoo para reconfirmar la razón (el cuadro sigue dibujándose con ella)`,
  };
}

/**
 * Qué hay que recapturar, para /api/cron-status.
 *
 * NO lleva `alerta`: una referencia vencida ya no rompe nada, así que no puede
 * poner en rojo el tablero. Es una tarea pendiente, y confundir una tarea con
 * una falla es cómo se aprende a ignorar el rojo.
 */
export function vigenciaReferenciasUs(registro, hoy = new Date()) {
  const filas = (registro && registro.referencias) || [];
  const estado = filas.map((r) => {
    const v = referenciaVigente(r, hoy);
    return {
      clave: String(r.clave || '').toUpperCase(),
      vigente_hasta: v.vigente_hasta,
      vigente: v.vigente === true,
      fuente: r.fuente || null,
      capturada_en: r.capturada_en || null,
    };
  });
  return {
    filas: filas.length,
    vigentes: estado.filter((e) => e.vigente).length,
    a_recapturar: estado.filter((e) => !e.vigente).map((e) => ({ ...e, mapa: 'us', motivo: 'reconfirmar la razón del ADR' })),
    detalle: estado,
    alerta: false,
    lectura: 'vencer no apaga el cuadro: la razón del ADR es estructural y se sigue usando. Recapturar sólo la reconfirma.',
  };
}

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
  const { symbol, moneda, referencia, edgar, hoy } = entrada || {};
  const cand = candidatasCapUs(entrada || {});
  const decl = cand.find((c) => c.serie === 'finnhub:metric');
  const recon = cand.find((c) => c.serie === 'acciones×precio');
  // `auditable` separa DOS grises que se ven igual y se arreglan distinto:
  //   false → faltan insumos (la cosecha no repobló moneda/acciones todavía).
  //           Se arregla corriendo ?job=universo.
  //   true  → hubo con qué comparar y NO cuadró. Es un hallazgo de verdad.
  // Sin esta distinción, el día que se despliegue esto el mapa sale entero
  // gris y la pantalla dice "553 sin capitalización verificada", que manda a
  // buscar 553 bugs donde lo que falta es una corrida.
  const base = { symbol, moneda: moneda ? String(moneda).toUpperCase() : null };

  // ── PRIMERO, LA REFERENCIA MANUAL ────────────────────────────────────
  // Para los cuatro ADR de la auditoría (TSM, NVO, VALE, ASML) ni la moneda
  // ni las unidades de `shareOutstanding` sirven, así que el contraste normal
  // no puede decir nada útil. La referencia de Yahoo despeja la razón y el
  // tamaño vuelve a ser NUESTRO cálculo con NUESTRO cierre.
  if (referencia) {
    const vig = referenciaVigente(referencia, hoy || new Date());
    const r = razonAdr({
      cap_referencia_usd: referencia.market_cap_usd,
      acciones_millones: entrada.acciones,
      precio_usd: entrada.precio_usd,
    });
    if (r.ok) {
      return {
        ...base, estado: 'verificada', auditable: true,
        cap_usd: (num(entrada.acciones) * MILLON * num(entrada.precio_usd)) / r.razon,
        error_pct: r.error_pct, multiplo: null,
        via: 'referencia_manual', razon_adr: r.razon, razon_etiqueta: r.etiqueta,
        fuente: `calc: acciones÷${r.etiqueta}×neon`,
        referencia_fuente: referencia.fuente || null,
        referencia_capturada_en: referencia.capturada_en || null,
        // Vencida NO es gris: es una tarea. El cuadro se sigue dibujando con la
        // razón y esto es lo que la hace aparecer en cron-status.
        referencia_a_recapturar: vig.a_recapturar === true,
        referencia_vigente_hasta: vig.vigente_hasta,
        motivo: null,
      };
    }
    return {
      ...base, estado: 'gris_punteado', auditable: true, cap_usd: null,
      error_pct: r.error_pct ?? null, multiplo: r.crudo ?? null,
      via: 'referencia_manual', motivo: r.motivo,
    };
  }

  // Sin reconstrucción no hay con qué contrastar. Una sola fuente no se
  // "verifica" a sí misma; a lo sumo se le cree, y creerle es lo que falló.
  if (!recon) {
    return {
      ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo: null,
      motivo: !decl ? 'sin capitalización de ninguna fuente'
        : 'no se puede reconstruir la cap (faltan acciones en circulación o precio en USD)',
    };
  }

  // Sin declarada, la reconstruida queda sola: mismo argumento.
  if (!decl) {
    return {
      ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo: null,
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
      ...base, estado: 'gris_punteado',
      // Saber que viene en TWD es un HALLAZGO; no saber en qué moneda viene
      // es un insumo que falta. No son el mismo gris.
      auditable: !!decl.moneda,
      cap_usd: null, error_pct: e, multiplo,
      motivo: decl.moneda
        ? `la cap declarada viene en ${decl.moneda}, no en USD`
        : 'no se sabe en qué moneda viene la cap declarada',
    };
  }

  if (e == null) {
    return { ...base, estado: 'gris_punteado', auditable: false, cap_usd: null, error_pct: null, multiplo, motivo: 'las dos fuentes no son comparables' };
  }

  const ok = Math.abs(e) <= umbral;
  if (ok) {
    return {
      ...base, estado: 'verificada', auditable: true,
      // La cap que viaja es la DECLARADA, no un promedio: promediar dos fuentes
      // que discrepan fabrica un número que ninguna midió.
      cap_usd: decl.cap, error_pct: e, multiplo, via: 'finnhub', motivo: null,
    };
  }

  // ── SEGUNDA OPORTUNIDAD: EDGAR ───────────────────────────────────────
  // Que las dos de Finnhub no cuadren NO dice cuál está mal. En las 21 de la
  // auditoría el patrón apunta al conteo de acciones (tres pegadas a 2× =
  // split no reflejado), así que se le pregunta a quien firma la portada. Sólo
  // acá: si el par de Finnhub ya concordaba, no se toca nada — las 279
  // verificadas siguen verificadas por donde venían.
  if (edgar && num(edgar.acciones) != null) {
    const ve = veredictoCapEdgar({
      symbol, declarada_usd: decl.cap, acciones_edgar: edgar.acciones,
      precio_usd: entrada.precio_usd, fecha_portada: edgar.fecha_portada,
    });
    if (ve.estado === 'verificada') {
      return {
        ...base, ...ve,
        // El desajuste con Finnhub no se borra por haberlo resuelto: queda
        // dicho, porque es lo que explica por qué la fuente dice `edgar`.
        finnhub_error_pct: e, finnhub_multiplo: multiplo,
      };
    }
    return {
      ...base, ...ve,
      finnhub_error_pct: e, finnhub_multiplo: multiplo,
      motivo: `${ve.motivo}; contra Finnhub el desajuste era ${e.toFixed(1)}% (${multiplo.toFixed(2)}×)`,
    };
  }

  return {
    ...base, estado: 'gris_punteado', auditable: true, cap_usd: null,
    error_pct: e, multiplo, via: 'finnhub',
    motivo: `la cap declarada difiere ${e.toFixed(1)}% de acciones×precio (${multiplo.toFixed(2)}×), techo ${umbral}%`
      + (edgar ? '; EDGAR no dio acciones para cruzarlo' : ''),
  };
}

/**
 * La auditoría entera. Devuelve el conteo que hay que reportar y la lista de
 * los que fallan, ordenada por cuánto mienten.
 */
export function auditaCapUs(filas = [], umbral = CRITERIOS.g2_max_error_pct) {
  const veredictos = filas.map((f) => veredictoCapUs(f, umbral));
  const grises = veredictos.filter((v) => v.estado === 'gris_punteado');
  const pendientes = grises.filter((v) => !v.auditable);
  const hallazgos = grises.filter((v) => v.auditable);
  const porMoneda = {};
  for (const v of veredictos) {
    const k = v.moneda || 'desconocida';
    porMoneda[k] = (porMoneda[k] || 0) + 1;
  }
  return {
    total: veredictos.length,
    verificadas: veredictos.length - grises.length,
    gris_punteado: grises.length,
    // Los dos números que NO hay que sumar: uno manda a correr la cosecha,
    // el otro manda a mirar emisoras.
    sin_auditar: pendientes.length,
    hallazgos: hallazgos.length,
    no_usd: veredictos.filter((v) => v.moneda && v.moneda !== 'USD').length,
    por_moneda: porMoneda,
    umbral_pct: umbral,
    // Los peores primero: el que más miente de tamaño es el que más se ve.
    peores: hallazgos
      .slice()
      .sort((a, b) => Math.abs(b.error_pct ?? 0) - Math.abs(a.error_pct ?? 0))
      .slice(0, 50),
    veredictos,
  };
}
