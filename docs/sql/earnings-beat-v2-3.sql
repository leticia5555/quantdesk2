-- ═══════════════════════════════════════════════════════════════
-- docs/sql/earnings-beat-v2-3.sql — semillas para el set v2.1 (24-oct).
--
-- Se corre DESPUÉS de earnings-beat-v2.sql, -v2-1.sql y -v2-2.sql. No trae
-- DDL: solo datos. Idempotente (on conflict do update). Todas cargadas ANTES
-- de que resuelvan los mercados, con documento. Regla de siempre: verificada
-- = true solo con una URL que una persona abrió y donde vio el número.
--
-- quarter_end = 2026-09-30 (trimestre calendario anterior a reportes de oct/nov).
--
-- NO se cargan (sin guía de EPS): YELP, CBOE, CVX, IVZ, HGV, RDDT, DKNG, COIN.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────── pm_known_gaps ───────────────────

insert into pm_known_gaps (symbol, quarter_end, concepto, brecha_por_accion, afecta, tipo, fuente_url, publicado_en, anunciado_en, verificada, nota) values
  ('MRK', '2026-09-30', 'ipr&d_scibrunch_spr2015', 0.13, 'AMBAS', 'ipr&d',
   'https://www.merck.com/news/merck-enters-into-exclusive-global-license-agreement-with-scibrunch-therapeutics-for-spr2015-an-investigational-oral-kras-g12d-on-inhibitor/',
   '2026-09-28', '2026-09-28', true,
   'Licencia de SPR2015 (SciBrunch). El comunicado dice "included in GAAP and non-GAAP results for Q3 2026" → afecta = AMBAS. Política de Merck de dejar el IPR&D en non-GAAP, confirmada en el 8-K de Q2: https://www.sec.gov/Archives/edgar/data/0000310158/000110465926090045/tm2621496d1_ex99-1.htm')
on conflict (symbol, quarter_end, concepto) do update set
  brecha_por_accion = excluded.brecha_por_accion, afecta = excluded.afecta, tipo = excluded.tipo,
  fuente_url = excluded.fuente_url, publicado_en = excluded.publicado_en, anunciado_en = excluded.anunciado_en,
  verificada = excluded.verificada, nota = excluded.nota, capturado_en = now();

-- ─────────────────── pm_company_guidance ───────────────────

insert into pm_company_guidance (symbol, quarter_end, metrica, alcance, guia_min, guia_max, ytd_reportado, trimestres_restantes, fuente_url, publicado_en, verificada, nota) values
  ('HLT', '2026-09-30', 'NONGAAP', 'trimestre', 2.28, 2.34, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001585689/000158568926000042/q22026earningsrelease.htm', '2026-07-28', false,
   'Q3 2026 adjusted diluted EPS 2.28–2.34 (comunicado de Q2, 28-jul-2026). La URL es la del 8-K de EDGAR que encontró la búsqueda; la sesión no puede abrir sec.gov, así que queda sin verificar hasta que alguien la abra. Cita secundaria: https://chartrow.com/quote/hlt/earnings'),
  ('NET', '2026-09-30', 'NONGAAP', 'trimestre', 0.34, 0.34, null, null,
   'https://secure.businesswire.com/news/home/20260806407787/en/Cloudflare-Announces-Second-Quarter-2026-Financial-Results', '2026-08-06', true,
   'Q3 2026 non-GAAP net income per share 0.34 (punto, no rango).'),
  ('EBAY', '2026-09-30', 'NONGAAP', 'trimestre', 1.36, 1.42, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001065088/000106508826000174/exhibit991erebayq22026.htm', null, true,
   'Q3 2026 non-GAAP EPS 1.36–1.42 (8-K de Q2). Ojo: el 8-K del 22-oct dice "above guidance ranges" (https://www.sec.gov/Archives/edgar/data/0001065088/000106508826000205/ebay-20261020.htm). Reporte real: 28-oct; el slug de Polymarket trae otra fecha.'),
  ('MRK', '2026-09-30', 'NONGAAP', 'anual', 2.66, 2.76, -1.41, 2,
   'https://www.sec.gov/Archives/edgar/data/0000310158/000110465926090045/tm2621496d1_ex99-1.htm', null, true,
   'Guía 2026 non-GAAP EPS 2.66–2.76 (8-K de Q2). YTD a junio −1.41 → Q3 implícito (guía − YTD)/2 = 2.035–2.085. La guía es de julio: anterior al cargo de IPR&D del 28-sep (0.13, pm_known_gaps), que por eso NO está adentro.'),
  ('CL', '2026-09-30', 'NONGAAP', 'anual', 3.84, 3.91, 1.97, 2,
   'https://www.sec.gov/Archives/edgar/data/0000021665/000002166526000041/q22026pressreleasetables.htm', null, false,
   'Texto literal: "mid-single-digit growth" en base non-GAAP sobre 3.69 de 2025. El rango 3.84–3.91 es INTERPRETACIÓN (+4% a +6%), no un número del documento. YTD 1.97 → Q3 implícito 0.935–0.97.')
on conflict (symbol, quarter_end, metrica) do update set
  alcance = excluded.alcance, guia_min = excluded.guia_min, guia_max = excluded.guia_max,
  ytd_reportado = excluded.ytd_reportado, trimestres_restantes = excluded.trimestres_restantes,
  fuente_url = excluded.fuente_url, publicado_en = excluded.publicado_en,
  verificada = excluded.verificada, nota = excluded.nota, capturado_en = now();

-- ─────────────────── piloto: dos filas a revisar ───────────────────
-- IMAX 10-22 (5778294, barra 0.88): IMAX reporta el 5-nov, no el 22-oct (el
-- slug estaba mal). Ese mercado no podía resolver el 22: resuelve contra el
-- MISMO reporte que IMAX 11-05 (5999287, barra 0.89). Son dos barras sobre un
-- solo evento, no dos datos independientes. Se anota; el piloto no tiene
-- veredicto, así que no se toca nada más.
update pm_v2_validation
   set nota = 'IMAX reporta el 5-nov, no el 22-oct (slug mal). Resuelve contra el MISMO reporte que IMAX 11-05 (barra 0.89): dos barras, un solo evento, no independientes. Fila revisada el 24-oct.'
 where set = 'piloto-oct26' and symbol = 'IMAX' and fecha_mercado = '2026-10-22';

-- GOOGL 10-27: reporte real 28-oct.
update pm_v2_validation
   set nota = 'Reporte real: 28-oct (el slug dice 10-27).'
 where set = 'piloto-oct26' and symbol = 'GOOGL' and fecha_mercado = '2026-10-27';
