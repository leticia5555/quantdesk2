-- ═══════════════════════════════════════════════════════════════
-- docs/sql/bmv-harvest.sql — tablas de la cosecha DataBursatil (Fase A).
--
-- No hace falta correrla a mano: `ensureBmvSchema()` de api/_lib/bmv-db.js
-- las crea solas en el primer request. Está acá para poder leerla, revisarla y
-- aplicarla en un entorno nuevo sin levantar la app.
--
-- TABLAS NUEVAS. `xbrl_reports` NO se toca: es la serie de Fase 1a y lo único
-- que produce la fecha REAL de publicación, que es justo lo que DataBursatil no
-- tiene (docs/historico-censo.md §2.1). Las dos series conviven y se cruzan por
-- (clave, año, trimestre) en Fase B.
--
-- Decisiones que vale la pena notar:
--   · bmv_emisoras.fin_desde/fin_hasta — el rango de `rango_financieros`. Es EL
--     dato point-in-time: define qué emisora existía en qué trimestre. Sin él,
--     el universo sería la lista de hoy mirada hacia atrás (survivorship bias),
--     y por eso las SUSPENDIDAS se guardan con su rango, no se filtran.
--   · bmv_emisoras.fin_motivo / hist_motivo — por qué NO se pudo parsear un
--     rango. Fail-closed: un rango que no se entiende queda NULL con el motivo
--     escrito, nunca se le inventa una fecha de nacimiento a una emisora.
--   · raw jsonb NOT NULL en emisoras y financieros — el original completo se
--     guarda SIEMPRE, aunque la normalización falle. Es lo que permite
--     re-parsear con un UPDATE sin gastar un solo crédito de la API.
--   · bmv_financieros PK (emisora, año, trimestre) — la idempotencia. Correr
--     el cosechador dos veces no duplica ni re-cobra.
--   · bmv_financieros.faltantes — qué campo no resolvió y por qué. Un campo
--     ausente o AMBIGUO queda NULL con motivo; nunca un cero ni un proxy.
--   · bmv_precios sin raw — a ~2,700 días × 30 emisoras, guardar el crudo por
--     día multiplicaría la tabla sin aportar nada: la fila YA es el dato.
--   · bmv_harvest_ledger — qué se pidió y cómo salió. Es lo que hace la cosecha
--     reanudable y lo que contesta "¿dónde se quedó?" al agotarse los créditos.
--     Ojo con 'vacio' ≠ 'error': un trimestre sin reporte es un hecho del
--     mundo, se marca resuelto y no se vuelve a pedir.
--   · bmv_api_budget.mes — el mes en hora de CDMX, no UTC. Los créditos se
--     reponen el día 1 a las 00:01 CDMX; con el mes UTC, las primeras 6 horas
--     del día 1 caerían en el mes anterior.
--   · bmv_distribuciones — repartos de TODAS las emisoras por fecha EX-CUPÓN. Llegan
--     dentro de la respuesta de /v2/emisoras, así que no cuestan un request.
--     Existen porque los DOS lados son de RETORNO TOTAL: el benchmark (su
--     precio pelón resta ~3%/año) y la canasta (medirla a precio contra un
--     benchmark total sería el mismo error con el signo volteado). La fecha es
--     la EX, no la de pago: reinvertir en la de pago adelantaría el flujo y
--     metería look-ahead por la puerta de atrás.
--   · bmv_meta — el contrato de la API DESCUBIERTO por ?job=probe. Vive en la
--     DB porque se descubre en prod (el sandbox no alcanza la API) y porque
--     corregirlo no debe exigir un deploy a media cosecha.
-- ═══════════════════════════════════════════════════════════════

create table if not exists bmv_emisoras (
     emisora            text primary key,
     razon_social       text,
     tipo_valor_id      text,
     estatus            text,
     fin_desde          text,        -- '2016-2'  (rango_financieros)
     fin_hasta          text,        -- '2026-2'
     fin_motivo         text,        -- por qué no se pudo parsear, si no se pudo
     hist_desde         date,        -- rango_historicos
     hist_hasta         date,
     hist_motivo        text,
     raw                jsonb not null,
     actualizado_at     timestamptz not null default now()
   );

create table if not exists bmv_financieros (
     emisora        text not null,
     anio           int  not null,
     trimestre      int  not null check (trimestre between 1 and 4),
     fecha_cierre   date not null,
     raw            jsonb not null,
     revenue                                  numeric,
     profitlossattributabletoownersofparent   numeric,
     basicearningslosspershare                numeric,
     assets                                   numeric,
     liabilities                              numeric,
     equity                                   numeric,
     cashandcashequivalents                   numeric,
     faltantes      jsonb,
     cosechado_at   timestamptz not null default now(),
     primary key (emisora, anio, trimestre)
   );

create table if not exists bmv_precios (
     emisora   text not null,
     fecha     date not null,
     cierre    numeric,
     apertura  numeric,
     maximo    numeric,
     minimo    numeric,
     volumen   numeric,
     importe   numeric,
     primary key (emisora, fecha)
   );

create table if not exists bmv_distribuciones (
     emisora    text not null,
     fecha_ex   date not null,
     monto      numeric not null,
     cosechado_at timestamptz not null default now(),
     primary key (emisora, fecha_ex)
   );

create table if not exists bmv_harvest_ledger (
     job            text not null,          -- 'financieros' | 'historicos' | 'emisoras'
     emisora        text not null,
     clave          text not null,          -- '2016-2' | 'AAAA-MM-DD..AAAA-MM-DD'
     estado         text not null default 'pendiente',  -- pendiente|hecho|vacio|error
     intentos       int  not null default 0,
     filas          int  not null default 0,
     requests       int  not null default 0,
     error_msg      text,
     actualizado_at timestamptz not null default now(),
     primary key (job, emisora, clave)
   );

create table if not exists bmv_api_budget (
     mes            text primary key,       -- '2026-09', mes CDMX (el reset es 00:01 CDMX)
     requests       int not null default 0,
     creditos       int not null default 0,
     headers        jsonb,                  -- último saldo que la API haya publicado
     actualizado_at timestamptz not null default now()
   );

create table if not exists bmv_meta (
     key        text primary key,
     value      jsonb,
     nota       text,
     updated_at timestamptz not null default now()
   );

create index if not exists bmv_financieros_periodo_idx
     on bmv_financieros (anio desc, trimestre desc, emisora);

create index if not exists bmv_precios_fecha_idx
     on bmv_precios (fecha);

create index if not exists bmv_ledger_estado_idx
     on bmv_harvest_ledger (job, estado);
