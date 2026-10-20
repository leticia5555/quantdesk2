// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-inventario.js — ¿cuánto del universo de la liga cubre
// HISTORIA, y cuánto costaría cubrir el resto?
//
// PURO: recibe las listas ya leídas y devuelve el inventario. La lectura de la
// base vive en scripts/historia-inventario.mjs, que es de SOLO LECTURA y lo
// corre un operador con DATABASE_URL. Acá no hay red, ni base, ni modelo.
//
// ── EL COSTO SE ESTIMA DE DOS FORMAS, Y SE DICE CUÁL ─────────────────
//   1. MEDIDO: el promedio de `company_narracion.costo.usd_total` de las
//      narraciones que ya existen. Es el número bueno, si hay alguna.
//   2. SUPUESTO: tokens del paquete de evidencia (medidos en la Fase B:
//      ~12.000 típico, techo 80 KB ≈ 23.000) × la tabla de precios de
//      _lib/model.js. Es un rango, no una medición, y sale rotulado así.
// Un número sin su origen es la clase de cifra que nadie revisa.
// ═══════════════════════════════════════════════════════════════

import { ANTHROPIC_PRICES, HISTORIA_ANTHROPIC_MODEL } from './model.js';

// Los escenarios, con la fuente de cada número.
export const ESCENARIOS = {
  // docs/historia-fase0.md, "El presupuesto, medido": 41,4 KB ≈ 12.000 tokens
  // en el emisor duro; el prompt congelado son ~1.400 tokens.
  tipico: { entrada: 12000 + 1400, salida: 3000, fuente: 'evidencia ~12K tokens (medida en el emisor duro de la Fase B) + prompt 1,4K; salida supuesta 3K (cinco secciones)' },
  // TECHO_BYTES = 80 KB ≈ 23.000 tokens; MAX_TOKENS de salida = 16.000.
  peor: { entrada: 23000 + 1400, salida: 16000, fuente: 'evidencia en el techo de 80 KB + salida en el techo de 16K tokens' },
};

export function costoPorNarracion({ entrada, salida }, modelo = HISTORIA_ANTHROPIC_MODEL) {
  const p = ANTHROPIC_PRICES[modelo];
  // La doctrina de la tabla: sin precio, null. Nunca un precio supuesto.
  if (!p) return null;
  return Math.round(((entrada / 1e6) * p.in + (salida / 1e6) * p.out) * 1e4) / 1e4;
}

const up = (t) => String(t || '').trim().toUpperCase();

// universo: [ticker] · emisores: [{ticker, cik, estado}] · narradas: [{cik, usd_total}]
export function inventario({ universo = [], emisores = [], narradas = [], modelo = HISTORIA_ANTHROPIC_MODEL } = {}) {
  const uni = [...new Set(universo.map(up).filter(Boolean))].sort();
  const porTicker = new Map();
  for (const e of emisores) if (e && e.ticker) porTicker.set(up(e.ticker), e);
  const narradasCik = new Set(narradas.map((n) => String(n.cik)));

  const cubiertas = [], ingeridasSinNarracion = [], conError = [], faltan = [];
  for (const t of uni) {
    const e = porTicker.get(t) || porTicker.get(t.replace(/\./g, '-'));
    if (!e) { faltan.push(t); continue; }
    if (narradasCik.has(String(e.cik))) cubiertas.push(t);
    else if (e.estado === 'error') conError.push(t);
    else ingeridasSinNarracion.push(t);
  }

  const medidos = narradas.map((n) => Number(n.usd_total)).filter((x) => Number.isFinite(x) && x > 0);
  const medido = medidos.length ? Math.round((medidos.reduce((a, b) => a + b, 0) / medidos.length) * 1e4) / 1e4 : null;
  const porNarrar = faltan.length + ingeridasSinNarracion.length + conError.length;
  const tip = costoPorNarracion(ESCENARIOS.tipico, modelo);
  const peor = costoPorNarracion(ESCENARIOS.peor, modelo);
  const total = (c) => (c == null ? null : Math.round(c * porNarrar * 100) / 100);

  return {
    universo: uni.length,
    emisores_en_historia: emisores.length,
    cubiertas: cubiertas.length,
    ingeridas_sin_narracion: ingeridasSinNarracion,
    con_error_de_ingesta: conError,
    faltan,
    por_narrar: porNarrar,
    costo: {
      modelo,
      por_empresa_medido_usd: medido,
      medido_sobre: medidos.length,
      por_empresa_supuesto_usd: { tipico: tip, peor },
      supuestos: { tipico: ESCENARIOS.tipico.fuente, peor: ESCENARIOS.peor.fuente },
      backfill_usd: {
        medido: total(medido),
        tipico: total(tip),
        peor: total(peor),
      },
      // La ingesta (EDGAR) no cuesta dinero, cuesta RELOJ: 42 s por ticker
      // medidos en la corrida 2 (docs/historia-fase0.md §11, G4).
      ingesta_minutos: Math.round((faltan.length * 42) / 60),
      nota: 'Narrar requiere ingerir antes. La ingesta es gratis en dinero y cara en reloj (~42 s por ticker en el goteo). El costo en dólares es solo el de narrar.',
    },
  };
}
