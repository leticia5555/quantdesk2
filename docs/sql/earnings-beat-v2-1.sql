-- ═══════════════════════════════════════════════════════════════
-- docs/sql/earnings-beat-v2-1.sql — migración + semillas de earnings-beat v2.1.
--
-- Se corre DESPUÉS de docs/sql/earnings-beat-v2.sql. La migración es la
-- misma que la cola de SCHEMA_V2 (api/_lib/earnings-beat-v2-db.js) y los jobs
-- la corren solos; tests/earnings-beat-v2.test.mjs exige que no diverjan.
--
-- SEMILLAS: esta vez son UPDATES de las de v2 (on conflict do update), con
-- las URL que Lety abrió el 23-oct. Regla: verificada = true SOLO con una URL
-- que una persona abrió y donde vio el número. Lo que sigue en false lo dice
-- en la nota.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────── migración ───────────────────

alter table pm_v2_validation add column if not exists set text not null default 'piloto-oct26';

create table if not exists pm_v2_hist (
   symbol             text not null,
   fiscal_quarter_end date not null,
   reported_date      date,
   reported_eps       numeric,
   estimated_eps      numeric,
   surprise           numeric,
   fuente             text not null default 'alphavantage',
   capturado_en       timestamptz not null default now(),
   primary key (symbol, fiscal_quarter_end)
 );

create table if not exists pm_earnings_markets_v2 (
   market_id        text primary key,
   slug             text,
   question         text,
   symbol           text,
   symbol_via       text,            -- 'ticker' | 'alias' | 'symbol_map'
   camino           text,            -- 'simbolo' | 'busqueda' | 'tags' | 'cluster'
   filtro_motivo    text not null,   -- siempre 'ok' en la tabla; se guarda para auditar
   creado           timestamptz,     -- createdAt del mercado (ancla del emparejamiento)
   report_date      date,            -- reported_date de pead_earnings al cruzar
   resolved_date    date,            -- fecha de resolución del mercado
   consensus_pm     numeric,         -- el consenso que Polymarket DECLARA
   outcome          text,            -- 'yes' | 'no' | null (abierto)
   abierto          boolean not null default false,
   yes_token_id     text,
   yes_price_t24h   numeric,
   yes_price_ts     timestamptz,     -- CUÁNDO fue ese tick: sin esto el precio no es auditable
   yes_price_estado text,            -- valido | rancio | sin_ticks | sin_ticks_antes | error | sin_token
   volume           numeric,
   raw              jsonb,           -- el mercado crudo: el esquema de Gamma cambia
   ingested_at      timestamptz not null default now(),
   updated_at       timestamptz not null default now()
 );

create index if not exists pm_earnings_markets_v2_symbol_idx
   on pm_earnings_markets_v2 (symbol, report_date);

create index if not exists pm_earnings_markets_v2_abierto_idx
   on pm_earnings_markets_v2 (abierto) where abierto;

alter table pm_earnings_markets_v2 add column if not exists universo_pead boolean not null default false;

alter table pm_earnings_v2_features add column if not exists estimado_b numeric;

alter table pm_earnings_v2_features add column if not exists prob_b numeric;

-- El set de 22 pasa a ser piloto, SIN veredicto. Se etiqueta, no se borra.
update pm_v2_validation set set = 'piloto-oct26' where set is distinct from 'piloto-oct26';

-- ─────────────────── pm_known_gaps ───────────────────

insert into pm_known_gaps (symbol, quarter_end, concepto, brecha_por_accion, afecta, tipo, fuente_url, publicado_en, verificada, nota) values
  ('META', '2026-09-30', 'cargo_legal_q3_2026', 3.30, 'GAAP', 'legal_charge',
   'https://www.cnbc.com/2026/08/26/meta-social-media-trial-settlement.html', '2026-08-26', true,
   'No es un 8-K de agosto: es el comunicado del 26-ago-2026 (~$10B) que cita CNBC. El número final ($9.9B) está en el 8-K de resultados de Q3 (https://www.sec.gov/Archives/edgar/data/0001326801/000162828026066700/meta-09302026xexhibit991.htm), posterior al mercado. La brecha por acción (3.30) es la del encargo.'),
  ('UNP', '2026-09-30', 'costos_fusion_nsc', 0.05, 'GAAP', 'merger_costs',
   'https://www.sec.gov/Archives/edgar/data/0000100885/000010088526000249/a2026-07x238xkex991earning.htm', '2026-07-23', true,
   'Brecha esperada EX-ANTE = la del último reporte antes del mercado: Q2 2026, $35M / $0.05. Antes: Q3 2025 $41M / $0.07 (https://www.sec.gov/Archives/edgar/data/100885/000010088525000320/a2025-10x238xkex991earning.htm). La de Q3 2026 real fue $22M / $0.04 (BusinessWire, 22-oct): no se usa, es posterior.'),
  ('LLY', '2026-09-30', 'ipr&d_adquirido_q3_2026', 4.57, 'AMBAS', 'ipr&d',
   'https://investor.lilly.com/static-files/83a17a60-38b3-458d-b778-a510ad4d7e9b', '2026-10-07', true,
   'Q3 2026: ~$4.2B pre-tax de IPR&D adquirido, ~$4.57/acción. afecta = AMBAS: Lilly lo deja en reported Y non-GAAP (el comunicado de Q2 dice "reported and non-GAAP EPS included $3.03 of acquired IPR&D": https://investor.lilly.com/news-releases/news-release-details/lilly-reports-second-quarter-2026-financial-results-raises-full).'),
  ('GOOGL', '2026-09-30', 'pricerunner', 0.00, 'GAAP', 'legal_charge',
   'https://s206.q4cdn.com/479360582/files/doc_financials/2026/q2/GOOG-10-Q-Q2-2026.pdf', null, true,
   'Reconocido en Q2, no en Q3 (10-Q Q2 2026, nota 10) → brecha Q3 = 0 por este concepto.'),
  ('GOOGL', '2026-09-30', 'multa_dma_ce_jul_2026', 0.07, 'GAAP', 'legal_charge',
   'https://www.aljazeera.com/news/2026/7/23/eu-hits-google-with-new-1bn-fine-saying-it-broke-digital-antitrust-rules', '2026-07-23', false,
   'sin documento primario; el 10-Q Q2 dice que no podía estimar pérdida probable. Multa DMA €890M (23-jul-2026). La brecha por acción (0.07) es la del encargo.')
on conflict (symbol, quarter_end, concepto) do update set
  brecha_por_accion = excluded.brecha_por_accion, afecta = excluded.afecta, tipo = excluded.tipo,
  fuente_url = excluded.fuente_url, publicado_en = excluded.publicado_en,
  verificada = excluded.verificada, nota = excluded.nota, capturado_en = now();

-- ─────────────────── pm_company_guidance ───────────────────

insert into pm_company_guidance (symbol, quarter_end, metrica, alcance, guia_min, guia_max, ytd_reportado, trimestres_restantes, fuente_url, publicado_en, verificada, nota) values
  ('AAL', '2026-09-30', 'NONGAAP', 'trimestre', -0.70, -0.10, null, null,
   'https://www.sec.gov/Archives/edgar/data/0000006201/000000620126000051/a8kerexhibit991q2-26.htm', '2026-07-23', true,
   'Q3 adjusted loss per diluted share −0.70 a −0.10 (8-K de resultados Q2 2026).'),
  ('PCG', '2026-09-30', 'NONGAAP', 'anual', 1.64, 1.66, 0.83, 2,
   'https://www.sec.gov/Archives/edgar/data/0001004980/000100498026000047/pge-q22026pressrelease.htm', '2026-07-23', true,
   'Guía 2026 core EPS 1.64–1.66 reafirmada; core YTD a junio 0.83. Q3 implícito (guía − YTD)/2 = 0.405–0.415.'),
  ('AXP', '2026-09-30', 'GAAP', 'anual', 17.30, 17.90, 8.80, 2,
   'https://www.sec.gov/Archives/edgar/data/0000004962/000000496226000318/q226exhibit991.htm', '2026-07-24', true,
   'Guía anual 17.30–17.90 (8-K Q2 2026). YTD 8.80 (Q1 4.27 + Q2 4.53) → H2 4.25–4.55 por trimestre.'),
  ('PYPL', '2026-09-30', 'NONGAAP', 'trimestre', 1.30, 1.32, null, null,
   'https://www.sec.gov/Archives/edgar/data/1633917/000163391726000080/pypl2q-26earningsrelease.htm', '2026-07-28', true,
   'Texto literal: "Non-GAAP EPS: Low-single digit decline for 3Q''26" (vs. $1.34 del 3Q''25). El rango 1.30–1.32 es INTERPRETACIÓN (−1.5% a −3%), no un número del documento.'),
  ('TDOC', '2026-09-30', 'GAAP', 'trimestre', -0.30, -0.20, null, null,
   'https://www.globenewswire.com/news-release/2026/07/29/3335574/0/en/teladoc-health-reports-second-quarter-2026-results.html', '2026-07-29', true,
   'Q3 2026 net loss per share −0.30 a −0.20 (GAAP).'),
  ('SSNC', '2026-09-30', 'NONGAAP', 'trimestre', 1.73, 1.79, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001402436/000119312526314097/ssnc-ex99_2.htm', '2026-07-23', false,
   'Q3 adjusted diluted EPS 1.73–1.79. Esta es la URL del 8-K del 23-jul que encontró la búsqueda, pero la sesión no puede abrir sec.gov: queda sin verificar hasta que alguien la abra.')
on conflict (symbol, quarter_end, metrica) do update set
  alcance = excluded.alcance, guia_min = excluded.guia_min, guia_max = excluded.guia_max,
  ytd_reportado = excluded.ytd_reportado, trimestres_restantes = excluded.trimestres_restantes,
  fuente_url = excluded.fuente_url, publicado_en = excluded.publicado_en,
  verificada = excluded.verificada, nota = excluded.nota, capturado_en = now();
