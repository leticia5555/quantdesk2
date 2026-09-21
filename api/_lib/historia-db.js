// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-db.js — el esquema y los upserts de HISTORIA.
//
// Tres tablas, una de emisores que además hace de ledger del goteo, y dos
// vistas. Sobre la frontera de _lib/db.js (Neon, SQL sobre HTTP), como
// pead-db.js. Acá no se baja nada de EDGAR —eso es api/_lib/edgar.js— ni se
// interpreta un companyfacts: esto recibe filas ya normalizadas y las guarda
// sin perderlas ni deformarlas.
//
// El diseño sale del memo (docs/historia-fase0.md §5) con TRES correcciones
// que la corrida 2 obligó (§11). Las tres valen la pena entenderlas porque
// cada una era un dato correcto que afirmaba algo falso.
//
// ── 1. EL ALIAS NO ES UNA RE-EXPRESIÓN ──────────────────────────────
// La familia une los alias de un concepto porque la serie real cruza el
// cambio de taxonomía (ASC 606 partió `Revenues` en
// `RevenueFromContractWithCustomer…`). Pero unir alias y después contar
// "cuántos valores distintos tiene este periodo" mezcla dos cosas que no son
// la misma: una re-expresión de verdad, y dos tags que miden cosas distintas.
//
// La corrida 2 lo dejó ver: TODA familia de dos tags salió revisada al 100%
// —LULU inventario 12/12, MSFT deuda 12/12— y las de un tag salieron en cero
// o en tres. `InventoryNet` e `InventoryFinishedGoods` TIENEN que diferir:
// uno es el inventario y el otro una de sus partes. La vista del memo habría
// mandado al PM del Arena un `revisado` falso en el 100% de los inventarios
// de LULU.
//
// El arreglo tiene dos mitades y las dos importan:
//   · **Por periodo gana UN tag**, el mejor rankeado que tenga dato. El rango
//     viaja en la fila (`familia_rango`), puesto en la ingesta. La serie
//     todavía puede cambiar de tag entre periodos —eso es justo lo que la
//     familia existe para permitir— pero dentro de un periodo nunca se
//     mezclan dos.
//   · **Las revisiones se cuentan DENTRO del tag elegido**, nunca por familia.
//
// ── 2. UN Q4 DERIVADO TIENE DOS FUENTES, ASÍ QUE DOS CITAS ──────────
// Q4 no existe como hecho: se deriva `FY − 9M`. Ese valor depende de DOS
// filings, el 10-K y el último 10-Q. Con una sola columna `accession` se
// mostraría citando el 10-K, y la mitad de la resta quedaría sin respaldo:
// una afirmación citada a medias, que es la clase de cosa que este módulo
// existe para no producir. Por eso `accession_aux`, y un CHECK que lo vuelve
// invariante: `derived = true` sin `accession_aux` no entra a la tabla.
//
// ── 3. EL YoY NO SE CALCULA CONTANDO CUATRO FILAS ───────────────────
// `lag(val, 4)` asume que cuatro filas atrás es un año atrás. Con un
// trimestre faltante compara contra el periodo equivocado y nadie se entera:
// el número sale bien formado y dice otra cosa. Es exactamente la doctrina de
// ai-guard.js —la aritmética de calendario se resuelve antes y se verifica, no
// se delega— aplicada al SQL. La vista trae el `period_end` de la fila
// comparada y solo emite `yoy_pct` si está a 330–400 días. Si no, null: sin
// YoY es honesto, un YoY contra el trimestre equivocado no.
//
// ── LO QUE NO ESTÁ PROBADO ACÁ, Y SE DICE ───────────────────────────
// Este contenedor no tiene DATABASE_URL, así que **ninguna vista corrió
// contra Postgres**. Lo que la suite prueba es el SQL que se genera y los
// parámetros que viajan —con el ejecutor inyectado, igual que edgar.js
// inyecta su fetch— más las invariantes del catálogo de familias. Que las
// vistas devuelvan lo correcto se gana en G7 (§10 del memo), cuando la
// ingesta de la rebanada C corra contra Neon.
//
// **Este PR no toca el Arena.** `company_quarterly` se crea y se queda ahí;
// quién la conecte al PM es otra decisión y otro PR.
// ═══════════════════════════════════════════════════════════════

import { sql as sqlReal, sqlBatch as sqlBatchReal } from './db.js';

// ─────────────────────────────────────────────────────────────────────────
// El catálogo de familias. El ORDEN de `tags` es el rango: el primero gana
// cuando un periodo tiene varios. No es alfabético ni histórico — es cuál de
// los alias es el concepto que la familia dice medir.
//
// `tipo`: 'duracion' (tiene period_start, se clasifica Q/9M/FY) o 'instante'
// (un corte, sin inicio: inventario, caja, deuda, acciones).
// ─────────────────────────────────────────────────────────────────────────
export const FAMILIAS = [
  {
    id: 'ingresos', pregunta: 3, tipo: 'duracion',
    // Excluding gana: es la venta neta de impuestos recaudados, que es lo que
    // el estado de resultados llama "revenue". Including suma un impuesto que
    // la empresa solo recauda — mismo periodo, otro número, y por eso MELI
    // salió con 19 "revisiones" que no son re-expresiones (§11).
    tags: ['RevenueFromContractWithCustomerExcludingAssessedTax',
           'RevenueFromContractWithCustomerIncludingAssessedTax',
           'Revenues', 'SalesRevenueNet'],
    ifrs: ['Revenue', 'RevenueFromContractsWithCustomers'],
  },
  {
    id: 'costo', pregunta: 3, tipo: 'duracion',
    tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
    ifrs: ['CostOfSales'],
  },
  { id: 'margen', pregunta: 3, tipo: 'duracion', tags: ['GrossProfit'], ifrs: ['GrossProfit'] },
  {
    id: 'sgya', pregunta: 3, tipo: 'duracion',
    tags: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
    ifrs: ['SellingGeneralAndAdministrativeExpense'],
  },
  { id: 'op', pregunta: 3, tipo: 'duracion', tags: ['OperatingIncomeLoss'], ifrs: ['ProfitLossFromOperatingActivities'] },
  { id: 'neto', pregunta: 3, tipo: 'duracion', tags: ['NetIncomeLoss', 'ProfitLoss'], ifrs: ['ProfitLoss'] },
  {
    id: 'eps', pregunta: 3, tipo: 'duracion',
    tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
    ifrs: ['DilutedEarningsLossPerShare'],
  },
  {
    id: 'inventario', pregunta: 3, tipo: 'instante',
    // FinishedGoods es una PARTE del inventario, no otra medición del mismo:
    // solo entra cuando InventoryNet no existe para ese corte.
    tags: ['InventoryNet', 'InventoryFinishedGoods'],
    ifrs: ['Inventories'],
  },
  {
    id: 'caja', pregunta: 3, tipo: 'instante',
    // La corrida 2 encontró a LULU con CERO conceptos de caja (§11). No es
    // que no reporte efectivo: usa el tag posterior a ASU 2016-18, que suma
    // el efectivo restringido y que esta lista no tenía. En la página eso
    // habría sido un "sin documentos" FALSO, que es peor que un hueco porque
    // parece honesto. Va de segundo: incluye restringido, así que solo entra
    // cuando el tag limpio no está.
    tags: ['CashAndCashEquivalentsAtCarryingValue',
           'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    ifrs: ['CashAndCashEquivalents'],
  },
  {
    id: 'deuda', pregunta: 3, tipo: 'instante',
    // LongTermDebt es el total; Noncurrent deja afuera la porción corriente.
    // El total primero, la parte como respaldo.
    tags: ['LongTermDebt', 'LongTermDebtNoncurrent'],
    ifrs: ['NoncurrentPortionOfNoncurrentBorrowings'],
  },
  {
    id: 'acciones', pregunta: 2, tipo: 'instante',
    tags: ['CommonStockSharesOutstanding'],
    dei: ['EntityCommonStockSharesOutstanding'],
    ifrs: ['NumberOfSharesOutstanding'],
  },
];

// El núcleo que evalúa la cobertura. Es el mismo de G1 (§4 del memo), y la
// vista de cobertura lo repite en SQL: si cambia acá, cambia allá.
export const NUCLEO = ['ingresos', 'margen', 'inventario', 'neto'];

// (taxonomía, concepto) → { familia, rango }. El rango arranca en 1 y el 1 es
// el que gana. Un concepto que no mapea devuelve null y se guarda igual, con
// `familia` en null: el hecho crudo no se tira, simplemente no arma serie.
const INDICE_FAMILIAS = (() => {
  const m = new Map();
  for (const f of FAMILIAS) {
    const porTaxonomia = [['us-gaap', f.tags || []], ['dei', f.dei || []], ['ifrs-full', f.ifrs || []]];
    for (const [taxonomia, tags] of porTaxonomia) {
      tags.forEach((tag, i) => {
        const clave = `${taxonomia}:${tag}`;
        // Un mismo tag en dos familias sería ambigüedad silenciosa: gana la
        // primera y se deja anotado en el test, no acá.
        if (!m.has(clave)) m.set(clave, { familia: f.id, rango: i + 1, tipo: f.tipo });
      });
    }
  }
  return m;
})();

export function mapearConcepto(taxonomia, concepto) {
  return INDICE_FAMILIAS.get(`${taxonomia}:${concepto}`) || null;
}

// ═════════════════════════════════════════════════════════════════════════
// El esquema
// ═════════════════════════════════════════════════════════════════════════

export const HISTORIA_SCHEMA = [
  // Emisores. Hace de catálogo (ticker → cik), de etiqueta de cobertura (G6)
  // y de ledger del goteo: la decisión 1 de §10 es ingesta reanudable por
  // cron porque la corrida 2 midió 42 s por ticker y un lambda de 60 s no
  // alcanza para uno solo.
  `create table if not exists company_emisor (
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
   )`,
  `create index if not exists company_emisor_ticker on company_emisor (ticker)`,

  // El índice de filings. `items_raw` guarda la cadena cruda por fidelidad;
  // la tabla hija la vuelve consultable.
  `create table if not exists company_filings (
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
   )`,
  `create index if not exists company_filings_cik_form on company_filings (cik, form, filed desc)`,

  // Un renglón por item. Con `item` singular, "dame los 8-K con 5.02" sería
  // un like '%5.02%' que también matchea 15.02.
  `create table if not exists company_filing_items (
     cik       text not null,
     accession text not null,
     item      text not null,
     primary key (cik, accession, item),
     foreign key (cik, accession) references company_filings (cik, accession) on delete cascade
   )`,
  `create index if not exists company_filing_items_item on company_filing_items (cik, item)`,

  // Los hechos XBRL.
  //
  // `period_start_k` es columna generada y existe por una razón práctica: la
  // clave natural incluye period_start, que es NULL en los instantes, y un
  // índice único sobre una columna nullable no sirve para `on conflict`.
  // Con la generada, el upsert apunta a columnas planas y no a una expresión.
  //
  // El CHECK de `derived` es la invariante de la cita: un Q4 derivado sale de
  // FY − 9M, depende de dos filings, y sin la segunda cita la mitad de la
  // resta no tiene respaldo.
  `create table if not exists company_facts (
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
   )`,
  `create unique index if not exists company_facts_natural on company_facts (
     cik, taxonomy, concept, unit, period_end, period_start_k, accession
   )`,
  `create index if not exists company_facts_serie on company_facts (cik, familia, period_end desc)`,

  // ── La vista del gancho al Arena ────────────────────────────────────
  // Una fila por (cik, familia, trimestre) con las tres cosas difíciles ya
  // resueltas: qué tag manda, cuál es la última palabra de la empresa, y el
  // YoY — o ningún YoY, si el trimestre de comparación no está donde debería.
  `create or replace view company_quarterly as
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
     from serie s`,

  // ── La regla del 20-F, ejecutable ───────────────────────────────────
  // El encargo: el emisor extranjero sale del CÁLCULO DE COBERTURA, no del
  // módulo. Se ingiere, se muestra y se etiqueta "cobertura parcial" (§8).
  // `cuenta_para_cobertura` es esa regla escrita una sola vez: quien mida
  // cobertura filtra por ella en vez de reimplementar el criterio.
  `create or replace view company_cobertura as
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
    group by e.cik, e.ticker, e.nombre, e.forma_anual, e.cobertura, n.familia`,

  // ── La narración (Fase B) ────────────────────────────────────────────
  //
  // La clave es `(cik, hash)` y el hash cubre la evidencia, la VERSIÓN DEL
  // PROMPT y el MODELO. Un filing nuevo cambia el hash; una línea del prompt
  // también. Abrir la página no cambia nada — que es el punto entero.
  //
  // `crudo` guarda la respuesta del modelo SIEMPRE, incluso cuando el estado
  // no es 'ok': si un guardia la rechaza hay que poder ver qué dijo, no
  // solamente que la rechazó. Por eso `secciones` es nullable y `crudo` no
  // depende de que la narración sirva.
  //
  // `estado` distingue los finales: 'ok' · 'cortada' (llegó al techo de
  // tokens y se lee como completa, que es el modo de falla peligroso) ·
  // 'rechazo_modelo' · 'json_invalido' · 'modelo_distinto' · 'http' · 'red'
  // · y los que agregue el guardia de citas.
  `create table if not exists company_narracion (
     cik            text not null,
     hash           text not null,
     estado         text not null,
     prompt_version int  not null,
     modelo         text not null,
     huella_prompt  text not null,
     secciones      jsonb,
     -- Lo que el guardia de la rebanada I cortó, con su motivo y el texto.
     -- No es opcional: es lo que la página muestra para que el hueco quede
     -- declarado. Un hueco declarado es un dato; uno silencioso es un bug.
     cortes         jsonb,
     crudo          jsonb,
     costo          jsonb,
     detalle        text,
     evidencia_bytes int,
     -- Cuántas llamadas se pagaron por esta fila. Una narración cortada se
     -- reintenta UNA vez con el techo al doble y después se para: sin el
     -- conteo, cada lectura de la página dispararía dos llamadas nuevas.
     intentos       int not null default 1,
     creado_en      timestamptz not null default now(),
     primary key (cik, hash)
   )`,
  // Para "dame la última narración servible de este emisor" sin escanear.
  `create index if not exists company_narracion_servible
     on company_narracion (cik, creado_en desc) where estado = 'ok'`,
];

// ═════════════════════════════════════════════════════════════════════════
// El repositorio. El ejecutor entra por parámetro, igual que el `fetch` de
// edgar.js: sin DATABASE_URL en este contenedor, es la única forma de que los
// upserts estén probados y no solo escritos.
// ═════════════════════════════════════════════════════════════════════════

// Cuántas filas por sentencia. companyfacts de MELI trae 627 conceptos y
// miles de hechos: un insert único sería un cuerpo HTTP enorme y un error de
// una fila tiraría la transacción entera.
export const FILAS_POR_SENTENCIA = 500;

const trozos = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Arma `($1, $2, …), ($n+1, …)` y el arreglo plano de parámetros.
function valores(filas, columnas) {
  const params = [];
  const tuplas = filas.map((fila) => {
    const marcas = columnas.map((col) => {
      params.push(fila[col] === undefined ? null : fila[col]);
      return `$${params.length}`;
    });
    return `(${marcas.join(', ')})`;
  });
  return { tuplas: tuplas.join(', '), params };
}

const COLS_FILING = ['cik', 'accession', 'form', 'items_raw', 'filed', 'report_date',
  'primary_doc', 'url', 'index_url', 'is_xbrl', 'size_bytes'];
const COLS_FACT = ['cik', 'taxonomy', 'concept', 'familia', 'familia_rango', 'unit',
  'period_start', 'period_end', 'period_class', 'fy', 'fp', 'form', 'filed',
  'accession', 'accession_aux', 'val', 'derived'];

export function crearRepo({ sql = sqlReal, sqlBatch = sqlBatchReal } = {}) {
  let esquemaListo = false;

  async function asegurarEsquema() {
    if (esquemaListo) return;
    await sqlBatch(HISTORIA_SCHEMA.map((q) => [q, []]));
    esquemaListo = true;
  }

  return {
    asegurarEsquema,

    // Idempotente por (cik). Re-ingerir actualiza el perfil y el ledger sin
    // perder `intentos`, que es lo que permite ver a un emisor que falla
    // siempre en vez de uno que falló una vez.
    async guardarEmisor(e) {
      const filas = await sql(
        `insert into company_emisor (cik, ticker, nombre, forma_anual, cobertura, sic, estado, actualizado_en)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (cik) do update set
           ticker = excluded.ticker,
           nombre = excluded.nombre,
           forma_anual = excluded.forma_anual,
           cobertura = excluded.cobertura,
           sic = coalesce(excluded.sic, company_emisor.sic),
           estado = excluded.estado,
           actualizado_en = now()
         returning cik`,
        [e.cik, e.ticker || null, e.nombre || null, e.formaAnual || null,
          e.cobertura || 'completa', e.sic || null, e.estado || 'pendiente'],
      );
      return filas.length;
    },

    // Un filing es inmutable una vez presentado, pero el índice sí puede
    // corregirse (un `primaryDocument` que faltaba, un item agregado). Por eso
    // `do update` y no `do nothing`: la última lectura de EDGAR manda.
    async guardarFilings(filings) {
      if (!filings || !filings.length) return 0;
      const sentencias = trozos(filings, FILAS_POR_SENTENCIA).map((lote) => {
        const { tuplas, params } = valores(lote, COLS_FILING);
        return [
          `insert into company_filings (${COLS_FILING.join(', ')})
           values ${tuplas}
           on conflict (cik, accession) do update set
             form = excluded.form,
             items_raw = excluded.items_raw,
             filed = excluded.filed,
             report_date = excluded.report_date,
             primary_doc = excluded.primary_doc,
             url = excluded.url,
             index_url = excluded.index_url,
             is_xbrl = excluded.is_xbrl,
             size_bytes = excluded.size_bytes`,
          params,
        ];
      });
      await sqlBatch(sentencias);
      return filings.length;
    },

    // Los items de un filing se reemplazan en bloque: si EDGAR corrigió la
    // lista, dejar los viejos conviviendo con los nuevos inventaría items que
    // el filing ya no declara.
    async guardarItems(cik, accession, items) {
      const limpios = [...new Set((items || []).map((i) => String(i).trim()).filter(Boolean))];
      const sentencias = [[
        'delete from company_filing_items where cik = $1 and accession = $2',
        [cik, accession],
      ]];
      if (limpios.length) {
        const params = [];
        const tuplas = limpios.map((item) => {
          params.push(cik, accession, item);
          return `($${params.length - 2}, $${params.length - 1}, $${params.length})`;
        }).join(', ');
        sentencias.push([
          `insert into company_filing_items (cik, accession, item) values ${tuplas}
           on conflict (cik, accession, item) do nothing`,
          params,
        ]);
      }
      await sqlBatch(sentencias);
      return limpios.length;
    },

    // El upsert apunta a la clave natural. `period_start_k` es la columna
    // generada: se nombra en el conflicto pero NO se inserta — Postgres la
    // calcula, y pasarla sería un error de sintaxis, no un detalle.
    //
    // El CHECK de la tabla rechaza un derivado sin su segunda cita; esto lo
    // adelanta acá para que el error diga qué fila y no "violación de
    // restricción" sobre un lote de 500.
    async guardarFacts(facts) {
      if (!facts || !facts.length) return 0;
      for (const f of facts) {
        if (f.derived && !f.accession_aux) {
          throw new Error(
            `company_facts: hecho derivado sin accession_aux (${f.cik} ${f.concept} ${f.period_end}). ` +
            'Un Q4 derivado sale de FY − 9M y necesita las dos citas.',
          );
        }
        if ((f.familia == null) !== (f.familia_rango == null)) {
          throw new Error(
            `company_facts: familia y familia_rango tienen que venir juntos o ninguno (${f.cik} ${f.concept}).`,
          );
        }
      }
      // Dos filas del MISMO lote con la clave natural repetida hacen que
      // Postgres rechace el INSERT entero con "ON CONFLICT DO UPDATE command
      // cannot affect row a second time" — un mensaje que no dice qué fila ni
      // de qué emisor, y que costó dos emisores completos en el primer goteo.
      // La ingesta ya deduplica (historia-ingesta.js), así que llegar acá con
      // la clave repetida es un bug de quien llama: se dice cuál es.
      const vistas = new Map();
      for (const f of facts) {
        const k = [f.cik, f.taxonomy, f.concept, f.unit, f.period_end, f.period_start || '1900-01-01', f.accession].join('|');
        if (vistas.has(k)) {
          throw new Error(
            `company_facts: dos filas del lote comparten la clave natural (${k}). ` +
            `Valores: ${vistas.get(k).val} y ${f.val}. Postgres rechazaría el lote entero; ` +
            'deduplicá antes de guardar (dedupePorClave en historia-ingesta.js).',
          );
        }
        vistas.set(k, f);
      }
      const sentencias = trozos(facts, FILAS_POR_SENTENCIA).map((lote) => {
        const { tuplas, params } = valores(lote, COLS_FACT);
        return [
          `insert into company_facts (${COLS_FACT.join(', ')})
           values ${tuplas}
           on conflict (cik, taxonomy, concept, unit, period_end, period_start_k, accession)
           do update set
             familia = excluded.familia,
             familia_rango = excluded.familia_rango,
             period_class = excluded.period_class,
             fy = excluded.fy,
             fp = excluded.fp,
             form = excluded.form,
             filed = excluded.filed,
             accession_aux = excluded.accession_aux,
             val = excluded.val,
             derived = excluded.derived`,
          params,
        ];
      });
      await sqlBatch(sentencias);
      return facts.length;
    },

    // Marca el final de una ingesta. El error se guarda con la fila, no en un
    // log que nadie mira: un emisor que falla siempre tiene que ser visible en
    // la misma tabla donde se elige a quién ingerir.
    async marcarIngesta(cik, { estado = 'ok', error = null } = {}) {
      await sql(
        `update company_emisor set
           estado = $2,
           error_msg = $3,
           intentos = intentos + 1,
           ultima_ingesta = case when $2 = 'ok' then now() else ultima_ingesta end,
           actualizado_en = now()
         where cik = $1`,
        [cik, estado, error],
      );
    },

    // Los próximos N emisores a ingerir: los que nunca se ingirieron primero,
    // después los más viejos. La frescura de la decisión 2 de §10 (diario
    // para cubiertos) se aplica con `masViejoQue`.
    async pendientes(limite = 7, { masViejoQue = null } = {}) {
      return sql(
        `select cik, ticker, nombre, cobertura, ultima_ingesta
           from company_emisor
          where ultima_ingesta is null
             or ($2::timestamptz is not null and ultima_ingesta < $2)
          order by ultima_ingesta asc nulls first, cik asc
          limit $1`,
        [limite, masViejoQue],
      );
    },

    // ── La narración ──────────────────────────────────────────────────
    //
    // Se guarda SIEMPRE, cualquiera sea el estado. Una narración rechazada no
    // es basura: es la evidencia de por qué se rechazó, y sin ella el guardia
    // es una caja negra que dice "no" sin mostrar qué vio.
    //
    // `on conflict do update` en vez de `do nothing`: si se vuelve a correr
    // el mismo hash —porque el primer intento fue 'http' o 'cortada'— el
    // segundo resultado tiene que pisar al primero. Dejar el error viejo
    // haría que un reintento exitoso no se vea.
    async guardarNarracion(n) {
      await sql(
        `insert into company_narracion
           (cik, hash, estado, prompt_version, modelo, huella_prompt,
            secciones, crudo, costo, detalle, evidencia_bytes)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
         on conflict (cik, hash) do update set
           estado = excluded.estado,
           secciones = excluded.secciones,
           cortes = excluded.cortes,
           crudo = excluded.crudo,
           costo = excluded.costo,
           detalle = excluded.detalle,
           evidencia_bytes = excluded.evidencia_bytes,
           -- Los intentos se ACUMULAN: la fila nueva trae los de esta corrida
           -- y se suman a los ya pagados. Pisarlos haría que el tope no
           -- llegara nunca y el reintento fuera infinito en cuotas.
           intentos = company_narracion.intentos + excluded.intentos,
           creado_en = now()`,
        [
          n.cik, n.hash, n.estado, n.prompt_version, n.modelo, n.huella_prompt,
          n.secciones ? JSON.stringify(n.secciones) : null,
          n.cortes ? JSON.stringify(n.cortes) : null,
          n.crudo ? JSON.stringify(n.crudo) : null,
          n.costo ? JSON.stringify(n.costo) : null,
          n.detalle ?? null,
          n.evidencia_bytes ?? null,
          n.intentos ?? 1,
        ],
      );
      return 1;
    },

    // ¿Existe la tabla donde se guarda lo que se va a pagar?
    //
    // Existe por un gasto perdido real (§11.7): con `forzar=1` la primera
    // lectura de company_narracion se saltea, así que el primer contacto con
    // la tabla era el GUARDADO — después de la llamada. La tabla no estaba,
    // la llamada se pagó, y la respuesta del modelo se perdió: el resguardo
    // vivía en la misma tabla que falló.
    //
    // `to_regclass` devuelve null en vez de tirar, que es lo que hace falta
    // para poder preguntar sin romper.
    async esquemaListo() {
      const filas = await sql("select to_regclass('company_narracion') is not null as listo");
      return !!(filas[0] && filas[0].listo);
    },

    // Lo que hubo en este hash, sirva o no. Es lo que deja (a) no reintentar
    // para siempre una narración que ya se pagó dos veces, y (b) decirle a la
    // página que la lectura FALLÓ, que no es lo mismo que que no exista.
    async intentoPrevio(cik, hash) {
      const filas = await sql(
        `select estado, intentos, detalle, creado_en
           from company_narracion where cik = $1 and hash = $2 limit 1`,
        [cik, hash],
      );
      return filas[0] || null;
    },

    // La lectura de la página: SOLO por hash y SOLO si sirve. Devolver la
    // última narración de este emisor sin mirar el hash serviría el texto de
    // un filing que ya cambió — un dato viejo con citas correctas, que es
    // indistinguible de uno bueno.
    async narracionPorHash(cik, hash) {
      // `ok_con_cortes` también sirve: el guardia cortó algo y lo que quedó
      // se muestra con el hueco declarado. Solo `rechazada` —no sobrevivió
      // ninguna sección— y los fallos de llamada quedan afuera.
      const filas = await sql(
        `select estado, prompt_version, modelo, secciones, cortes, costo, creado_en
           from company_narracion
          where cik = $1 and hash = $2 and estado in ('ok', 'ok_con_cortes')
          limit 1`,
        [cik, hash],
      );
      return filas[0] || null;
    },
  };
}

// El repo contra Neon, para quien no necesite inyectar nada.
export const repo = crearRepo();
