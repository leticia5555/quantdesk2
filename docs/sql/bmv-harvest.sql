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
--   · UNA FILA POR SERIE. El probe reveló que /v2/historicos se pide por
--     `emisora_serie` (WALMEX*, FEMSAUBD, LIVEPOLC-1, NAFTRAC ISHRS) y que una
--     emisora puede cotizar varias. Los FINANCIEROS siguen siendo por emisora
--     —ese endpoint no conoce series—, así que `emisora` se queda como columna
--     aparte y es por donde se cruzan precios y financieros.
--   · Las migraciones al final van como ALTER y no como CREATE porque las tablas
--     YA existen en prod: el probe corrió ensureBmvSchema() y las creó con la
--     forma vieja, vacías. Un `create table if not exists` no las tocaría.
--   · bmv_distribuciones — la llave de fecha que manda la API es la de PAGO;
--     la EX viene en `fechaexcupon` y SOLO en el bloque "reciente". Todo el
--     historico llega sin ella, asi que se aproxima (pago - 3 dias, el delta
--     observado en NAFTRAC) y la fila queda MARCADA con ex_aproximada. Se
--     re-llavea por (emisora_serie, fecha_pago) y no por fecha_ex: la de pago
--     es la que la fuente garantiza siempre, y con la ex de llave una
--     aproximacion podria chocar con una ex real y perderse una fila.
--     `tipo` y `divisa` se guardan para no asumirlos: un reparto en especie
--     no es efectivo, y una divisa que no sea MXN exige convertir.
--     `pago_consolidado` marca las filas donde DOS pagos del mismo dia se
--     sumaron. Los bloques "reciente" e "historico" se traslapan, y mandar la
--     misma llave dos veces en un INSERT tumba la sentencia entera con
--     "ON CONFLICT DO UPDATE command cannot affect row a second time".
--   · bmv_emisoras.fin_periodos — la ENUMERACIÓN de trimestres reportados.
--     `rango_financieros` llega como lista ("1T_2017, 1T_2018, ..., 2T_2016")
--     y puede tener huecos: un hueco no es un trimestre que valga un request,
--     ni uno en el que la emisora deba entrar al universo. La lista permite
--     pedir solo lo que existe; fin_desde/fin_hasta son sus extremos, sacados
--     en orden CRONOLOGICO porque la API la manda en orden lexicografico.
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

alter table bmv_emisoras add column if not exists fin_periodos jsonb;

alter table bmv_emisoras add column if not exists serie text;

alter table bmv_emisoras add column if not exists emisora_serie text;

update bmv_emisoras set emisora_serie = emisora where emisora_serie is null;

alter table bmv_emisoras drop constraint if exists bmv_emisoras_pkey;

create unique index if not exists bmv_emisoras_serie_uidx on bmv_emisoras (emisora_serie);

create index if not exists bmv_emisoras_emisora_idx on bmv_emisoras (emisora);

alter table bmv_precios add column if not exists emisora_serie text;

update bmv_precios set emisora_serie = emisora where emisora_serie is null;

alter table bmv_precios drop constraint if exists bmv_precios_pkey;

create unique index if not exists bmv_precios_uidx on bmv_precios (emisora_serie, fecha);

create index if not exists bmv_precios_emisora_idx on bmv_precios (emisora);

alter table bmv_distribuciones add column if not exists emisora_serie text;

update bmv_distribuciones set emisora_serie = emisora where emisora_serie is null;

alter table bmv_distribuciones drop constraint if exists bmv_distribuciones_pkey;

alter table bmv_distribuciones add column if not exists fecha_pago date;

alter table bmv_distribuciones add column if not exists ex_aproximada boolean;

alter table bmv_distribuciones add column if not exists tipo text;

alter table bmv_distribuciones add column if not exists divisa text;

alter table bmv_distribuciones add column if not exists es_efectivo boolean;

alter table bmv_distribuciones add column if not exists pago_consolidado boolean;

update bmv_distribuciones set fecha_pago = fecha_ex where fecha_pago is null;

drop index if exists bmv_distribuciones_uidx;

create unique index if not exists bmv_distribuciones_pago_uidx on bmv_distribuciones (emisora_serie, fecha_pago);
