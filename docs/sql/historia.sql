-- ═══════════════════════════════════════════════════════════════
-- docs/sql/historia.sql — el esquema del módulo HISTORIA (EDGAR).
--
-- No hace falta correrlo a mano: `asegurarEsquema()` de
-- api/_lib/historia-db.js lo aplica solo en el primer request. Está acá para
-- poder leerlo, revisarlo y aplicarlo en un entorno nuevo sin levantar la app.
--
-- ⚠️  ESTE ARCHIVO SE GENERA DESDE `HISTORIA_SCHEMA`, no se edita a mano.
--     tests/historia-db.test.mjs falla si los dos se separan.
--
-- Las tres decisiones que no son obvias, y que salieron de la corrida 2
-- (docs/historia-fase0.md §11):
--
--   · `familia_rango` — la familia une los alias de un concepto porque la
--     serie cruza el cambio de taxonomía (ASC 606). Pero dos alias de la misma
--     familia pueden medir cosas distintas: `InventoryNet` es el inventario y
--     `InventoryFinishedGoods` una de sus partes. Sin rango, la vista los
--     mezclaba y marcaba como re-expresión lo que era diferencia entre tags —
--     el 100% de los inventarios de LULU salía `revisado` en falso. Con rango,
--     por periodo gana UN tag y las revisiones se cuentan dentro de ése.
--
--   · `accession_aux` + su CHECK — un Q4 no existe como hecho: se deriva
--     FY − 9M. Depende de DOS filings, así que necesita DOS citas. El CHECK
--     vuelve invariante lo que si no sería una buena intención: un derivado
--     sin su segunda cita no entra a la tabla.
--
--   · `period_start_k` — columna generada. La clave natural incluye
--     `period_start`, que es NULL en los instantes (inventario, caja), y un
--     único sobre columna nullable no sirve para `on conflict`. Con la
--     generada el upsert apunta a columnas planas.
--
-- Y una que sí estaba en el memo y se sostiene: `accession` va en la CLAVE,
-- no como columna decorativa. Un mismo periodo presentado dos veces con dos
-- valores son DOS filas, no un update — esa es la materia prima de la
-- pregunta 3, no ruido a limpiar.
-- ═══════════════════════════════════════════════════════════════

create table if not exists company_emisor (
  cik            text primary key,
  ticker         text,
  nombre         text,
  forma_anual    text,                    -- '10-K' | '20-F' | '40-F'
  cobertura      text not null default 'completa'
                 check (cobertura in ('completa', 'parcial')),
  sic            text,
  estado         text not null default 'pendiente',
  intentos       int  not null default 0,
  ultima_ingesta timestamptz,
  error_msg      text,
  actualizado_en timestamptz not null default now()
);

create index if not exists company_emisor_ticker on company_emisor (ticker);

create table if not exists company_filings (
  cik         text not null,
  accession   text not null,
  form        text not null,
  items_raw   text not null default '',
  filed       date not null,
  report_date date,
  primary_doc text,
  url         text not null,
  index_url   text not null,
  is_xbrl     boolean not null default false,
  size_bytes  bigint,
  ingested_at timestamptz not null default now(),
  primary key (cik, accession)
);

create index if not exists company_filings_cik_form on company_filings (cik, form, filed desc);

create table if not exists company_filing_items (
  cik       text not null,
  accession text not null,
  item      text not null,
  primary key (cik, accession, item),
  foreign key (cik, accession) references company_filings (cik, accession) on delete cascade
);

create index if not exists company_filing_items_item on company_filing_items (cik, item);

create table if not exists company_facts (
  id             bigserial primary key,
  cik            text not null,
  taxonomy       text not null,
  concept        text not null,
  familia        text,
  familia_rango  int,
  unit           text not null,
  period_start   date,
  period_end     date not null,
  period_start_k date generated always as (coalesce(period_start, date '1900-01-01')) stored,
  period_class   text not null,
  fy             int,
  fp             text,
  form           text,
  filed          date not null,
  accession      text not null,
  accession_aux  text,
  val            numeric not null,
  derived        boolean not null default false,
  ingested_at    timestamptz not null default now(),
  constraint company_facts_derivado_cita
    check (derived = false or accession_aux is not null),
  constraint company_facts_familia_rango
    check ((familia is null) = (familia_rango is null))
);

create unique index if not exists company_facts_natural on company_facts (
  cik, taxonomy, concept, unit, period_end, period_start_k, accession
);

create index if not exists company_facts_serie on company_facts (cik, familia, period_end desc);

create or replace view company_quarterly as
with elegido as (
  -- Por periodo gana UN tag: el mejor rankeado que tenga dato. Dentro de
  -- ese tag, la presentación más reciente. Nunca se mezclan dos alias en
  -- el mismo periodo.
  select distinct on (cik, familia, period_end)
         cik, familia, taxonomy, concept, familia_rango, unit,
         period_start, period_end, val, accession, accession_aux,
         filed, form, derived
    from company_facts
   where familia is not null
     and period_class = 'Q'
   order by cik, familia, period_end, familia_rango asc, filed desc, accession desc
),
versiones as (
  -- Las revisiones se cuentan DENTRO del tag elegido. Contarlas por
  -- familia marcaría como re-expresión lo que es diferencia entre alias.
  select f.cik, f.familia, f.period_end, count(distinct f.val) as versiones
    from company_facts f
    join elegido e
      on  f.cik = e.cik
      and f.familia = e.familia
      and f.period_end = e.period_end
      and f.taxonomy = e.taxonomy
      and f.concept = e.concept
      and f.unit = e.unit
   where f.period_class = 'Q'
   group by 1, 2, 3
),
serie as (
  select e.*,
         (v.versiones > 1) as revisado,
         lag(e.val, 4)        over w as val_hace_un_anio,
         lag(e.period_end, 4) over w as fin_hace_un_anio
    from elegido e
    join versiones v
      on v.cik = e.cik and v.familia = e.familia and v.period_end = e.period_end
  window w as (partition by e.cik, e.familia order by e.period_end)
)
select s.*,
       case
         -- Cuatro filas atrás no es un año atrás si falta un trimestre.
         -- Sin el trimestre correcto no hay YoY, y eso se dice con null.
         when s.fin_hace_un_anio is null then null
         when (s.period_end - s.fin_hace_un_anio) not between 330 and 400 then null
         -- Un YoY sobre base negativa o cero no es interpretable: el PM
         -- leería un porcentaje que no significa lo que parece.
         when s.val_hace_un_anio is null or s.val_hace_un_anio <= 0 then null
         else round(100.0 * (s.val - s.val_hace_un_anio) / s.val_hace_un_anio, 1)
       end as yoy_pct
  from serie s;

create or replace view company_cobertura as
select e.cik,
       e.ticker,
       e.nombre,
       e.forma_anual,
       e.cobertura,
       (e.cobertura = 'completa') as cuenta_para_cobertura,
       n.familia,
       count(q.period_end) filter (
         where q.period_end >= (current_date - interval '3 years')
       ) as trimestres_3a
  from company_emisor e
  cross join (values ('ingresos'), ('margen'), ('inventario'), ('neto')) as n(familia)
  left join company_quarterly q
    on q.cik = e.cik and q.familia = n.familia
 group by e.cik, e.ticker, e.nombre, e.forma_anual, e.cobertura, n.familia;

-- ═════════════════════════════════════════════════════════════════════════
-- La narración (Fase B)
--
-- La clave es (cik, hash) y el hash cubre la evidencia, la VERSIÓN DEL PROMPT
-- y el MODELO. Un filing nuevo cambia el hash; una línea del prompt también.
-- Abrir la página no cambia nada — que es el punto entero.
--
-- `crudo` guarda la respuesta del modelo SIEMPRE, incluso cuando el estado no
-- es 'ok': si un guardia la rechaza hay que poder ver qué dijo, no solamente
-- que la rechazó.
-- ═════════════════════════════════════════════════════════════════════════
create table if not exists company_narracion (
     cik            text not null,
     hash           text not null,
     estado         text not null,
     prompt_version int  not null,
     modelo         text not null,
     huella_prompt  text not null,
     secciones      jsonb,
     crudo          jsonb,
     costo          jsonb,
     detalle        text,
     evidencia_bytes int,
     creado_en      timestamptz not null default now(),
     primary key (cik, hash)
   );

create index if not exists company_narracion_servible
     on company_narracion (cik, creado_en desc) where estado = 'ok';
