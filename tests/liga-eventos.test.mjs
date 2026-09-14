// ═══════════════════════════════════════════════════════════════
// tests/liga-eventos.test.mjs — /api/liga/eventos + TEMPORADA.
//
// Cubre las dos piezas del addendum que no son la voz:
//   - el feed de eventos (compras, ventas, rechazos del guard, cambios de
//     líder) y sus reglas de clasificación;
//   - la temporada en el registry (ventana de 4 semanas, cierre en viernes) y
//     el ranking con el que se declara al ganador el último día.
// El handler se prueba de punta a punta con el journal mockeado a nivel fetch.
// Correr con `node tests/liga-eventos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
delete process.env.ARENA_LEAGUE;
delete process.env.ARENA_BASELINE_EQUITY;

import handler, { eventosDeFila, cambiosDeLider, clasificarRechazo, TIPOS } from '../api/liga-eventos.js';
import { ARENA_SEASON, seasonStatus, seasonDay, isSeasonFinalDay } from '../api/_lib/arena-registry.js';
import { rankSeasonStandings, SEASON_WINNER_ID, BASELINE_EQUITY } from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ═══ TEMPORADA ═════════════════════════════════════════════════════
console.log('temporada: ventana de 4 semanas de mercado, cierre en viernes');
const et = (d) => new Date(d + 'T22:40:00Z'); // la hora del cron de decide
ok(ARENA_SEASON.id === 'T2' && ARENA_SEASON.weeks === 4, 'T2, cuatro semanas', JSON.stringify({ id: ARENA_SEASON.id, w: ARENA_SEASON.weeks }));
ok(new Date(ARENA_SEASON.end + 'T12:00:00Z').getUTCDay() === 5,
  'el cierre cae en VIERNES: un fin de semana no tendría corrida y el ganador no se declararía nunca', ARENA_SEASON.end);
ok(new Date(ARENA_SEASON.start + 'T12:00:00Z').getUTCDay() === 1, 'y la apertura en lunes', ARENA_SEASON.start);
ok(seasonStatus(et('2026-09-13')) === 'pending', 'antes del arranque → pending');
ok(seasonStatus(et(ARENA_SEASON.start)) === 'running' && seasonDay(et(ARENA_SEASON.start)) === 1, 'el día de apertura es el día 1');
ok(seasonStatus(et(ARENA_SEASON.end)) === 'running', 'el último día la temporada SIGUE corriendo (hay que operar y declarar)');
ok(seasonStatus(et('2026-10-12')) === 'ended' && seasonDay(et('2026-10-12')) === null,
  'pasado el cierre → ended, y el día de temporada es null (no un número que siga creciendo)');
ok(isSeasonFinalDay(et(ARENA_SEASON.end)) === true && isSeasonFinalDay(et('2026-10-08')) === false,
  'isSeasonFinalDay solo es cierto el último día', ARENA_SEASON.end);

console.log('temporada: ranking del cierre');
const r = rankSeasonStandings([
  { id: 'claude', name: 'Claude', equity: 104000, status: 'ok' },
  { id: 'qwen', name: 'Qwen', equity: 110500, status: 'ok' },
  { id: 'grok', name: 'Grok', equity: 98000, status: 'ok' },
  { id: 'gemini', name: 'Gemini', status: 'aborted_no_alpaca_keys', error: 'faltan keys' },
  { id: 'deepseek', name: 'DeepSeek', equity: 0, status: 'error' },
]);
ok(r.winner.id === 'qwen' && r.standings[0].rank === 1, 'gana el equity más alto', JSON.stringify(r.winner));
ok(r.standings.map((x) => x.id).join(',') === 'qwen,claude,grok', 'ranking por equity desc', JSON.stringify(r.standings.map((x) => x.id)));
ok(r.standings[0].return_pct === 10.5 && r.standings[2].return_pct === -2,
  'el return vs. baseline viaja al lado del equity (el caveat de la ventaja del insignia se lee ahí)',
  JSON.stringify(r.standings.map((x) => x.return_pct)));
ok(r.sin_equity.length === 2 && r.sin_equity.map((x) => x.id).sort().join(',') === 'deepseek,gemini',
  'un agente sin equity NO se rankea ni se le inventa un cero: sale aparte, nombrado', JSON.stringify(r.sin_equity));
ok(rankSeasonStandings([]).winner === null, 'sin nadie con equity no hay ganador (no se declara uno inventado)');
ok(SEASON_WINNER_ID === 'arena-temporada-T2-ganador' && BASELINE_EQUITY === 100000,
  'id idempotente del cierre + baseline por default', SEASON_WINNER_ID);

// ═══ clasificación de rechazos ═════════════════════════════════════
console.log('eventos: por qué NO se ejecutó una acción');
ok(clasificarRechazo('FAKEZ: no existe en el symbol map US') === 'guard', 'descarte por regla del guard');
ok(clasificarRechazo('NVDA: salida de riesgo determinista (delever) tiene precedencia sobre la acción del PM') === 'precedencia_riesgo',
  'la red determinista le ganó al PM sobre el mismo nombre');
ok(clasificarRechazo('AAPL: compra suprimida — corrida por evento (post_earnings_morning)') === 'supresion',
  'compra suprimida (breaker desapalancando o corrida por evento)');

// ═══ eventos de una fila del journal ═══════════════════════════════
console.log('eventos: una corrida del journal → sus eventos');
const fila = {
  agent_id: 'grok', run_date: '2026-09-16', status: 'ok', created_at: '2026-09-16T22:41:00Z',
  headline: { text: 'Entro a AAPL y no me tiembla el pulso.' },
  actions: [
    { symbol: 'AAPL', side: 'buy', qty: 25, limit_price: 200, notional: 5000, result: 'approved', origin: 'scout_picked', channels: ['movers'], reasoning: 'momentum', order_status: 'accepted' },
    { symbol: 'KO', side: 'sell', qty: 10, limit_price: 57.6, notional: 576, result: 'approved', repriced: 'marketable_sell', limit_price_proposed: 60, channels: [], order_status: 'filled', filled_avg_price: 57.9, filled_qty: 10, filled_at: '2026-09-17T13:31:00Z' },
    { symbol: 'FAKEZ', side: 'buy', result: 'discarded', reason: 'FAKEZ: no existe en el symbol map US' },
    { symbol: 'MU', side: 'buy', qty: 5, limit_price: 100, result: 'submit_failed', reason: 'Alpaca 500' },
  ],
};
const evs = eventosDeFila(fila, 'Grok');
ok(evs.length === 3, 'tres eventos: la compra, la venta y el rechazo — submit_failed NO cuenta (no llegó al mercado)', JSON.stringify(evs.map((e) => e.tipo + ':' + e.simbolo)));
const compra = evs.find((e) => e.simbolo === 'AAPL');
ok(compra.tipo === 'compra' && compra.qty === 25 && compra.precio === 200 && compra.canales.join() === 'movers',
  'la compra lleva qty, precio y el canal del que salió', JSON.stringify(compra));
ok(evs.every((e) => e.titular === 'Entro a AAPL y no me tiembla el pulso.'),
  'el titular de la corrida viaja pegado a CADA evento (la UI no tiene que cruzar dos colecciones)');
const venta = evs.find((e) => e.simbolo === 'KO');
ok(venta.tipo === 'venta' && venta.repreciada === 'marketable_sell' && venta.precio_pedido === 60 && venta.precio === 57.6,
  'la venta re-preciada muestra el antes (60) y el después (57.6): el marketable queda auditable', JSON.stringify(venta));
ok(venta.fill && venta.fill.precio === 57.9, 'y el fill real cuando existe', JSON.stringify(venta.fill));
const rechazo = evs.find((e) => e.tipo === 'rechazo');
ok(rechazo.motivo === 'guard' && /symbol map/.test(rechazo.razon) && rechazo.qty === null,
  'el rechazo lleva la razón verbatim; sin qty aprobada, null honesto', JSON.stringify(rechazo));

// Salida determinista: es una venta con su `origen`, no un evento aparte.
const filaRiesgo = {
  agent_id: 'claude', run_date: '2026-09-16', status: 'risk_exit', created_at: '2026-09-16T22:40:30Z', headline: null,
  actions: [{ symbol: 'NVDA', side: 'sell', qty: 12, limit_price: 158.4, notional: 1900.8, result: 'approved', origin: 'trailing_stop', channels: ['risk_exit'], order_status: 'accepted' }],
};
const evRiesgo = eventosDeFila(filaRiesgo, 'Claude')[0];
ok(evRiesgo.tipo === 'venta' && evRiesgo.origen === 'trailing_stop' && evRiesgo.canales.includes('risk_exit'),
  'una salida de la red determinista es una VENTA con su origen (trailing_stop), no un tipo aparte', JSON.stringify(evRiesgo));
ok(evRiesgo.titular === null, 'una fila sin titular no inventa uno');

// ═══ cambios de líder ══════════════════════════════════════════════
console.log('eventos: cambios de líder');
const serie = {
  '2026-09-14': { claude: 100500, qwen: 100200 },
  '2026-09-15': { claude: 100800, qwen: 100400 },   // sin cambio
  '2026-09-16': { claude: 100300, qwen: 101900 },   // qwen adelanta
  '2026-09-17': { claude: 99000 },                   // un solo agente: NO evalúa
  '2026-09-18': { claude: 103000, qwen: 101000 },   // claude recupera
};
const lid = cambiosDeLider(serie, { claude: 'Claude', qwen: 'Qwen' });
ok(lid.length === 3, 'tres hitos: arranque + dos cambios reales', JSON.stringify(lid.map((e) => e.fecha + ':' + e.agente)));
ok(lid[0].arranque === true && lid[0].anterior === null,
  'el primer día medible se marca `arranque`, no "cambio" (no había líder previo)', JSON.stringify(lid[0]));
ok(lid[1].fecha === '2026-09-16' && lid[1].agente === 'qwen' && lid[1].anterior.agente === 'claude',
  'el cambio nombra al nuevo líder y al que desplazó', JSON.stringify(lid[1]));
ok(lid[1].return_pct === 1.9, 'con su return vs. baseline ya calculado', String(lid[1].return_pct));
ok(!lid.some((e) => e.fecha === '2026-09-17'),
  'un día con UN solo agente reportando equity no genera cambio de líder (sería un liderazgo falso)');
ok(lid[2].fecha === '2026-09-18' && lid[2].agente === 'claude', 'y el desempate posterior vuelve a registrarse', JSON.stringify(lid[2]));
ok(cambiosDeLider({}, {}).length === 0, 'sin serie, sin eventos');

// ═══ handler de punta a punta ══════════════════════════════════════
console.log('eventos: handler /api/liga/eventos (solo lectura)');
const neonQueries = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('neon.tech')) throw new Error('el endpoint NO debe llamar a nada que no sea el journal: ' + u);
  const body = JSON.parse(opts.body);
  neonQueries.push(body.query);
  const F = ['id', 'agent_id', 'run_date', 'status', 'created_at', 'actions', 'equity', 'headline'];
  const rows = [
    ['r1', 'claude', '2026-09-15', 'ok', '2026-09-15T22:41:00Z', JSON.stringify([{ symbol: 'AAPL', side: 'buy', qty: 5, limit_price: 200, result: 'approved' }]), '100500', JSON.stringify({ text: 'Compro AAPL.' })],
    ['r2', 'qwen', '2026-09-15', 'ok', '2026-09-15T22:41:10Z', JSON.stringify([{ symbol: 'KO', side: 'buy', result: 'discarded', reason: 'KO: sub-$1' }]), '100100', null],
    ['r3', 'qwen', '2026-09-16', 'ok', '2026-09-16T22:41:00Z', JSON.stringify([{ symbol: 'MU', side: 'sell', qty: 3, limit_price: 90, result: 'approved', origin: 'trailing_stop' }]), '101900', null],
    ['r4', 'claude', '2026-09-16', 'ok', '2026-09-16T22:41:05Z', JSON.stringify([]), '100300', null],
  ];
  return {
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({ fields: F.map((name) => ({ name, dataTypeID: name === 'actions' || name === 'headline' ? 3802 : (name === 'equity' ? 1700 : 25) })), rows }),
    text: async () => '',
  };
};
const mkRes = () => {
  const r = { headers: {}, code: null, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
};

let res = mkRes();
await handler({ method: 'GET', query: {} }, res);
ok(res.code === 200 && Array.isArray(res.body.eventos), 'responde 200 con el feed', String(res.code));
ok(neonQueries.length === 1 && /^\s*select/i.test(neonQueries[0].trim()),
  'UNA sola consulta y es un SELECT: cero writes, como la auditoría', JSON.stringify(neonQueries.length));
ok(!/ensure|create table|alter table|insert|update/i.test(neonQueries[0]),
  'la consulta no crea, no migra y no escribe nada');
ok(/context->'headline'/.test(neonQueries[0]) && !/context\s*,/.test(neonQueries[0]),
  'del context se proyecta SOLO el titular (el resto son los prompts completos: megabytes)', neonQueries[0].slice(0, 120));
ok(/<> 'league'/.test(neonQueries[0]), "las filas marcadoras de liga quedan fuera: no son eventos de orden");

const tipos = res.body.eventos.map((e) => e.tipo);
ok(tipos.filter((t) => t === 'compra').length === 1 && tipos.filter((t) => t === 'venta').length === 1 && tipos.filter((t) => t === 'rechazo').length === 1,
  'una compra, una venta y un rechazo del guard', JSON.stringify(tipos));
ok(tipos.includes('cambio_lider'), 'y el cambio de líder calculado sobre el equity journaleado', JSON.stringify(tipos));
ok(res.body.eventos[0].fecha >= res.body.eventos[res.body.eventos.length - 1].fecha,
  'ordenado del más reciente al más viejo', JSON.stringify(res.body.eventos.map((e) => e.fecha)));
ok(res.body.temporada.id === 'T2' && res.body.temporada.start === ARENA_SEASON.start,
  'el feed viene con la temporada en curso', JSON.stringify(res.body.temporada));
ok(res.body.conteos && TIPOS.every((t) => t in res.body.conteos), 'con conteos por tipo', JSON.stringify(res.body.conteos));
ok(/s-maxage/.test(res.headers['Cache-Control'] || ''), 'cacheado en el edge como el leaderboard', res.headers['Cache-Control']);

res = mkRes();
await handler({ method: 'GET', query: { tipo: 'rechazo' } }, res);
ok(res.body.eventos.every((e) => e.tipo === 'rechazo') && res.body.eventos.length === 1,
  '?tipo=rechazo filtra el feed', JSON.stringify(res.body.eventos.map((e) => e.tipo)));

res = mkRes();
await handler({ method: 'GET', query: { agente: 'qwen' } }, res);
ok(res.body.eventos.filter((e) => e.tipo !== 'cambio_lider').every((e) => e.agente === 'qwen'),
  '?agente=qwen filtra las órdenes a ese agente', JSON.stringify(res.body.eventos.map((e) => e.agente)));
ok(res.body.eventos.some((e) => e.tipo === 'cambio_lider'),
  'el liderazgo se calcula con TODA la liga aunque se filtre por un agente (si no, sería un ranking de uno)');

res = mkRes();
await handler({ method: 'GET', query: { limit: '1' } }, res);
ok(res.body.eventos.length === 1 && res.body.truncado === true, '?limit recorta y avisa con truncado:true', JSON.stringify({ n: res.body.eventos.length, t: res.body.truncado }));

res = mkRes();
await handler({ method: 'POST', query: {} }, res);
ok(res.code === 405, 'solo GET: un POST se rechaza (es un endpoint de lectura)', String(res.code));

// DB caída → respuesta honesta, no un 500 ni un feed vacío que parezca real.
global.fetch = async () => { throw new Error('neon caído'); };
res = mkRes();
await handler({ method: 'GET', query: {} }, res);
ok(res.code === 200 && res.body.error && res.body.eventos.length === 0,
  'journal caído → error explícito y feed vacío (hueco honesto)', JSON.stringify(res.body.error));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
