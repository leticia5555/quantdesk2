// ═══════════════════════════════════════════════════════════════
// Fixtures de earnings-beat v2: los resueltos del 21–22 oct 2026.
//
// LO QUE ES REAL y lo que NO:
//   · barra, métrica, resultado y EPS publicado: los del encargo (tabla del
//     21–22 oct). Las brechas y guías: las de docs/sql/earnings-beat-v2.sql.
//   · las SERIES de sorpresa de 8 trimestres: SINTÉTICAS. Esta sesión no tiene
//     acceso a Neon, así que no son las de pead_earnings. Para PG se respeta lo
//     que dice el encargo (mediana +0.04, 8/8 beats). Para el resto se eligen
//     valores plausibles y se declara, en cada una, el UMBRAL a partir del cual
//     el lado de v2 se da vuelta — que es lo que hay que mirar contra la tabla
//     real (/api/earnings-beat-v2?validacion=1).
//   · AAL y PCG están FUERA del universo de 99: en producción no tienen
//     pead_earnings y v2 no les da número. Sus series acá solo sirven para
//     probar la aritmética con un universo ampliado a propósito.
// ═══════════════════════════════════════════════════════════════

// 8 trimestres antes del 1-oct-2026, del más viejo al más nuevo.
const FECHAS = ['2024-10-20', '2025-01-25', '2025-04-25', '2025-07-25', '2025-10-24', '2026-01-23', '2026-04-24', '2026-07-24'];

export function historia(sorpresas, estimadoBase = 1) {
  return sorpresas.map((s, i) => ({
    reported_date: FECHAS[i],
    estimated_eps: estimadoBase,
    reported_eps: +(estimadoBase + s).toFixed(4),
  }));
}

export const GAPS = {
  META: [{ concepto: 'cargo_legal_q3_2026', brecha_por_accion: 3.30, afecta: 'GAAP', fuente_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&CIK=0001326801', verificada: false }],
  UNP: [{ concepto: 'costos_fusion_nsc', brecha_por_accion: 0.04, afecta: 'GAAP', fuente_url: 'https://www.sec.gov/Archives/edgar/data/0000100885/000010088526000250/unp-20260630.htm', verificada: false }],
};

export const GUIAS = {
  AAL: { metrica: 'NONGAAP', alcance: 'trimestre', guia_min: -0.70, guia_max: -0.10 },
  PCG: { metrica: 'NONGAAP', alcance: 'anual', guia_min: 1.64, guia_max: 1.66, ytd_reportado: 0.83, trimestres_restantes: 2 },
};

// sorpresas: serie sintética. umbral: la mediana a partir de la cual v2 da
// > 50% (con la regla de empate de 0.005 y centavos).
export const RESUELTOS = [
  {
    mercado: { market_id: 'fx-meta', symbol: 'META', fecha: '2026-10-21', metrica_barra: 'GAAP', barra: 6.31, consenso_creacion: 6.31, outcome: 'no', actual_eps: 3.83 },
    sorpresas: [0.30, 0.45, 0.60, 0.70, 0.80, 0.90, 1.05, 1.20], base: 5.5,
    esperado: 'no',
    umbral: 'v2 daría Yes solo con sorpresa mediana > +3.30 (la brecha entera): robusto.',
  },
  {
    mercado: { market_id: 'fx-unp', symbol: 'UNP', fecha: '2026-10-22', metrica_barra: 'GAAP', barra: 3.50, consenso_creacion: 3.50, outcome: 'no', actual_eps: 3.49 },
    sorpresas: [-0.03, 0.00, 0.02, 0.03, 0.03, 0.05, 0.07, 0.09], base: 2.9,
    esperado: 'no',
    umbral: 'v2 da Yes con sorpresa mediana ≥ +0.05 (3.50 + 0.05 − 0.04 = 3.51). Con +0.04 da 45%; con +0.03, 3.49.',
  },
  {
    mercado: { market_id: 'fx-pg', symbol: 'PG', fecha: '2026-10-22', metrica_barra: 'NONGAAP', barra: 1.94, consenso_creacion: 1.94, outcome: 'yes', actual_eps: 2.00 },
    sorpresas: [0.02, 0.03, 0.04, 0.04, 0.04, 0.05, 0.06, 0.08], base: 1.8,
    esperado: 'yes',
    umbral: 'Si el consenso de la descripción es 1.94 (= barra), v2 da Yes con cualquier mediana ≥ +0.01. Si es 1.90 (como dice la tabla del encargo), 1.90 + 0.04 = 1.94 = barra → 39%: v2 FALLA.',
  },
  {
    mercado: { market_id: 'fx-aal', symbol: 'AAL', fecha: '2026-10-22', metrica_barra: 'NONGAAP', barra: -0.34, consenso_creacion: -0.34, outcome: 'yes', actual_eps: -0.28 },
    sorpresas: [-0.02, 0.01, 0.03, 0.05, 0.06, 0.08, 0.10, 0.14], base: 0.2,
    esperado: 'yes',
    fuera_universo: true,
    umbral: 'v2 da Yes con sorpresa mediana ≥ +0.01. La guía (medio −0.40) diría lo contrario: no entra al estimado.',
  },
  {
    mercado: { market_id: 'fx-pcg', symbol: 'PCG', fecha: '2026-10-22', metrica_barra: 'NONGAAP', barra: 0.43, consenso_creacion: 0.43, outcome: 'no', actual_eps: 0.41 },
    sorpresas: [-0.02, -0.01, -0.01, 0.00, 0.00, 0.01, 0.02, 0.04], base: 0.35,
    esperado: 'no',
    fuera_universo: true,
    umbral: 'v2 da No solo si la sorpresa mediana es ≤ 0.00. Con +0.01 (PCG suele ganarle al consenso por un centavo) da Yes y FALLA. Lo que lo resolvía era la guía implícita (0.405–0.415 < 0.43), que no entra al estimado.',
  },
];
