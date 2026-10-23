-- ═══════════════════════════════════════════════════════════════
-- docs/sql/earnings-beat-v2.sql — migración + semillas de earnings-beat v2.
--
-- La migración (las 4 tablas) es la misma que SCHEMA_V2 de
-- api/_lib/earnings-beat-v2-db.js; el job diario la corre sola
-- (ensureSchemaV2). tests/earnings-beat-v2.test.mjs exige que no diverjan.
-- Las SEMILLAS sí hay que correrlas a mano, una vez (son idempotentes).
--
-- REGLA DE LAS SEMILLAS: solo entra lo que esté en un 8-K, 10-Q o documento
-- de IR con URL. Nada de estimados propios. `verificada = false` quiere decir
-- que la URL existe pero nadie abrió el documento y vio el número con sus
-- ojos: las encontré por búsqueda, sin acceso directo a sec.gov desde la
-- sesión. Donde no encontré el documento exacto, la URL es el ÍNDICE de 8-K
-- de EDGAR de la empresa y la nota lo dice. Antes del 5-nov, cada fila
-- `verificada = false` se abre y se pasa a true (o se corrige).
--
-- quarter_end = fin del trimestre calendario anterior a la fecha del mercado
-- (trimestreDelReporte en api/_lib/earnings-beat-v2.js). Para los 22 del set
-- de validación es 2026-09-30.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────── migración ───────────────────

create table if not exists pm_earnings_v2_features (
   market_id              text primary key,
   symbol                 text,
   fecha                  date,
   quarter_end            date,
   metrica_barra          text,            -- 'GAAP' | 'NONGAAP'
   barra                  numeric,
   consenso_creacion      numeric,
   consenso_vigente       numeric,         -- AV estimatedEPS; PIT solo hacia adelante
   consenso_vigente_ts    timestamptz,     -- cuándo se capturó (nunca después de T-24h)
   sorpresa_mediana_8t    numeric,
   sorpresa_std_8t        numeric,
   n_8t                   int,
   beats_8t               int,
   sorpresa_metrica_match boolean,
   brecha_gaap_adj        numeric not null default 0,
   cargo_ambas_metricas   numeric not null default 0,
   guia_q_implicita       numeric,
   guia_q_min             numeric,
   guia_q_max             numeric,
   estimado_v2            numeric,
   margen_v2              numeric,
   prob_v2                numeric,
   std_fallback           boolean,
   prob_pm_t24            numeric,
   desacuerdo             numeric,
   fuera_universo         boolean not null default false,
   faltante               text,
   outcome                text,
   calculado_en           timestamptz not null default now()
 );

create table if not exists pm_known_gaps (
   symbol             text not null,
   quarter_end        date not null,
   concepto           text not null,       -- una fila por cargo; se suman
   brecha_por_accion  numeric not null check (brecha_por_accion >= 0),
   afecta             text not null default 'GAAP',  -- 'GAAP' | 'AMBAS'
   tipo               text not null,       -- merger_costs | legal_charge | ipr&d | mark_to_market | other
   fuente_url         text not null,
   publicado_en       date,                -- fecha del documento fuente
   verificada         boolean not null default false, -- alguien abrió el documento y vio el número
   nota               text,
   capturado_en       timestamptz not null default now(),
   primary key (symbol, quarter_end, concepto)
 );

create table if not exists pm_company_guidance (
   symbol               text not null,
   quarter_end          date not null,
   metrica              text not null,     -- 'GAAP' | 'NONGAAP'
   alcance              text not null default 'trimestre', -- 'trimestre' | 'anual'
   guia_min             numeric,
   guia_max             numeric,
   ytd_reportado        numeric,           -- solo alcance anual
   trimestres_restantes int,               -- solo alcance anual
   fuente_url           text not null,
   publicado_en         date,
   verificada           boolean not null default false,
   nota                 text,
   capturado_en         timestamptz not null default now(),
   primary key (symbol, quarter_end, metrica)
 );

create table if not exists pm_v2_validation (
   symbol           text not null,
   fecha_mercado    date not null,
   market_id        text,                  -- null si no está en pm_earnings_markets
   metrica_barra    text,
   barra            numeric,
   consenso_creacion numeric,
   prob_pm_t24      numeric,               -- a mano, solo si no está en pm_earnings_markets
   outcome          text,                  -- 'yes' | 'no' | null
   actual_eps       numeric,
   resuelto_en      date,
   fuente_url       text,
   nota             text,
   capturado_en     timestamptz not null default now(),
   primary key (symbol, fecha_mercado)
 );

-- ─────────────────── pm_known_gaps ───────────────────
-- brecha_por_accion ≥ 0 = ajustado − GAAP esperado. afecta = 'AMBAS' para un
-- cargo que la empresa deja también en su non-GAAP (IPR&D de Lilly).

insert into pm_known_gaps (symbol, quarter_end, concepto, brecha_por_accion, afecta, tipo, fuente_url, publicado_en, verificada, nota) values
  ('META', '2026-09-30', 'cargo_legal_q3_2026', 3.30, 'GAAP', 'legal_charge',
   'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0001326801', null, false,
   'Encargo: cargo legal $9.9B pre-anunciado en un 8-K de agosto → −3.3/acción. NO localicé ese 8-K. La única fuente primaria con $9.9B que encontré es el exhibit 99.1 del 8-K de RESULTADOS de Q3 (https://www.sec.gov/Archives/edgar/data/0001326801/000162828026066700/meta-09302026xexhibit991.htm), que es POSTERIOR al mercado y no sirve como fuente PIT. URL = índice de 8-K hasta que alguien ponga el documento de agosto.'),
  ('UNP', '2026-09-30', 'costos_fusion_nsc', 0.04, 'GAAP', 'merger_costs',
   'https://www.sec.gov/Archives/edgar/data/0000100885/000010088526000250/unp-20260630.htm', '2026-07-24', false,
   'Encargo: $0.04/trim recurrente en cada 10-Q. Ojo: la prensa del Q2 da reportado 3.36 vs ajustado 3.41 (0.05); el 10-Q de Q2 da $71M de gasto de adquisición en el semestre. Verificar el por-acción del Q2 en la conciliación antes de dejar 0.04.'),
  ('LLY', '2026-09-30', 'ipr&d_adquirido_q3_2026', 4.57, 'AMBAS', 'ipr&d',
   'https://investor.lilly.com/static-files/83a17a60-38b3-458d-b778-a510ad4d7e9b', '2026-10-07', false,
   'Lilly: ~$4.2B pre-tax de IPR&D adquirido en Q3, ~$4.57/acción, en GAAP Y non-GAAP (Lilly no excluye IPR&D adquirido de su non-GAAP). Por eso afecta = AMBAS: la brecha GAAP−ajustado es 0, pero el cargo pega en la barra sea cual sea la métrica. Verificar que este static-file es el de Q3 (hay uno igual para Q2: $2.8B, $3.02).'),
  ('GOOGL', '2026-09-30', 'multa_dma_ce_jul_2026', 0.07, 'GAAP', 'legal_charge',
   'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0001652044', null, false,
   'Encargo: multa DMA de julio → −0.07/acción. La Comisión Europea multó a Alphabet (≈ €890M según prensa). No encontré el documento de Alphabet que dé el por-acción ni el trimestre en que se reconoce. URL = índice de 8-K.'),
  ('GOOGL', '2026-09-30', 'pricerunner', 0.00, 'GAAP', 'legal_charge',
   'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=10-Q&dateb=&owner=include&count=40&CIK=0001652044', null, false,
   'Encargo: $0 en Q3 porque se reconoció en Q2 según el 10-Q, nota 10. Fila en 0 para que quede escrito que se miró. URL = índice de 10-Q.')
on conflict (symbol, quarter_end, concepto) do nothing;

-- ─────────────────── pm_company_guidance ───────────────────
-- alcance 'anual': guia_q_implicita = (guía anual − YTD reportado) / trimestres restantes.

insert into pm_company_guidance (symbol, quarter_end, metrica, alcance, guia_min, guia_max, ytd_reportado, trimestres_restantes, fuente_url, publicado_en, verificada, nota) values
  ('AAL', '2026-09-30', 'NONGAAP', 'trimestre', -0.70, -0.10, null, null,
   'https://www.sec.gov/Archives/edgar/data/0000006201/000000620126000051/a8kerexhibit991q2-26.htm', '2026-07-23', false,
   'Q3 adjusted loss per diluted share −0.70 a −0.10 (8-K de resultados Q2).'),
  ('PCG', '2026-09-30', 'NONGAAP', 'anual', 1.64, 1.66, 0.83, 2,
   'https://www.sec.gov/Archives/edgar/data/0001004980/000100498026000047/pge-q22026pressrelease.htm', '2026-07-23', false,
   'Guía 2026 core EPS 1.64–1.66 reafirmada; core YTD a junio 0.83 (0.43 + 0.40). Con la fórmula del encargo: Q3 implícito (1.64−0.83)/2 = 0.405 a (1.66−0.83)/2 = 0.415. El encargo dice 0.43–0.44: eso sale de otra cuenta (estacionalidad), no de esta.'),
  ('SSNC', '2026-09-30', 'NONGAAP', 'trimestre', 1.73, 1.79, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001402436/000119312526314097/ssnc-ex99_2.htm', '2026-07-23', false,
   'Q3 adjusted diluted EPS 1.73–1.79.'),
  ('TDOC', '2026-09-30', 'GAAP', 'trimestre', -0.30, -0.20, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001477449/000147744926000036/tdoc-20260630xexx991.htm', '2026-07-29', false,
   'La tabla de outlook del 8-K dice "net loss per share" (GAAP); la prensa lo reporta como ajustado. Verificar la métrica.'),
  ('PYPL', '2026-09-30', 'NONGAAP', 'trimestre', 1.30, 1.32, null, null,
   'https://www.sec.gov/Archives/edgar/data/0001633917/000163391726000080/pypl2q-26earningsrelease.htm', '2026-07-28', false,
   'El 8-K dice "low-single-digit decline" vs 1.34 del 3Q25. 1.30–1.32 es la traducción del encargo (−1.5% a −3%), no un número del documento.'),
  ('AXP', '2026-09-30', 'GAAP', 'anual', 17.30, 17.90, 8.80, 2,
   'https://www.sec.gov/Archives/edgar/data/0000004962/000000496226000318/q226exhibit991.htm', '2026-07-24', false,
   'Guía anual 17.30–17.90 reafirmada. YTD 8.80 = el que reproduce el H2 4.25–4.55/trim del encargo (Q2 = 4.53 → Q1 = 4.27). Verificar Q1.')
on conflict (symbol, quarter_end, metrica) do nothing;

-- ─────────────────── pm_v2_validation ───────────────────
-- Los 22 de /finance/earnings al 21-oct-2026 20:00 CT. La barra/métrica de
-- acá solo se usa si el mercado NO está en pm_earnings_markets (fuera del
-- universo v1); si está, manda la descripción real del mercado.
-- outcome/actual: a mano, para que el Brier no dependa de la API de Polymarket.

insert into pm_v2_validation (symbol, fecha_mercado, metrica_barra, barra, consenso_creacion, outcome, actual_eps, resuelto_en, fuente_url, nota) values
  ('TSLA',  '2026-10-20', null, null, null, 'yes', 0.48, '2026-10-21', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=TSLA', 'barra no dada en el encargo'),
  ('WDFC',  '2026-10-21', null, null, null, 'no', 1.06, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=WDFC', 'barra no dada; fuera del universo'),
  ('META',  '2026-10-21', 'GAAP', 6.31, 6.31, 'no', 3.83, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0001326801', null),
  ('UNP',   '2026-10-22', 'GAAP', 3.50, 3.50, 'no', 3.49, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0000100885', 'ajustado 3.53'),
  ('SSNC',  '2026-10-22', null, null, null, null, null, null, null, 'fuera del universo'),
  ('PG',    '2026-10-22', 'NONGAAP', 1.94, null, 'yes', 2.00, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0000080424', 'El encargo da consenso 1.90 y barra 1.94: consenso_creacion se deja null hasta leer la descripción real (si dice 1.90, consenso ≠ barra).'),
  ('AAL',   '2026-10-22', 'NONGAAP', -0.34, -0.34, 'yes', -0.28, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0000006201', 'fuera del universo'),
  ('TFX',   '2026-10-22', null, null, null, null, null, null, null, 'fuera del universo'),
  ('PCG',   '2026-10-22', 'NONGAAP', 0.43, 0.43, 'no', 0.41, '2026-10-22', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&CIK=0001004980', 'core EPS; fuera del universo'),
  ('IMAX',  '2026-10-22', null, 0.88, null, null, null, null, null, 'fuera del universo'),
  ('AXP',   '2026-10-23', null, null, null, null, null, null, null, null),
  ('SOFI',  '2026-10-27', null, 0.17, 0.17, null, null, null, null, 'consenso = barra; fuera del universo'),
  ('BA',    '2026-10-27', null, null, null, null, null, null, null, null),
  ('PJT',   '2026-10-27', null, null, null, null, null, null, null, 'fuera del universo'),
  ('CZR',   '2026-10-27', null, null, null, null, null, null, null, 'fuera del universo'),
  ('PYPL',  '2026-10-27', null, null, null, null, null, null, null, null),
  ('GOOGL', '2026-10-27', null, null, null, null, null, null, null, null),
  ('TDOC',  '2026-10-28', null, null, null, null, null, null, null, 'fuera del universo'),
  ('AMZN',  '2026-10-29', null, null, null, null, null, null, null, null),
  ('LLY',   '2026-10-29', null, null, null, null, null, null, null, null),
  ('XOM',   '2026-10-30', null, null, null, null, null, null, null, null),
  ('IMAX',  '2026-11-05', null, 0.89, null, null, null, null, null, 'fuera del universo')
on conflict (symbol, fecha_mercado) do nothing;
