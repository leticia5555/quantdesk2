-- ═══════════════════════════════════════════════════════════════
-- docs/sql/xbrl-capture.sql — tabla de la captura trimestral del XBRL de BMV.
--
-- No hace falta correrla a mano: `ensureSchema()` de api/_lib/db.js la crea
-- sola en el primer request. Está acá para poder leerla, revisarla y aplicarla
-- en un entorno nuevo sin levantar la app.
--
-- Decisiones que vale la pena notar:
--   · raw_json NOT NULL — el original completo se guarda SIEMPRE, aunque los
--     campos normalizados fallen. Es lo que permite re-parsear sin volver a
--     BMV, que importa porque el trimestre vigente desaparece de la página.
--   · doc_id UNIQUE — la idempotencia. Correr el capturador dos veces no
--     duplica: el segundo insert cae en ON CONFLICT DO NOTHING.
--   · Cada uno de los 9 campos lleva su _tag, su _ventana y su _motivo. Un
--     campo que no validó queda NULL con el motivo escrito; nunca un número
--     que no pasó (fail-closed, decisión de Fase 0b).
--   · fecha_publicacion es la fecha-hora de ENVÍO que sale del listado de BMV
--     ("23-Jul-2026 14:11"), no una fecha del XBRL. Es la que evita look-ahead
--     (D8) y no existe dentro del archivo: si no se captura al bajar, se pierde.
-- ═══════════════════════════════════════════════════════════════

create table if not exists xbrl_reports (
  id                bigserial primary key,
  clave             text        not null,
  bmv_id            text        not null,
  doc_id            text        not null unique,
  anio              int         not null,
  trimestre         int         not null check (trimestre between 1 and 4),
  fecha_publicacion timestamptz,
  fecha_captura     timestamptz not null default now(),
  zip_url           text,
  entry_point       text,
  raw_json          jsonb       not null,
  ingresos                          numeric,
  ingresos_tag                      text,
  ingresos_ventana                  text,
  ingresos_motivo                   text,
  utilidad_neta_atribuible          numeric,
  utilidad_neta_atribuible_tag      text,
  utilidad_neta_atribuible_ventana  text,
  utilidad_neta_atribuible_motivo   text,
  activos_totales                   numeric,
  activos_totales_tag               text,
  activos_totales_ventana           text,
  activos_totales_motivo            text,
  pasivos_totales                   numeric,
  pasivos_totales_tag               text,
  pasivos_totales_ventana           text,
  pasivos_totales_motivo            text,
  capital_contable                  numeric,
  capital_contable_tag              text,
  capital_contable_ventana          text,
  capital_contable_motivo           text,
  efectivo                          numeric,
  efectivo_tag                      text,
  efectivo_ventana                  text,
  efectivo_motivo                   text,
  deuda_corto                       numeric,
  deuda_corto_tag                   text,
  deuda_corto_ventana               text,
  deuda_corto_motivo                text,
  deuda_largo                       numeric,
  deuda_largo_tag                   text,
  deuda_largo_ventana               text,
  deuda_largo_motivo                text,
  acciones_circulacion              numeric,
  acciones_circulacion_tag          text,
  acciones_circulacion_ventana      text,
  acciones_circulacion_motivo       text,
  capital_controladora     numeric,
  participacion_no_control numeric,
  arrendamientos_corto     numeric,
  arrendamientos_largo     numeric,
  identidades      jsonb,
  identidades_ok   boolean,
  alertas          jsonb
);

-- Consultas de uso frecuente.
create index if not exists xbrl_reports_clave_periodo_idx
  on xbrl_reports (clave, anio desc, trimestre desc);

create index if not exists xbrl_reports_publicacion_idx
  on xbrl_reports (fecha_publicacion desc);
