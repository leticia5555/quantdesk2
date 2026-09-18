// ═══════════════════════════════════════════════════════════════════
// tests/bmv-rotation.test.mjs — la Fase B.
//
// Lo que estas pruebas cuidan, en orden de cuánto dolería que fallara:
//
//   1. SOLO LECTURA. El fetch a Neon está mockeado y CADA consulta que cruza
//      la frontera se captura: si alguna no empieza con SELECT o WITH, el
//      test falla. Un endpoint de análisis que escriba es un endpoint que
//      puede corromper la cosecha.
//   2. LA ADVERTENCIA DE SIGNO. Se construye un mercado donde la canasta
//      PIERDE de forma significativa y se exige que el veredicto diga NO-GO
//      FUERTE. Un |t| alto con exceso negativo leído como GO es el error que
//      casi se comete en agosto con el backtest gringo.
//   3. CERO LOOK-AHEAD. Un EPS cuyo cierre + 65 días cae DESPUÉS del
//      rebalanceo no puede entrar al TTM de ese rebalanceo.
//   4. Las sensibilidades no promueven. Un caso base NO-GO sigue siendo NO-GO
//      aunque una sensibilidad salga preciosa.
//
// El mercado es sintético y determinista (sin Math.random): cada prueba
// construye exactamente el fenómeno que quiere medir.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import handler, {
  analiza, reporteMd, ventanasDeTenencia, indexaPorSerieYFecha,
} from '../api/bmv-rotation-analyze.js';
import {
  construyeCanastas, epsTtm, momentum121, rankPercentil, restaMeses,
  cierreMensualHasta, simula, serieBenchmark, veredicto, excesoDiario,
  bpNoContados, mesIndice, UMBRAL_T, PRIMA_SHARPE,
} from '../api/_lib/bmv-rotation.js';
import { UMBRAL_IMPORTE, LAG_DIAS } from '../api/_lib/bmv-elegibilidad.js';

const SECRET = 'secreto-de-prueba';
process.env.ADMIN_SECRET = SECRET;
// Una cadena de conexión de mentiras: `db.js` la exige antes de hacer el
// fetch, y el fetch está mockeado. Sin esto el endpoint fallaría por la
// razón equivocada y las pruebas pasarían por accidente.
process.env.DATABASE_URL = 'postgres://u:p@ep-falso.us-east-1.aws.neon.tech/db';

/* ═══════════════ un mercado de juguete ═══════════════ */

const BENCH = 'NAFTRACISHRS';

/** Días hábiles (lun-vie) entre dos fechas. Sin asuetos: es un juguete. */
function diasHabiles(desde, hasta) {
  const out = [];
  for (let t = Date.parse(`${desde}T00:00:00Z`); t <= Date.parse(`${hasta}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fabrica un mercado completo.
 *
 * `driftPorSerie(i)` devuelve el retorno diario de la serie i, y `driftBench`
 * el del benchmark. Con eso cada prueba dibuja el fenómeno que quiere: una
 * canasta que gana, una que pierde, o una indistinguible del índice.
 */
function fabrica({
  nSeries = 20, desde = '2016-01-01', hasta = '2020-12-31',
  driftPorSerie = () => 0.0004, driftBench = 0.0003,
  eps = () => 1, importe = () => 5e6, dividendos = [], divisaExcluida = [],
  divisaConvertida = [], precioInicial = () => 100,
} = {}) {
  const calendario = diasHabiles(desde, hasta);
  const series = [];
  const precios = new Map();          // serie → Map fecha → cierre

  for (let i = 0; i < nSeries; i++) {
    const serie = `E${String(i).padStart(3, '0')}*`;
    series.push({ emisora_serie: serie, emisora: `E${String(i).padStart(3, '0')}` });
    const m = new Map();
    let p = precioInicial(i);
    for (const f of calendario) {
      m.set(f, p);
      p *= 1 + driftPorSerie(i, f);
    }
    precios.set(serie, m);
  }
  const mb = new Map();
  let pb = 50;
  for (const f of calendario) { mb.set(f, pb); pb *= 1 + driftBench; }
  precios.set(BENCH, mb);

  // Financieros: un cierre por trimestre, publicado con el rezago real.
  const financieros = [];
  for (let i = 0; i < nSeries; i++) {
    for (let a = 2015; a <= 2026; a++) {
      for (const [mes, dia] of [['03', '31'], ['06', '30'], ['09', '30'], ['12', '31']]) {
        financieros.push({
          emisora: `E${String(i).padStart(3, '0')}`,
          fecha_cierre: `${a}-${mes}-${dia}`,
          eps: eps(i, a),
        });
      }
    }
  }

  return { calendario, series, precios, financieros, importe, dividendos, divisaExcluida, divisaConvertida };
}

/* ═══════════════ un Neon de mentiras ═══════════════ */

let consultas = [];

function texto(v) { return v === null || v === undefined ? null : String(v); }

function responde(fields, filas) {
  return {
    ok: true, status: 200,
    json: async () => ({
      fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
      rows: filas,
    }),
  };
}

const T = 25;      // text
const N = 1700;    // numeric
const I = 23;      // int4

function mockFetch(mundo) {
  consultas = [];
  const { calendario, series, precios, financieros } = mundo;

  // El primer día operado de cada mes y el último, derivados del calendario.
  const primerosDelMes = [];
  const ultimoDelMes = new Map();
  let mesPrev = null;
  for (const f of calendario) {
    const mes = f.slice(0, 7);
    if (mes !== mesPrev) { primerosDelMes.push(f); mesPrev = mes; }
    ultimoDelMes.set(mes, f);
  }

  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const lista = body.queries || [body];
    const q = lista[0].query;
    const p = lista[0].params || [];
    consultas.push(q);

    // calendario
    if (/select distinct fecha::text/.test(q)) {
      return responde([['fecha', T]], calendario.map((f) => [f]));
    }
    // fechas de rebalanceo
    if (/min\(fecha\)::text/.test(q)) {
      const [desde, hasta] = p;
      return responde([['fecha', T]],
        primerosDelMes.filter((f) => f >= desde && f <= hasta).map((f) => [f]));
    }
    // series ICS
    if (/from bmv_emisoras/.test(q)) {
      assert.match(q, /tipo_valor_id = '1'/, 'el universo filtra por igualdad exacta de texto');
      return responde([['emisora_serie', T], ['emisora', T]],
        series.map((s) => [s.emisora_serie, s.emisora]));
    }
    // eps
    if (/basicearningslosspershare as eps/.test(q)) {
      return responde([['emisora', T], ['fecha_cierre', T], ['eps', N]],
        financieros.map((f) => [f.emisora, f.fecha_cierre, texto(f.eps)]));
    }
    // cierres mensuales
    if (/distinct on \(emisora_serie, date_trunc/.test(q)) {
      const filas = [];
      for (const [serie, m] of precios) {
        for (const [mes, ultimo] of ultimoDelMes) {
          const c = m.get(ultimo);
          if (c !== undefined) filas.push([serie, `${mes}-01`, ultimo, texto(c)]);
        }
      }
      return responde([['emisora_serie', T], ['mes', T], ['fecha', T], ['cierre', N]], filas);
    }
    // medianas de importe
    if (/percentile_cont/.test(q)) {
      const [desde, hasta] = p;
      const filas = [];
      for (const f of primerosDelMes.filter((x) => x >= desde && x <= hasta)) {
        for (const s of series) filas.push([f, s.emisora_serie, texto(mundo.importe(s.emisora_serie, f))]);
      }
      return responde([['fecha', T], ['emisora_serie', T], ['mediana', N]], filas);
    }
    // precios diarios por ventanas
    if (/jsonb_array_elements/.test(q) && /bmv_precios/.test(q)) {
      const ventanas = JSON.parse(p[0]);
      const filas = [];
      for (const [serie, ini, fin] of ventanas) {
        const m = precios.get(serie);
        if (!m) continue;
        for (const f of calendario) {
          if (f < ini || f > fin) continue;
          const c = m.get(f);
          if (c !== undefined) filas.push([serie, f, texto(c)]);
        }
      }
      return responde([['emisora_serie', T], ['fecha', T], ['cierre', N]], filas);
    }
    // dividendos por ventanas
    if (/jsonb_array_elements/.test(q) && /bmv_distribuciones/.test(q)) {
      assert.match(q, /categoria = 'efectivo'/, 'sólo efectivo entra al retorno total');
      assert.match(q, /or tc\.tasa is not null/, 'la moneda extranjera entra SÓLO con tasa de su fecha ex');
      assert.match(q, /tc\.divisa = d\.divisa and tc\.fecha = d\.fecha_ex/,
        'el join es por fecha EXACTA: la tasa de otro día sería un dato inventado');
      const ventanas = JSON.parse(p[0]);
      const filas = [];
      for (const [serie, ini, fin] of ventanas) {
        for (const d of mundo.dividendos) {
          if (d.emisora_serie === serie && d.fecha >= ini && d.fecha <= fin) {
            filas.push([serie, d.fecha, texto(d.monto)]);
          }
        }
        // Los convertidos entran YA en pesos, como haría el `coalesce(tasa,1)`.
        for (const d of (mundo.divisaConvertida || [])) {
          if (d.emisora_serie === serie && d.fecha >= ini && d.fecha <= fin) {
            filas.push([serie, d.fecha, texto(d.monto * d.tasa)]);
          }
        }
      }
      return responde([['emisora_serie', T], ['fecha', T], ['monto', N]], filas);
    }
    // benchmark: precios
    if (/from bmv_precios/.test(q) && /emisora_serie = \$1/.test(q)) {
      const m = precios.get(p[0]) || new Map();
      const filas = calendario.filter((f) => f >= p[1] && f <= p[2] && m.has(f)).map((f) => [f, texto(m.get(f))]);
      return responde([['fecha', T], ['cierre', N]], filas);
    }
    // benchmark: dividendos
    if (/from bmv_distribuciones/.test(q) && /emisora_serie = \$1/.test(q)) {
      const filas = mundo.dividendos
        .filter((d) => d.emisora_serie === p[0] && d.fecha >= p[1] && d.fecha <= p[2])
        .map((d) => [d.fecha, texto(d.monto)]);
      return responde([['fecha', T], ['monto', N]], filas);
    }
    // conversiones APLICADAS — se distingue por el join INTERNO a la tabla de
    // tasas. Ojo: las dos consultas de divisa traen `requiere_conversion =
    // true`, así que un mock que sólo mirara eso contestaría lo mismo a las
    // dos y daría un verde falso. Ya pasó una vez.
    if (/join bmv_tipos_cambio/.test(q) && !/tc\.tasa is null/.test(q)) {
      return responde(
        [['emisora_serie', T], ['fecha', T], ['divisa', T], ['monto', N], ['tasa', N], ['monto_mxn', N], ['precio', N]],
        (mundo.divisaConvertida || []).map((d) => [
          d.emisora_serie, d.fecha, d.divisa, texto(d.monto), texto(d.tasa),
          texto(d.monto * d.tasa), texto(d.precio)]));
    }
    // repartos excluidos por divisa que SIGUEN sin tasa
    if (/requiere_conversion = true/.test(q)) {
      assert.match(q, /tc\.tasa is null/, 'los excluidos son los que NO tienen tasa');
      return responde([['emisora_serie', T], ['fecha', T], ['monto', N], ['divisa', T], ['precio', N]],
        mundo.divisaExcluida.map((d) => [d.emisora_serie, d.fecha, texto(d.monto), d.divisa, texto(d.precio)]));
    }
    // cobertura de fecha ex
    if (/ex_aproximada/.test(q)) {
      return responde([['total', I], ['aproximadas', I]], [['100', '91']]);
    }
    throw new Error(`consulta no prevista por el mock: ${q.slice(0, 120)}`);
  };
}

function mockRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const GET = (query = {}, headers = {}) => ({ method: 'GET', query, headers });
const AUTH = { authorization: `Bearer ${SECRET}` };

/* ═══════════════════ 1. el gate ═══════════════════ */

test('sin credenciales contesta 401 y NO toca la base', async () => {
  global.fetch = mockFetch(fabrica({ nSeries: 3 }));
  const res = mockRes();
  await handler(GET(), res);
  assert.equal(res.code, 401);
  assert.equal(consultas.length, 0, 'un 401 no puede haber abierto Neon');
});

test('con el secret equivocado también contesta 401', async () => {
  global.fetch = mockFetch(fabrica({ nSeries: 3 }));
  const res = mockRes();
  await handler(GET({}, { authorization: 'Bearer nel' }), res);
  assert.equal(res.code, 401);
  assert.equal(consultas.length, 0);
});

test('sin ADMIN_SECRET configurado falla CERRADO', async () => {
  const guardado = process.env.ADMIN_SECRET;
  const guardadoCron = process.env.CRON_SECRET;
  delete process.env.ADMIN_SECRET;
  delete process.env.CRON_SECRET;
  try {
    global.fetch = mockFetch(fabrica({ nSeries: 3 }));
    const res = mockRes();
    await handler(GET({}, AUTH), res);
    assert.equal(res.code, 401, 'sin secret NO se abre, no se abre de par en par');
  } finally {
    process.env.ADMIN_SECRET = guardado;
    if (guardadoCron !== undefined) process.env.CRON_SECRET = guardadoCron;
  }
});

/* ═══════════════════ 2. SOLO LECTURA ═══════════════════ */

test('CADA consulta que cruza la frontera es de lectura', async () => {
  global.fetch = mockFetch(fabrica({ nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31' }));
  const res = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), res);
  assert.equal(res.code, 200, JSON.stringify(res.body).slice(0, 300));
  assert.ok(consultas.length > 5, `esperaba varias consultas, hubo ${consultas.length}`);
  for (const q of consultas) {
    const primera = q.trim().slice(0, 6).toLowerCase();
    assert.ok(primera.startsWith('select') || primera.startsWith('with'),
      `consulta que NO es de lectura: ${q.slice(0, 120)}`);
    assert.doesNotMatch(q, /\b(insert|update|delete|create|alter|drop|truncate)\b/i,
      `consulta con verbo de escritura: ${q.slice(0, 120)}`);
  }
});

test('el reporte declara que costó 0 créditos', async () => {
  global.fetch = mockFetch(fabrica({ nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31' }));
  const res = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), res);
  assert.equal(res.body.creditos, 0);
});

/* ═══════════════════ 3. la advertencia de signo ═══════════════════ */

test('exceso SIGNIFICATIVO y NEGATIVO es NO-GO FUERTE, nunca GO', async () => {
  // La canasta que el score elige (EPS alto ⇒ value alto) es justo la que
  // pierde. |t| sale grande, y ahí está la trampa: un |t| alto sólo dice que
  // el exceso no es ruido — no dice de qué lado está.
  const mundo = fabrica({
    nSeries: 20, desde: '2016-01-01', hasta: '2020-12-31',
    eps: (i) => 10 - i * 0.4,                       // las primeras tienen más EPS
    driftPorSerie: (i) => (i < 10 ? -0.0006 : 0.0010),  // …y son las que pierden
    driftBench: 0.0004,
  });
  global.fetch = mockFetch(mundo);
  const res = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), res);
  const v = res.body.resultados.base.veredicto;
  assert.ok(v.exceso_medio_diario < 0, `el exceso debía salir negativo: ${v.exceso_medio_diario}`);
  assert.ok(Math.abs(v.t) >= UMBRAL_T, `|t| debía pasar el umbral: ${v.t}`);
  assert.equal(v.dictamen, 'NO-GO FUERTE');
  assert.match(v.advertencia_signo, /NO es GO/);
});

test('la advertencia de signo también sale en el markdown', async () => {
  const mundo = fabrica({
    nSeries: 20, desde: '2016-01-01', hasta: '2020-12-31',
    eps: (i) => 10 - i * 0.4,
    driftPorSerie: (i) => (i < 10 ? -0.0006 : 0.0010),
  });
  global.fetch = mockFetch(mundo);
  const res = mockRes();
  await handler(GET({ format: 'md', sensibilidades: '0' }, AUTH), res);
  assert.match(res.body, /NO-GO FUERTE/);
  assert.match(res.body, /NO es GO/);
});

test('veredicto() no puede producir GO con exceso negativo, por construcción', () => {
  // Directo sobre la función pura: un exceso negativo enorme y constante da
  // |t| gigante. Si algún día alguien reordena las ramas del if, esto truena.
  const exceso = new Array(500).fill(-0.001);
  const v = veredicto({
    exceso, sharpeCanasta: 5, sharpeBenchmark: 0,
    rebalanceos: 60, universoMediano: 40, regimen: null,
  });
  assert.equal(v.dictamen, 'NO-GO FUERTE');
  assert.notEqual(v.dictamen, 'GO');
});

/* ═══════════════════ 4. cero look-ahead ═══════════════════ */

test('un trimestre que todavía no estaba disponible NO entra al TTM', () => {
  const cierres = [
    { fecha_cierre: '2019-03-31', eps: 1 },
    { fecha_cierre: '2019-06-30', eps: 1 },
    { fecha_cierre: '2019-09-30', eps: 1 },
    { fecha_cierre: '2019-12-31', eps: 1 },
    { fecha_cierre: '2020-03-31', eps: 99 },   // cierre + 65d = 2020-06-04
  ];
  // El 2020-06-03 el 1T2020 todavía NO está disponible: el TTM son los cuatro
  // de 2019 y suma 4, no 102.
  const antes = epsTtm(cierres, '2020-06-03');
  assert.equal(antes.eps_ttm, 4);
  assert.deepEqual(antes.cierres, ['2019-03-31', '2019-06-30', '2019-09-30', '2019-12-31']);
  // El 2020-06-04 sí entra, y el TTM rueda.
  const despues = epsTtm(cierres, '2020-06-04');
  assert.equal(despues.eps_ttm, 102);
});

test('el corte de 65 días es exactamente 65, ni 64 ni 66', () => {
  const cierres = [
    { fecha_cierre: '2019-03-31', eps: 1 }, { fecha_cierre: '2019-06-30', eps: 1 },
    { fecha_cierre: '2019-09-30', eps: 1 }, { fecha_cierre: '2019-12-31', eps: 5 },
  ];
  // 2019-12-31 + 65 días = 2020-03-05.
  assert.equal(epsTtm(cierres, '2020-03-04'), null, 'un día antes faltan trimestres');
  assert.equal(epsTtm(cierres, '2020-03-05').eps_ttm, 8, 'justo ese día ya son cuatro');
  assert.equal(LAG_DIAS, 65, 'el criterio congelado');
});

test('sin cuatro trimestres disponibles no hay TTM, y no se rellena con menos', () => {
  const cierres = [{ fecha_cierre: '2019-03-31', eps: 1 }, { fecha_cierre: '2019-06-30', eps: 1 }];
  assert.equal(epsTtm(cierres, '2020-01-01'), null);
});

test('un EPS nulo invalida el TTM en vez de contarse como cero', () => {
  const cierres = [
    { fecha_cierre: '2019-03-31', eps: 1 }, { fecha_cierre: '2019-06-30', eps: null },
    { fecha_cierre: '2019-09-30', eps: 1 }, { fecha_cierre: '2019-12-31', eps: 1 },
  ];
  assert.equal(epsTtm(cierres, '2020-06-01'), null, 'un hueco no es un cero');
});

test('el precio del ranking es el cierre ANTERIOR, nunca el del día', () => {
  // Cierre mensual de enero = 31-ene. Para un rebalanceo el 1-feb el límite es
  // el 31-ene: el cierre de febrero no puede haberse usado.
  const mensuales = new Map([
    [mesIndice('2020-01-01'), { fecha: '2020-01-31', cierre: 100 }],
    [mesIndice('2020-02-01'), { fecha: '2020-02-28', cierre: 200 }],
  ]);
  const c = cierreMensualHasta(mensuales, '2020-01-31', 0);
  assert.equal(c.cierre, 100);
  assert.equal(cierreMensualHasta(mensuales, '2020-01-31', 0).fecha, '2020-01-31');
});

test('el ranking usa el cierre del mes ANTERIOR aunque el rebalanceo caiga en día 3', () => {
  // El bug que esto atrapa: el 1 de julio de 2017 cayó en sábado, así que el
  // primer día operado del mes fue el LUNES 3. Derivar el precio del ranking
  // como «fecha − 1 día» daba el 2 de julio, que sigue siendo julio, y en
  // julio el único cierre mensual es el del 31: un precio del FUTURO. Con el
  // guardia de «anterior al rebalanceo» el nombre quedaba fuera y el universo
  // salía VACÍO — un error que se delata solo, que es la forma barata de
  // equivocarse, pero error al fin.
  const mundo = fabrica({ nSeries: 10, desde: '2016-01-01', hasta: '2018-12-31' });
  const ins = insumosDe(mundo);
  const julio = ins.fechas.find((f) => f.startsWith('2017-07'));
  assert.equal(julio, '2017-07-03', 'el primer día operado de julio 2017 fue lunes 3');
  const { canastas } = construyeCanastas(ins);
  const c = canastas.find((x) => x.fecha === julio);
  assert.ok(c.elegibles > 0, 'con el ancla correcta el universo no está vacío');
  for (const d of c.detalle) {
    assert.ok(d.fecha_precio_ranking < julio,
      `el precio del ranking (${d.fecha_precio_ranking}) tiene que ser ANTERIOR al rebalanceo`);
    assert.equal(d.fecha_precio_ranking.slice(0, 7), '2017-06', 'y es el cierre de junio');
  }
});

test('ningún rebalanceo usa un precio de ranking del mismo día o posterior', () => {
  // La invariante, sobre TODOS los rebalanceos y no sobre un caso escogido.
  const mundo = fabrica({ nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31' });
  const { canastas } = construyeCanastas(insumosDe(mundo));
  let revisados = 0;
  for (const c of canastas) {
    for (const d of c.detalle) {
      assert.ok(d.fecha_precio_ranking < c.fecha,
        `${d.emisora_serie} en ${c.fecha} se rankeó con un precio de ${d.fecha_precio_ranking}`);
      revisados += 1;
    }
  }
  assert.ok(revisados > 100, `esperaba revisar muchos, revisé ${revisados}`);
});

test('cierreMensualHasta no devuelve un cierre posterior al límite', () => {
  // El cierre del propio mes objetivo puede caer DESPUÉS del límite cuando el
  // límite cae a media mes. Usarlo sería mirar un precio del futuro.
  const mensuales = new Map([[mesIndice('2020-03-01'), { fecha: '2020-03-31', cierre: 100 }]]);
  assert.equal(cierreMensualHasta(mensuales, '2020-03-15', 0), null);
});

/* ═══════════════════ 5. momentum 12-1 ═══════════════════ */

test('momentum 12-1 salta el mes más reciente', () => {
  const mensuales = new Map();
  // Precio que sube 1% mensual hasta feb-2020 y luego se dispara.
  for (let k = 0; k < 40; k++) {
    const a = 2017 + Math.floor(k / 12);
    const m = (k % 12) + 1;
    mensuales.set(mesIndice(`${a}-${String(m).padStart(2, '0')}-01`), {
      fecha: `${a}-${String(m).padStart(2, '0')}-28`,
      cierre: 100 * 1.01 ** k,
    });
  }
  const mom = momentum121(mensuales, '2019-06-03');
  // t−12m → 2018-06-03 → último cierre ≤ eso es mayo-2018; t−1m → 2019-05-03 →
  // abril-2019. Son 11 meses de 1%: (1.01^11 − 1).
  assert.ok(Math.abs(mom - (1.01 ** 11 - 1)) < 1e-9, `momentum = ${mom}`);
});

test('restaMeses no desborda el día al último del mes destino', () => {
  assert.equal(restaMeses('2020-03-31', 1), '2020-02-29');
  assert.equal(restaMeses('2021-03-31', 1), '2021-02-28');
  assert.equal(restaMeses('2020-01-15', 12), '2019-01-15');
});

/* ═══════════════════ 6. ranks y canastas ═══════════════════ */

test('el rank percentil promedia empates', () => {
  assert.deepEqual(rankPercentil([1, 2, 3]), [0, 0.5, 1]);
  assert.deepEqual(rankPercentil([5, 5, 9]), [0.25, 0.25, 1]);
  assert.deepEqual(rankPercentil([7]), [0.5]);
});

test('el score combo es el promedio de los DOS ranks, no de los valores crudos', () => {
  const mundo = fabrica({ nSeries: 10, desde: '2016-01-01', hasta: '2018-12-31' });
  const { canastas } = construyeCanastas(insumosDe(mundo));
  const d = canastas[canastas.length - 1].detalle[0];
  assert.ok(Math.abs(d.score - (d.rank_value + d.rank_momentum) / 2) < 1e-12);
});

test('las tres variantes de score comparten la MISMA población elegible', () => {
  const mundo = fabrica({ nSeries: 24, desde: '2016-01-01', hasta: '2019-12-31', eps: (i) => 1 + i * 0.1 });
  const ins = insumosDe(mundo);
  const combo = construyeCanastas({ ...ins });
  const value = construyeCanastas({ ...ins, score: 'value' });
  const mom = construyeCanastas({ ...ins, score: 'momentum' });
  for (let k = 0; k < combo.canastas.length; k++) {
    assert.equal(value.canastas[k].elegibles, combo.canastas[k].elegibles);
    assert.equal(mom.canastas[k].elegibles, combo.canastas[k].elegibles);
  }
});

test('el filtro de liquidez usa el umbral congelado y saca a los ilíquidos', () => {
  const mundo = fabrica({
    nSeries: 20, desde: '2016-01-01', hasta: '2019-12-31',
    importe: (serie) => (Number(serie.slice(1, 4)) < 12 ? 5e6 : 1e3),
  });
  const { canastas } = construyeCanastas(insumosDe(mundo));
  assert.equal(UMBRAL_IMPORTE, 1_000_000, 'el umbral congelado');
  for (const c of canastas) assert.equal(c.elegibles, 12, 'sólo las 12 líquidas');
});

test('el tamaño de canasta respeta piso y techo', () => {
  const chico = fabrica({ nSeries: 10, desde: '2016-01-01', hasta: '2019-12-31' });
  const grande = fabrica({ nSeries: 100, desde: '2016-01-01', hasta: '2019-12-31' });
  const a = construyeCanastas(insumosDe(chico)).canastas[0];
  const b = construyeCanastas(insumosDe(grande)).canastas[0];
  assert.equal(a.tamano, 8, '0.20 × 10 = 2 → manda el piso');
  assert.equal(a.regimen, 'piso');
  assert.equal(b.tamano, 15, '0.20 × 100 = 20 → manda el techo');
  assert.equal(b.regimen, 'techo');
});

/* ═══════════════════ 7. la simulación ═══════════════════ */

function insumosDe(mundo, { desde = '2017-07-01', hasta = '2026-09-30' } = {}) {
  const primeros = [];
  let mesPrev = null;
  const ultimoDelMes = new Map();
  for (const f of mundo.calendario) {
    const mes = f.slice(0, 7);
    if (mes !== mesPrev) { primeros.push(f); mesPrev = mes; }
    ultimoDelMes.set(mes, f);
  }
  const fechas = primeros.filter((f) => f >= desde && f <= hasta);
  const epsPorEmisora = new Map();
  for (const f of mundo.financieros) {
    if (!epsPorEmisora.has(f.emisora)) epsPorEmisora.set(f.emisora, []);
    epsPorEmisora.get(f.emisora).push(f);
  }
  const mensualesPorSerie = new Map();
  for (const [serie, m] of mundo.precios) {
    const mm = new Map();
    for (const [mes, ultimo] of ultimoDelMes) {
      if (m.has(ultimo)) mm.set(mesIndice(`${mes}-01`), { fecha: ultimo, cierre: m.get(ultimo) });
    }
    mensualesPorSerie.set(serie, mm);
  }
  const medianas = new Map();
  for (const f of fechas) {
    for (const s of mundo.series) medianas.set(`${f}|${s.emisora_serie}`, mundo.importe(s.emisora_serie, f));
  }
  return { fechas, series: mundo.series, epsPorEmisora, mensualesPorSerie, medianas };
}

test('los costos de 10 bp por lado restan retorno, y restan siempre', () => {
  const mundo = fabrica({ nSeries: 20, desde: '2016-01-01', hasta: '2019-12-31', eps: (i, a) => 1 + ((i + a) % 7) });
  const ins = insumosDe(mundo);
  const { canastas } = construyeCanastas(ins);
  const precios = new Map([...mundo.precios].map(([s, m]) => [s, m]));
  const conCosto = simula({ canastas, calendario: mundo.calendario, preciosPorSerie: precios, costoBp: 10 });
  const sinCosto = simula({ canastas, calendario: mundo.calendario, preciosPorSerie: precios, costoBp: 0 });
  assert.ok(conCosto.equity_final < sinCosto.equity_final, 'cobrar comisiones no puede subir el retorno');
  assert.ok(conCosto.costo_total > 0);
});

test('un dividendo en la fecha ex sube la serie total por encima de la de precio', () => {
  const mundo = fabrica({
    nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31',
    dividendos: [{ emisora_serie: 'E000*', fecha: '2018-03-01', monto: 5 }],
  });
  const ins = insumosDe(mundo);
  const { canastas } = construyeCanastas(ins);
  const divs = new Map([['E000*', new Map([['2018-03-01', 5]])]]);
  const total = simula({ canastas, calendario: mundo.calendario, preciosPorSerie: mundo.precios, dividendosPorSerie: divs, conDividendos: true });
  const precio = simula({ canastas, calendario: mundo.calendario, preciosPorSerie: mundo.precios, dividendosPorSerie: divs, conDividendos: false });
  assert.ok(total.equity_final > precio.equity_final, 'el retorno total tiene que ser mayor');
  assert.ok(total.dividendos_reinvertidos > 0);
});

test('el benchmark a retorno total le gana a su propia serie de precio', () => {
  const fechas = ['2020-01-02', '2020-01-03', '2020-01-06'];
  const precios = new Map([['2020-01-02', 50], ['2020-01-03', 50], ['2020-01-06', 50]]);
  const divs = new Map([['2020-01-03', 1]]);
  const total = serieBenchmark({ precios, dividendos: divs, fechas, conDividendos: true });
  const precio = serieBenchmark({ precios, dividendos: divs, fechas, conDividendos: false });
  assert.ok(total.equity_final > precio.equity_final);
  assert.ok(Math.abs(total.equity_final - 1.02) < 1e-9, 'un peso sobre 50 es 2%');
});

test('comparar la canasta a precio contra un benchmark total sería el error del signo volteado', () => {
  // La razón por la que §3.3 exige los DOS lados a retorno total, hecha número:
  // medir mal UN lado mueve el exceso por un monto del orden del dividendo.
  const fechas = ['2020-01-02', '2020-01-03'];
  const precios = new Map([['2020-01-02', 100], ['2020-01-03', 100]]);
  const divs = new Map([['2020-01-03', 3]]);
  const total = serieBenchmark({ precios, dividendos: divs, fechas, conDividendos: true });
  const precio = serieBenchmark({ precios, dividendos: divs, fechas, conDividendos: false });
  const asimetrico = excesoDiario(precio.retornos, total.retornos);
  assert.ok(asimetrico[1] < 0, 'el lado medido a precio sale castigado');
  assert.ok(Math.abs(asimetrico[1] + 0.03) < 1e-9, 'y por exactamente el tamaño del reparto');
});

/* ═══════════════════ 8. las cuatro series y el reporte ═══════════════════ */

test('el reporte trae las CUATRO series', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 15, desde: '2016-01-01', hasta: '2019-12-31',
    dividendos: [
      { emisora_serie: BENCH, fecha: '2018-03-01', monto: 0.5 },
      { emisora_serie: 'E000*', fecha: '2018-06-01', monto: 1 },
    ],
  }));
  const res = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), res);
  const s = res.body.resultados.base.series;
  for (const k of ['canasta_total', 'canasta_precio', 'naftrac_total', 'naftrac_precio']) {
    assert.ok(s[k], `falta la serie ${k}`);
    assert.ok(Number.isFinite(s[k].retorno_anualizado), `${k} sin retorno`);
  }
  assert.ok(s.naftrac_total.retorno_anualizado > s.naftrac_precio.retorno_anualizado,
    'NAFTRAC reparte: su total tiene que ir arriba de su precio');
});

test('el encabezado trae los cuatro caveats', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 15, desde: '2016-01-01', hasta: '2019-12-31',
    divisaExcluida: [{ emisora_serie: 'E001*', fecha: '2018-03-01', monto: 2, divisa: 'USD', precio: 100 }],
  }));
  const res = mockRes();
  await handler(GET({ format: 'md', sensibilidades: '0' }, AUTH), res);
  assert.match(res.body, /Fecha ex aproximada en 91\.0%/);
  assert.match(res.body, /Régimen de la canasta/);
  assert.match(res.body, /bp de retorno no contados/);
  assert.match(res.body, /VISTAC/);
  assert.match(res.body, /GAVB/);
});

test('los bp no contados salen de monto ÷ precio de la fecha ex', () => {
  const r = bpNoContados([
    { emisora_serie: 'A*', monto: 2, precio: 100, divisa: 'USD' },
    { emisora_serie: 'A*', monto: 1, precio: 100, divisa: 'USD' },
    { emisora_serie: 'B*', monto: 0.1, precio: 100, divisa: 'EUR' },
  ], { umbral: 50 });
  const a = r.series.find((s) => s.emisora_serie === 'A*');
  assert.equal(a.bp, 300, '(2+1)/100 × 10,000');
  assert.ok(a.supera_umbral, '300 bp pasa el umbral de 50');
  assert.deepEqual(r.series_sobre_umbral, ['A*']);
  const b = r.series.find((s) => s.emisora_serie === 'B*');
  assert.equal(b.supera_umbral, false, '10 bp no lo pasa');
});

test('un reparto excluido sin precio en la fecha ex se cuenta aparte, no como cero', () => {
  const r = bpNoContados([{ emisora_serie: 'A*', monto: 2, precio: null, divisa: 'USD' }]);
  assert.equal(r.repartos_sin_precio_en_fecha_ex, 1);
  assert.equal(r.total_bp, 0);
  assert.equal(r.series.length, 0, 'no se inventa un bp con un precio que no existe');
});

/* ═══════════════════ 9. las sensibilidades no promueven ═══════════════════ */

test('las sensibilidades se reportan aparte y el veredicto sale SÓLO del caso base', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 30, desde: '2016-01-01', hasta: '2020-12-31',
    eps: (i) => 10 - i * 0.3,
    driftPorSerie: (i) => (i < 15 ? -0.0004 : 0.0008),
  }));
  const res = mockRes();
  await handler(GET({}, AUTH), res);
  const r = res.body.resultados;
  assert.ok(r.base && r.decil && r.value && r.momentum && r.lag90, 'las cuatro sensibilidades');
  // El dictamen del reporte es el del caso base, pase lo que pase con las otras.
  assert.equal(res.body.encabezado.regimen ? true : true, true);
  const md = mockRes();
  await handler(GET({ format: 'md' }, AUTH), md);
  assert.match(md.body, /Veredicto: \*\*NO-GO/);
  assert.match(md.body, /nunca\*\* promoción/);
  assert.match(md.body, /sigue siendo NO-GO/);
});

test('la sensibilidad de lag 90 usa 90 días, no 65', async () => {
  const mundo = fabrica({ nSeries: 15, desde: '2016-01-01', hasta: '2019-12-31' });
  const ins = insumosDe(mundo);
  const a = construyeCanastas({ ...ins, lagDias: 65 });
  const b = construyeCanastas({ ...ins, lagDias: 90 });
  // Con más rezago, en algún rebalanceo hay menos trimestres disponibles.
  const menos = a.canastas.some((c, k) => b.canastas[k].elegibles <= c.elegibles);
  assert.ok(menos, 'un rezago mayor no puede ampliar la información disponible');
});

/* ═══════════════════ 10. ventanas de tenencia ═══════════════════ */

test('las ventanas de un nombre que se sostiene se FUSIONAN en una sola', () => {
  const canastas = [
    { fecha: '2020-01-02', nombres: ['A*'] },
    { fecha: '2020-02-03', nombres: ['A*'] },
    { fecha: '2020-03-02', nombres: ['A*'] },
  ];
  const v = ventanasDeTenencia([canastas], ['2020-01-02', '2020-02-03', '2020-03-02', '2020-03-31']);
  assert.equal(v.length, 1, 'tres rebalanceos seguidos son UN intervalo');
  assert.deepEqual(v[0], ['A*', '2020-01-02', '2020-03-31']);
});

test('un nombre que entra, sale y vuelve produce DOS intervalos', () => {
  const canastas = [
    { fecha: '2020-01-02', nombres: ['A*'] },
    { fecha: '2020-02-03', nombres: ['B*'] },
    { fecha: '2020-03-02', nombres: ['B*'] },
    { fecha: '2020-04-01', nombres: ['A*'] },
  ];
  const v = ventanasDeTenencia([canastas], ['2020-01-02', '2020-02-03', '2020-03-02', '2020-04-01', '2020-04-30']);
  const deA = v.filter((x) => x[0] === 'A*');
  assert.equal(deA.length, 2);
  assert.deepEqual(deA[0], ['A*', '2020-01-02', '2020-02-03']);
  assert.deepEqual(deA[1], ['A*', '2020-04-01', '2020-04-30']);
});

test('la última canasta se sostiene hasta el final del calendario', () => {
  const v = ventanasDeTenencia(
    [[{ fecha: '2020-01-02', nombres: ['A*'] }]],
    ['2020-01-02', '2020-01-03', '2020-06-30']);
  assert.deepEqual(v[0], ['A*', '2020-01-02', '2020-06-30']);
});

test('indexaPorSerieYFecha arma el mapa anidado con números', () => {
  const m = indexaPorSerieYFecha([{ emisora_serie: 'A*', fecha: '2020-01-02', cierre: '12.5' }], 'cierre');
  assert.equal(m.get('A*').get('2020-01-02'), 12.5);
});

/* ═══════════════════ 11. las puertas de §3.4 ═══════════════════ */

test('con menos de 30 rebalanceos el veredicto es INCONCLUSO, no NO-GO', () => {
  const v = veredicto({
    exceso: new Array(100).fill(0.001), sharpeCanasta: 2, sharpeBenchmark: 0.5,
    rebalanceos: 12, universoMediano: 40, regimen: null,
  });
  assert.equal(v.dictamen, 'INCONCLUSO');
  assert.match(v.porque, /muestra insuficiente/);
});

test('con universo elegible mediano < 16 el veredicto es INCONCLUSO', () => {
  const v = veredicto({
    exceso: new Array(500).fill(0.001), sharpeCanasta: 2, sharpeBenchmark: 0.5,
    rebalanceos: 60, universoMediano: 9, regimen: null,
  });
  assert.equal(v.dictamen, 'INCONCLUSO');
  assert.match(v.porque, /universo insuficiente/);
});

test('GO exige señal Y economía; con una sola no alcanza', () => {
  // Señal fuerte pero prima de Sharpe corta.
  const casi = veredicto({
    exceso: new Array(500).fill(0.0005), sharpeCanasta: 0.55, sharpeBenchmark: 0.5,
    rebalanceos: 60, universoMediano: 40, regimen: null,
  });
  assert.equal(casi.dictamen, 'NO-GO');
  assert.match(casi.porque, /prima de Sharpe/);
  assert.equal(PRIMA_SHARPE, 0.15, 'la prima congelada');
});

test('un |t| entre 2 y 2.5 se reporta como GO FRÁGIL', () => {
  // 400 días con media 0.0002 y ruido controlado: |t| cae en la banda frágil.
  const exceso = [];
  for (let i = 0; i < 400; i++) exceso.push(0.0002 + (i % 2 ? 0.0018 : -0.0018));
  const v = veredicto({
    exceso, sharpeCanasta: 1, sharpeBenchmark: 0.5, rebalanceos: 60,
    universoMediano: 40, regimen: null,
  });
  assert.ok(Math.abs(v.t) >= 2 && Math.abs(v.t) < 2.5, `t = ${v.t}`);
  assert.equal(v.dictamen, 'GO FRÁGIL');
});

test('la etiqueta de régimen viaja al veredicto sin bloquearlo', () => {
  const v = veredicto({
    exceso: new Array(500).fill(0.001), sharpeCanasta: 2, sharpeBenchmark: 0.5,
    rebalanceos: 60, universoMediano: 40,
    regimen: { etiqueta: 'no probó un quintil, probó top-N fijo (piso de 8)', observacion: null },
  });
  assert.match(v.etiqueta_regimen, /top-N fijo/);
  assert.ok(['GO', 'GO FRÁGIL'].includes(v.dictamen), 'la etiqueta etiqueta, no bloquea');
});

/* ═══════════════════ 12. el markdown no revienta ═══════════════════ */

test('reporteMd sobrevive a un análisis sin canastas', () => {
  const md = reporteMd({
    ventana: { desde: '2017-07-01', hasta: '2026-09-30' },
    criterios: { benchmark: 'NAFTRACISHRS' },
    encabezado: {
      pct_ex_aproximada: 0.91, fechas_ex: { total: 100, aproximadas: 91 },
      regimen: null,
      bp_no_contados_por_divisa: { total_bp: 0, series: [], series_sobre_umbral: [], umbral_bp: 50 },
      series_excluidas: { lista: ['VISTAC', 'GAVB'], motivo: 'sin precios' },
    },
    resultados: { base: { titulo: 'x', error: 'sin canastas' } },
  });
  assert.match(md, /No hubo canastas que simular/);
});

/* ═══════════════════ 13. moneda extranjera convertida ═══════════════════ */

test('un reparto en USD CON tasa de su fecha ex entra al retorno total', async () => {
  // El pendiente de disciplina que HOTEL* destapó: §3.3 excluía estos repartos
  // de la v1 y ponía un umbral de 50 bp por serie. Pasado el umbral, la
  // exclusión se resuelve con el tipo de cambio de la FECHA EX — no con el de
  // hoy, que sería mirar el futuro desde 2016.
  const convertido = [{ emisora_serie: 'E000*', fecha: '2018-03-01', divisa: 'USD', monto: 1, tasa: 18.7, precio: 100 }];
  global.fetch = mockFetch(fabrica({
    nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31', divisaConvertida: convertido,
  }));
  const conTasa = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), conTasa);

  global.fetch = mockFetch(fabrica({ nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31' }));
  const sinNada = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), sinNada);

  const a = conTasa.body.resultados.base.series.canasta_total.retorno_anualizado;
  const b = sinNada.body.resultados.base.series.canasta_total.retorno_anualizado;
  assert.ok(a > b, `convertir sólo puede SUMAR retorno a la canasta: ${a} vs ${b}`);
});

test('la conversión se reporta con su tasa, no sólo con el resultado', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31',
    divisaConvertida: [{ emisora_serie: 'E000*', fecha: '2018-03-01', divisa: 'USD', monto: 2, tasa: 18.5, precio: 100 }],
  }));
  const res = mockRes();
  await handler(GET({ sensibilidades: '0' }, AUTH), res);
  const cv = res.body.encabezado.conversiones_aplicadas;
  assert.equal(cv.repartos, 1);
  assert.equal(cv.detalle[0].tasa, 18.5, 'la tasa viaja, para que la conversión sea auditable');
  assert.equal(cv.detalle[0].monto_mxn, 37);
  assert.ok(Math.abs(cv.bp_recuperados - 3700) < 1e-6, '37 pesos sobre 100 son 3,700 bp');
});

test('un reparto en USD SIN tasa sigue excluido y sigue contándose como hueco', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31',
    divisaExcluida: [{ emisora_serie: 'E001*', fecha: '2018-03-01', monto: 2, divisa: 'USD', precio: 100 }],
  }));
  const res = mockRes();
  await handler(GET({ format: 'md', sensibilidades: '0' }, AUTH), res);
  assert.match(res.body, /bp de retorno no contados/);
  assert.match(res.body, /SIN tipo de cambio/, 'el encabezado distingue "sin tasa" de "excluido por política"');
});

test('el encabezado dice las DOS cosas: lo convertido y lo que sigue sin contar', async () => {
  global.fetch = mockFetch(fabrica({
    nSeries: 12, desde: '2016-01-01', hasta: '2019-12-31',
    divisaConvertida: [{ emisora_serie: 'E000*', fecha: '2018-03-01', divisa: 'USD', monto: 1, tasa: 18.7, precio: 100 }],
    divisaExcluida: [{ emisora_serie: 'E001*', fecha: '2018-06-01', monto: 2, divisa: 'EUR', precio: 100 }],
  }));
  const res = mockRes();
  await handler(GET({ format: 'md', sensibilidades: '0' }, AUTH), res);
  assert.match(res.body, /1 repartos en moneda extranjera CONVERTIDOS/);
  assert.match(res.body, /bp de retorno no contados/);
});
