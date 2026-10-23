-- ═══════════════════════════════════════════════════════════════
-- docs/sql/earnings-beat-v2-2.sql — `anunciado_en` en pm_known_gaps (24-oct).
--
-- Se corre DESPUÉS de earnings-beat-v2.sql y earnings-beat-v2-1.sql. La
-- columna también la crea sola SCHEMA_V2 (api/_lib/earnings-beat-v2-db.js);
-- tests/earnings-beat-v2.test.mjs exige que no diverjan.
--
-- DATO, NO REGLA. anunciado_en = cuándo se anunció el cargo por primera vez.
-- La fila de v2 marca si el mercado nació después del anuncio (`§` en el
-- markdown, `brechas_anunciadas_antes_de_creacion` en el JSON), pero la
-- brecha se aplica igual. La regla "creado después del anuncio ⇒ el consenso
-- ya trae el cargo ⇒ brecha 0" se evaluó y se descartó con META: mercado
-- creado el 16-oct, anuncio del 26-ago, barra GAAP 6.31 = consenso de
-- creación, resultado 3.83. El consenso no traía el cargo.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────── migración ───────────────────

alter table pm_known_gaps add column if not exists anunciado_en date;

-- ─────────────────── semillas ───────────────────

-- META: comunicado del 26-ago-2026 (CNBC), ~$10B.
update pm_known_gaps set anunciado_en = '2026-08-26'
 where symbol = 'META' and quarter_end = '2026-09-30' and concepto = 'cargo_legal_q3_2026';

-- LLY: aviso del 7-oct-2026 de ~$4.2B de IPR&D adquirido en Q3.
update pm_known_gaps set anunciado_en = '2026-10-07'
 where symbol = 'LLY' and quarter_end = '2026-09-30' and concepto = 'ipr&d_adquirido_q3_2026';

-- UNP: costo recurrente; la brecha ex-ante sale del 8-K de Q2 (23-jul-2026).
update pm_known_gaps set anunciado_en = '2026-07-23'
 where symbol = 'UNP' and quarter_end = '2026-09-30' and concepto = 'costos_fusion_nsc';

-- GOOGL: multa DMA de la Comisión Europea, 23-jul-2026 (sin documento primario).
update pm_known_gaps set anunciado_en = '2026-07-23'
 where symbol = 'GOOGL' and quarter_end = '2026-09-30' and concepto = 'multa_dma_ce_jul_2026';
-- GOOGL pricerunner: brecha 0 en Q3, no hay anuncio que fechar.
