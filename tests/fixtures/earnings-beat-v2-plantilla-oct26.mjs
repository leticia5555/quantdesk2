// ═══════════════════════════════════════════════════════════════
// Descripción REAL de los mercados de earnings de Polymarket que v2 marcó
// `sin_metrica` en el piloto (BA, TSLA, SSNC, TFX, IMAX ×2, PJT, PYPL, LLY,
// XOM). Copiada tal cual de pm_earnings_markets_v2.raw->>'description' (la
// pegó Lety el 23-oct). Las 9 son la MISMA plantilla; solo cambian el nombre,
// la fecha estimada y el monto. Esta es la de Boeing, verbatim.
// ═══════════════════════════════════════════════════════════════

export const DESCRIPCION_BA = 'As of market creation, Boeing is estimated to release earnings on October 27, 2026. The Street consensus estimate for Boeing’s non-GAAP EPS for the relevant quarter is $-0.20 as of market creation. This market will resolve to "Yes" if Boeing reports non-GAAP EPS greater than $-0.20 for the relevant quarter in its next quarterly earnings release. Otherwise, it will resolve to "No." The resolution source will be the non-GAAP EPS listed in the company’s official earnings documents. If Boeing releases earnings without non-GAAP EPS, then the market will resolve according to the non-GAAP EPS figure reported by SeekingAlpha. If no such figure is published within 96h of market close (4:00:00pm ET) on the day earnings are announced, the market will resolve according to the GAAP EPS listed in the company’s official earnings documents; or, if not published there, according to the GAAP EPS provided by SeekingAlpha. If no GAAP EPS number is available from either source at that time, the market will resolve to “No.” (For the purposes of this market, GAAP EPS refers to diluted GAAP EPS, unless it is not published, in which case it refers to basic GAAP EPS.) If the company does not release earnings within 45 calendar days of the estimated earnings date, this market will resolve to “No.” Note: Subsequent restatements, corrections, or revisions made to the initially announced non-GAAP EPS figure will not qualify for resolution, except in the case of obvious and immediate mistakes (e.g., fat finger errors, as with Lyft\'s (LYFT) earnings release in February 2024). Note: The strike prices used in these markets reflect the selected street consensus estimate for non-GAAP EPS as of market creation. Note: All figures will be rounded to the nearest cent using standard rounding. Note: For the purposes of this market, IFRS EPS will be treated as GAAP EPS. Note: If multiple versions of non-GAAP EPS are published, the market will resolve according to the primary headline non-GAAP EPS number, which is typically presented on a diluted basis. If diluted is not published, then basic non-GAAP EPS will qualify. Note: All figures are expressed in USD, unless otherwise indicated. Note: For primarily internationally listed companies, this market refers specifically to the shares traded in the United States on U.S. stock exchanges such as the NYSE or Nasdaq. In cases where the company trades in the U.S. through an American Depositary Receipt (ADR) or American Depositary Share (ADS), this market will refer to the ADR/ADS.';

// La plantilla con nombre, fecha y monto como variables: reproduce las otras 8
// letra por letra (la única diferencia entre las 9 que pegó Lety es esa).
export function descripcionPlantilla({ empresa, fecha, monto }) {
  return DESCRIPCION_BA
    .replaceAll('Boeing', empresa)
    .replace('October 27, 2026', fecha)
    .replaceAll('$-0.20', monto);
}

// Los mercados del piloto con esta plantilla: slug, pregunta y lo que v2 tiene
// que leer. market_id y barra, de la consulta del 23-oct.
export const MERCADOS_PLANTILLA = [
  { market_id: '5412319', symbol: 'TSLA', slug: 'tsla-quarterly-earnings-nongaap-eps-10-20-2026-0pt43', pregunta: 'Will Tesla (TSLA) beat quarterly earnings?', empresa: 'Tesla', fecha: 'October 20, 2026', monto: '$0.43', barra: 0.43 },
  { market_id: '5778465', symbol: 'SSNC', slug: 'ssnc-quarterly-earnings-nongaap-eps-10-22-2026-1pt80', pregunta: 'Will SS&C (SSNC) beat quarterly earnings?', empresa: 'SS&C', fecha: 'October 22, 2026', monto: '$1.80', barra: 1.80 },
  { market_id: '5778592', symbol: 'TFX', slug: 'tfx-quarterly-earnings-nongaap-eps-10-22-2026-1pt92', pregunta: 'Will Teleflex (TFX) beat quarterly earnings?', empresa: 'Teleflex', fecha: 'October 22, 2026', monto: '$1.92', barra: 1.92 },
  { market_id: '5778294', symbol: 'IMAX', slug: 'imax-quarterly-earnings-nongaap-eps-10-22-2026-0pt88', pregunta: 'Will IMAX (IMAX) beat quarterly earnings?', empresa: 'IMAX', fecha: 'October 22, 2026', monto: '$0.88', barra: 0.88 },
  { market_id: '5999287', symbol: 'IMAX', slug: 'imax-quarterly-earnings-nongaap-eps-11-05-2026-0pt89', pregunta: 'Will IMAX (IMAX) beat quarterly earnings?', empresa: 'IMAX', fecha: 'November 5, 2026', monto: '$0.89', barra: 0.89 },
  { market_id: '5778604', symbol: 'BA', slug: 'ba-quarterly-earnings-nongaap-eps-10-27-2026-neg0pt20', pregunta: 'Will Boeing (BA) beat quarterly earnings?', empresa: 'Boeing', fecha: 'October 27, 2026', monto: '$-0.20', barra: -0.20 },
  { market_id: '5778647', symbol: 'PJT', slug: 'pjt-quarterly-earnings-nongaap-eps-10-27-2026-1pt51', pregunta: 'Will PJT Partners (PJT) beat quarterly earnings?', empresa: 'PJT Partners', fecha: 'October 27, 2026', monto: '$1.51', barra: 1.51 },
  { market_id: '5778648', symbol: 'PYPL', slug: 'pypl-quarterly-earnings-nongaap-eps-10-27-2026-1pt34', pregunta: 'Will PayPal (PYPL) beat quarterly earnings?', empresa: 'PayPal', fecha: 'October 27, 2026', monto: '$1.34', barra: 1.34 },
  { market_id: '5778687', symbol: 'LLY', slug: 'lly-quarterly-earnings-nongaap-eps-10-29-2026-7pt49', pregunta: 'Will Eli Lilly (LLY) beat quarterly earnings?', empresa: 'Eli Lilly', fecha: 'October 29, 2026', monto: '$7.49', barra: 7.49 },
  { market_id: '5999289', symbol: 'XOM', slug: 'xom-quarterly-earnings-nongaap-eps-10-30-2026-4pt11', pregunta: 'Will ExxonMobil (XOM) beat quarterly earnings?', empresa: 'ExxonMobil', fecha: 'October 30, 2026', monto: '$4.11', barra: 4.11 },
].map((m) => ({ ...m, descripcion: descripcionPlantilla(m) }));
