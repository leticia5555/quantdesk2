// ═══════════════════════════════════════════════════════════════
// tests/arena-contrato-vivo.test.mjs — el encendido del contrato objetivo.
//
// Este archivo cubre el ÚNICO tramo del Arena que no pudo correr en sombra:
// mandar las órdenes. La sombra probó la decisión durante cuatro días y llegó a
// 7/7; la EJECUCIÓN no tiene kilómetros, y por eso lleva el candado más duro
// del repo y los tests más paranoicos.
//
// Las cuatro cosas que se afirman:
//   1. CON LA BANDERA APAGADA NO CAMBIA NADA. "Apagar" tiene que ser volver al
//      comportamiento de ayer, no a una versión parecida.
//   2. NO HAY UNA COPIA DEL CAMINO. El vivo corre la MISMA función que la
//      sombra. Una copia empezaría idéntica y divergiría en el primer arreglo
//      que alguien aplicara a una sola de las dos.
//   3. LA REGLA DE LA CASA SOBREVIVE: límite marketable, nunca mercado.
//   4. EL CANDADO FRENA LA CORRIDA ENTERA, no la orden suelta.
//
// Correr con `node tests/arena-contrato-vivo.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  contratoActivo, usaObjetivo, mandaOrdenes, limiteMarketable,
  legsAOrdenes, verificarOrdenesContraPesos, enviarOrdenes,
  CONTRATO_VIEJO, CONTRATO_OBJETIVO, CONTRATO_OBJETIVO_DRY,
} from '../api/_lib/arena-objetivo-vivo.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) LA BANDERA ────────────────────────────────────────────────────
console.log('\n── tres estados, y el default es el de ayer ──');
{
  ok(contratoActivo({}) === CONTRATO_VIEJO, 'sin la env var: contrato VIEJO');
  ok(contratoActivo({ ARENA_CONTRATO: '0' }) === CONTRATO_VIEJO, 'con "0": contrato VIEJO');
  ok(contratoActivo({ ARENA_CONTRATO: 'cualquier-cosa' }) === CONTRATO_VIEJO,
    'y con un valor que no se reconoce también: un typo NO puede encender el contrato nuevo');
  ok(contratoActivo({ ARENA_CONTRATO: 'objetivo' }) === CONTRATO_OBJETIVO, 'con "objetivo": contrato NUEVO');
  ok(contratoActivo({ ARENA_CONTRATO: 'OBJETIVO ' }) === CONTRATO_OBJETIVO, 'tolerante a mayúsculas y espacios');

  // El escalón intermedio: decide, calcula las órdenes, y NO manda.
  ok(usaObjetivo({ ARENA_CONTRATO: 'objetivo_dry' }) === true,
    '"objetivo_dry" SÍ usa el contrato nuevo');
  ok(mandaOrdenes({ ARENA_CONTRATO: 'objetivo_dry' }) === false,
    'pero NO manda órdenes: es el escalón que convierte "confío" en "vi las órdenes"');
  ok(mandaOrdenes({ ARENA_CONTRATO: 'objetivo' }) === true, 'y "objetivo" sí manda');
  ok(mandaOrdenes({}) === false, 'sin bandera, nunca se manda por el camino nuevo');
}

// ── 2) APAGADA = EL CAMINO DE AYER, INTACTO ──────────────────────────
console.log('\n── la rama nueva sale ANTES de tocar el camino viejo ──');
{
  const src = readFileSync('api/arena-run.js', 'utf8');
  const iDecide = src.indexOf('export async function runArenaDecide(');
  const iFlag = src.indexOf('if (usaObjetivo())', iDecide);
  const iRunDate = src.indexOf('const runDate =', iDecide);
  ok(iFlag > iDecide && iFlag < iRunDate,
    'el chequeo de la bandera es lo PRIMERO de runArenaDecide, antes de cualquier trabajo',
    `flag@${iFlag} < runDate@${iRunDate}`);
  ok(/if \(usaObjetivo\(\)\) \{[\s\S]{0,900}?return runAgenteObjetivo\(/.test(src),
    'y sale con `return`: con la bandera apagada no se ejecuta ni una línea nueva');

  // El anuncio del reglamento NO puede escribirse con la bandera apagada: sería
  // declarar un cambio que no ocurrió.
  ok(/export async function announceContratoObjetivo[\s\S]{0,200}?if \(!usaObjetivo\(env\)\) return false;/.test(src),
    'el anuncio v4 se escribe SOLO con la bandera encendida');
}

// ── 3) UNA SOLA FUNCIÓN PARA LOS DOS CAMINOS ─────────────────────────
// Lo que llegó a 7/7 en sombra tiene que ser EXACTAMENTE lo que se enciende.
console.log('\n── el vivo no es una copia de la sombra: es la misma función ──');
{
  const shadow = readFileSync('api/arena-shadow.js', 'utf8');
  const run = readFileSync('api/arena-run.js', 'utf8');
  ok(/export function runShadowAgent\(args\) \{\s*return runAgenteObjetivo\(\{ \.\.\.args, vivo: false \}\);/.test(shadow),
    'la sombra es un envoltorio de `runAgenteObjetivo` con vivo:false');
  ok(/runAgenteObjetivo\(\{[\s\S]{0,300}?vivo: true/.test(run),
    'y el camino vivo llama a la MISMA función con vivo:true');
  // `buildTargetSystemPrompt` se DEFINE en arena-run (es su casa) y lo IMPORTA
  // la sombra. Lo que no puede haber es dos LLAMADAS: eso serían dos prompts
  // que empiezan iguales y divergen en el primer ajuste.
  const llamadas = [];
  for (const [f, src2] of [['api/arena-run.js', run], ['api/arena-shadow.js', shadow]]) {
    const n = (src2.match(/buildTargetSystemPrompt\(/g) || []).length
      - (src2.match(/export function buildTargetSystemPrompt\(/g) || []).length;
    if (n > 0) llamadas.push(`${f}:${n}`);
  }
  ok(llamadas.length === 1 && llamadas[0].startsWith('api/arena-shadow.js'),
    'el prompt del contrato nuevo se construye en UN solo lugar: dos llamadas serían dos prompts que divergen',
    JSON.stringify(llamadas));

  // El broker se elige en UN solo lugar. Si el vivo pudiera colarse en la
  // sombra, una corrida de sombra podría operar.
  const brokers = (shadow.match(/const broker = vivo \?/g) || []).length;
  ok(brokers === 1, 'el broker (real vs. el que lanza) se elige en UN solo punto', String(brokers));
}

// ── 4) LA REGLA DE LA CASA: NUNCA A MERCADO ──────────────────────────
console.log('\n── límite marketable, en los dos lados ──');
{
  ok(limiteMarketable(100, 'sell') === 99.5, 'vender: por DEBAJO del mercado, para que llene');
  ok(limiteMarketable(100, 'buy') === 100.5, 'comprar: por ENCIMA');
  ok(limiteMarketable(100, 'buy') > limiteMarketable(100, 'sell'),
    'y nunca al revés: un límite del lado pasivo no llena');
  ok(limiteMarketable(0, 'buy') === null && limiteMarketable(null, 'sell') === null,
    'sin referencia NO hay límite: una orden sin precio es una orden a un precio que nadie aprobó');
  ok(String(limiteMarketable(33.333, 'buy')).split('.')[1].length <= 2,
    'redondeado a centavos: Alpaca rechaza un tick más fino y perdería la orden entera',
    String(limiteMarketable(33.333, 'buy')));

  const src = readFileSync('api/_lib/arena-objetivo-vivo.js', 'utf8');
  ok(/createLimitOrder/.test(src) && !/type:\s*['"]market['"]/.test(src),
    'el módulo solo conoce `createLimitOrder`: no hay camino a una orden de mercado');
}

// ── 5) PATAS → ÓRDENES, con todos los frenos ─────────────────────────
console.log('\n── una pata solo se convierte en orden si TODO está confirmado ──');
{
  const legs = [
    { symbol: 'NVDA', side: 'buy', notional: 12000, weight_from: 0, weight_to: 0.12, delta_weight: 0.12 },
    { symbol: 'SINPRECIO', side: 'buy', notional: 5000, weight_from: 0, weight_to: 0.05, delta_weight: 0.05 },
    { symbol: 'NOOPERABLE', side: 'buy', notional: 5000, weight_from: 0, weight_to: 0.05, delta_weight: 0.05 },
    { symbol: 'CARA', side: 'sell', notional: 300, weight_from: 0.05, weight_to: 0.02, delta_weight: -0.03 },
    { symbol: 'CORTO', side: 'short', notional: 4000, weight_from: 0, weight_to: -0.04, delta_weight: -0.04 },
  ];
  const meta = {
    NVDA: { tradable: true, price: 180 },
    SINPRECIO: { tradable: true },
    NOOPERABLE: { price: 50 },
    CARA: { tradable: true, price: 1200 },
    CORTO: { tradable: true, price: 40 },
  };
  const { ordenes, descartadas } = legsAOrdenes({ legs, meta });

  ok(ordenes.length === 1 && ordenes[0].symbol === 'NVDA', 'solo pasa la que tiene todo', JSON.stringify(ordenes.map((o) => o.symbol)));
  ok(ordenes[0].qty === 66 && ordenes[0].limit_price === 180.9,
    'cantidad ENTERA hacia abajo y límite marketable', JSON.stringify([ordenes[0].qty, ordenes[0].limit_price]));
  ok(ordenes[0].intencion === 'buy',
    'la intención original viaja: `sell` y `short` son ambos "sell" para Alpaca y significan cosas opuestas');

  const motivo = (s) => (descartadas.find((d) => d.symbol === s) || {}).motivo || '';
  ok(/sin precio de referencia/.test(motivo('SINPRECIO')), 'sin precio no se manda');
  ok(/no confirma que NOOPERABLE sea operable/.test(motivo('NOOPERABLE')), 'sin fila de Alpaca tampoco');
  ok(/no alcanza para una acción entera/.test(motivo('CARA')),
    'y un movimiento más chico que una acción se NOMBRA, no desaparece');
  ok(/long-only/.test(motivo('CORTO')),
    'una pata de corto en la T2 es un bug del rebalanceo y se descarta en vez de mandarse');
}

// ── 6) EL CANDADO: FRENA LA CORRIDA, NO LA ORDEN ─────────────────────
console.log('\n── una orden inventada frena TODAS las de esa corrida ──');
{
  const sano = verificarOrdenesContraPesos({
    ordenes: [{ symbol: 'NVDA', side: 'buy', qty: 10, delta_weight: 0.1 }],
    target: { NVDA: 0.12 }, current: {},
  });
  ok(sano.ok === true, 'una orden que corresponde a un peso del objetivo pasa');

  const cierre = verificarOrdenesContraPesos({
    ordenes: [{ symbol: 'EOG', side: 'sell', qty: 5, delta_weight: -0.05 }],
    target: {}, current: { EOG: 0.05 },
  });
  ok(cierre.ok === true,
    'y una venta de algo que está en el LIBRO pero no en el objetivo también: eso es un cierre, que es la regla del contrato');

  const huerfana = verificarOrdenesContraPesos({
    ordenes: [{ symbol: 'FANTASMA', side: 'buy', qty: 5, delta_weight: 0.05 }],
    target: { NVDA: 0.12 }, current: { EOG: 0.05 },
  });
  ok(huerfana.ok === false && huerfana.huerfanas[0].symbol === 'FANTASMA',
    'una orden que no sale de ningún lado se detecta', JSON.stringify(huerfana.huerfanas));

  const incoherente = verificarOrdenesContraPesos({
    ordenes: [{ symbol: 'NVDA', side: 'buy', qty: 5, delta_weight: -0.05 }],
    target: { NVDA: 0.12 }, current: {},
  });
  ok(incoherente.ok === false && incoherente.incoherentes.length === 1,
    'y una COMPRA que baja el peso también: el lado y el movimiento se contradicen');

  ok(/NO se manda ninguna orden de esta corrida/.test(huerfana.error),
    'el freno es de la corrida entera: un motor que inventa una orden no se corrige mandando las otras bien');

  // Y el freno se aplica ANTES de mandar, no después de leer el journal.
  const shadow = readFileSync('api/arena-shadow.js', 'utf8');
  const iCandado = shadow.indexOf('verificarOrdenesContraPesos(');
  const iEnviar = shadow.indexOf('await enviarOrdenes(');
  ok(iCandado > 0 && iEnviar > 0 && iCandado < iEnviar,
    'el candado corre ANTES del envío', `${iCandado} < ${iEnviar}`);
  ok(/if \(!candado\.ok\) \{[\s\S]{0,200}?ejecucion\.enviadas = \[\]/.test(shadow),
    'y si falla, `enviadas` queda vacío: no se manda nada');
}

// ── 7) EL ENVÍO ──────────────────────────────────────────────────────
console.log('\n── el envío: secuencial, idempotente, y una falla no tumba el resto ──');
{
  const llamadas = [];
  const fakeCreds = { key: 'k', secret: 's' };
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    llamadas.push(body);
    if (body.symbol === 'ROTA') return { ok: false, status: 422, text: async () => '{"message":"insufficient buying power"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'ord-' + body.symbol, status: 'accepted' }) };
  };
  try {
    const enviadas = await enviarOrdenes({
      ordenes: [
        { symbol: 'AAA', side: 'sell', qty: 5, limit_price: 10 },
        { symbol: 'ROTA', side: 'buy', qty: 3, limit_price: 20 },
        { symbol: 'BBB', side: 'buy', qty: 2, limit_price: 30 },
      ],
      creds: fakeCreds, runDate: '2026-09-18', agentId: 'claude',
    });
    ok(llamadas.length === 3, 'se intentan las tres', String(llamadas.length));
    ok(llamadas.map((c) => c.symbol).join(',') === 'AAA,ROTA,BBB',
      'EN ORDEN: lo que libera capacidad primero. Paralelo dejaría al broker decidiendo eso',
      llamadas.map((c) => c.symbol).join(','));
    ok(enviadas[1].result === 'submit_failed' && enviadas[2].result === 'approved',
      'una orden que falla NO aborta las siguientes: media cartera puesta es un estado real que el próximo rebalanceo corrige');
    ok(/insufficient buying power/.test(enviadas[1].error || ''), 'con el error del broker, no un "falló" mudo');
    ok(llamadas.every((c) => c.type === 'limit' || c.limit_price != null),
      'todas con límite', JSON.stringify(llamadas[0]));
    ok(enviadas[0].client_order_id === enviadas[0].client_order_id && /arena-claude-f-2026-09-18-AAA-sell/.test(enviadas[0].client_order_id),
      'client_order_id determinista: el mismo símbolo en la misma corrida no puede mandarse dos veces',
      enviadas[0].client_order_id);
  } finally { globalThis.fetch = fetchReal; }
}

// ── 8) EL ANUNCIO v4 ─────────────────────────────────────────────────
console.log('\n── el reglamento v4 queda escrito, con su id y su criterio de aborto ──');
{
  process.env.ARENA_CONTRATO = 'objetivo';
  const m = await import('../api/arena-run.js');
  ok(m.CONTRATO_ANNOUNCEMENT_ID === 'arena-contrato-objetivo-2026-09-17',
    'el id es el que pidió Lety: el post-mortem puede partir exactamente acá', m.CONTRATO_ANNOUNCEMENT_ID);
  const t = m.CONTRATO_RULES_TEXT;
  ok(/lo que tenés y NO listás, se vende/i.test(t),
    'y el texto nombra LA regla que cambia todo: omitir un nombre es decidir salir de él');
  ok(/JAMÁS a mercado/.test(t), 'que la regla de la casa no cambia con el contrato');
  ao(t);
  function ao(x) {
    ok(/R11/.test(x), 'que hay un riel nuevo');
    ok(/CANDADO DE EJECUCIÓN/.test(x), 'y el candado de ejecución');
    ok(/NO son comparables en turnover/.test(x),
      'y declara qué deja de ser comparable — un contrato nuevo parte la serie');
  }
  delete process.env.ARENA_CONTRATO;
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
