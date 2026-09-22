// tests/arena-no-admitidos — lo que se muestra contra lo que se puede comprar.
import { marcarNoAdmitidos } from '../api/arena-run.js';
let failures = 0;
const ok = (c, n, d) => { if (c) console.log('  PASS', n); else { failures++; console.error('  FAIL', n, d !== undefined ? '→ ' + d : ''); } };

console.log('\n── el caso XENE ──');
{
  const movers = { gainers: [{ symbol: 'NVDA' }], losers: [{ symbol: 'XENE', change_pct: -30 }], actives: [] };
  const r = marcarNoAdmitidos({ movers, screener: null, notable_insider_buys: [] }, ['NVDA', 'AMD']);
  ok(movers.losers[0].no_admitido === true, 'XENE queda marcado en SU PROPIA FILA, no en una lista aparte que habría que cruzar');
  // ── LA ASERCIÓN CAMBIÓ EL 2026-09-22, CON SU MOTIVO ──────────────
  // Decía `/CANNOT hold/`, y ese texto era la instrucción que producía la
  // liquidación forzada: deepseek compró NKE al 25% por la mañana y lo
  // vendió por la tarde "porque el universo admisible de hoy fuerza la
  // salida". El universo del día decide lo que se puede ABRIR o AGRANDAR,
  // no lo que se puede TENER. La consecuencia se sigue diciendo —el punto
  // original de la aserción— pero la correcta.
  ok(/cannot OPEN or ADD/.test(movers.losers[0].nota_admision),
    'y la nota dice la consecuencia: no se puede ABRIR ni AGRANDAR', movers.losers[0].nota_admision);
  ok(!/CANNOT hold/i.test(movers.losers[0].nota_admision),
    'y NO dice que no se pueda tener: una posición abierta no la cierra la rotación de una lista');
  ok(/holding or reducing it is fine/.test(movers.losers[0].nota_admision),
    'lo dice explícito, porque el silencio se leyó como prohibición');
  ok(movers.gainers[0].no_admitido === undefined, 'un nombre admitido NO se marca: una marca en todos no marca nada');
  ok(r.total === 1 && r.simbolos[0].symbol === 'XENE', 'el resumen para el journal trae el conteo y el nombre', JSON.stringify(r.simbolos));
  ok(r.simbolos[0].canales.includes('movers:losers'), 'con el canal por el que entró, que es donde hay que mirar');
}

console.log('\n── se marca contra el universo QUE VALIDA, no contra otra admisión ──');
{
  // El bug de fondo: los canales corren su propia admisión y el universo la
  // suya. El único conjunto que decide es el del universo.
  const movers = { gainers: [], losers: [{ symbol: 'ZM' }], actives: [] };
  const screener = { value: [{ symbol: 'ZM' }], momentum: [] };
  const r = marcarNoAdmitidos({ movers, screener, notable_insider_buys: [] }, ['NVDA']);
  ok(movers.losers[0].no_admitido && screener.value[0].no_admitido, 'marca en TODOS los canales, no solo en movers');
  ok(r.simbolos[0].canales.length === 2, 'y un nombre que entra por dos canales se reporta una vez con los dos', JSON.stringify(r.simbolos[0]));
}

console.log('\n── sin universo no se afirma nada ──');
{
  const movers = { gainers: [{ symbol: 'NVDA' }], losers: [], actives: [] };
  ok(marcarNoAdmitidos({ movers }, null) === null, 'sin universo devuelve null: marcar todo como no admitido sería peor que no marcar');
  ok(marcarNoAdmitidos({ movers }, []) === null, 'una lista vacía tampoco se toma como universo');
  ok(movers.gainers[0].no_admitido === undefined, 'y no toca las filas');
}

console.log('\n── nada roto con canales ausentes ──');
{
  const r = marcarNoAdmitidos({}, ['NVDA']);
  ok(r && r.total === 0, 'sin canales no explota y reporta cero');
  ok(/están en el universo/.test(r.nota), 'y lo dice en positivo cuando no hay nada fuera', r.nota);
  const insiders = [{ ticker: 'XENE' }];
  const r2 = marcarNoAdmitidos({ notable_insider_buys: insiders }, ['NVDA']);
  ok(insiders[0].no_admitido === true, 'los insiders se marcan por `ticker`, que es su campo (no `symbol`)');
  ok(r2.total === 1, 'y cuentan en el resumen');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
