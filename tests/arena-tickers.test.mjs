// ═══════════════════════════════════════════════════════════════
// tests/arena-tickers.test.mjs — el objetivo nombra símbolos REALES.
//
// EL BUG (sombra de los siete, 2026-09-17): deepseek devolvió
// `{"EO G": 0.15, "FS LR": 0.1}` — EOG y FSLR con un espacio adentro. El JSON
// era válido, los pesos eran válidos, y los diez rieles lo aprobaron entero.
//
// Lo que faltaba no era un riel más estricto: era la pregunta. Los rieles
// juzgan una CARTERA (pesos, concentración, cortos) y ninguno preguntaba si el
// NOMBRE existe. En vivo, el motor habría mandado una orden sobre un ticker
// inexistente — y `rail_meta` lo veía ("2 nombres sin fila de /v2/assets") sin
// que eso frenara nada.
//
// DE DÓNDE SALE EL ESPACIO: no de nuestro código, y este archivo lo congela.
// Todos los `join` del camino de salida son `join('')`, la compactación solo
// reescribe mensajes `tool`, y el turno de cierre no se compacta. El JSON llegó
// bien formado con el espacio DENTRO de la clave: lo emitió el modelo.
//
// Correr con `node tests/arena-tickers.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { normalizarTickersObjetivo, validateTarget, RAILS } from '../api/_lib/arena-rails.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const UNIVERSO = ['EOG', 'FSLR', 'JBHT', 'NVDA', 'DELL', 'BRK.B'];

// ── 1) EL CASO EXACTO ────────────────────────────────────────────────
console.log('\n── el objetivo de deepseek, tal cual llegó ──');
{
  const r = normalizarTickersObjetivo({ 'EO G': 0.25, 'FS LR': 0.2, JBHT: 0.15 }, { universo: UNIVERSO });
  ok(r.ok === true, 'se acepta: los tres nombres existen una vez canonicalizados');
  ok(JSON.stringify(r.weights) === JSON.stringify({ EOG: 0.25, FSLR: 0.2, JBHT: 0.15 }),
    'y los pesos quedan bajo el símbolo real', JSON.stringify(r.weights));
  ok(r.reparados.length === 2 && r.reparados[0].pedido === 'EO G' && r.reparados[0].normalizado === 'EOG',
    'las dos reparaciones se REPORTAN: esconderlas es cómo se deja de notar que un modelo corrompe tickers',
    JSON.stringify(r.reparados));

  // Quitar espacios NO es adivinar: un ticker no puede contener uno. Lo que sí
  // sería adivinar es aceptar el resultado sin verificarlo — y eso no pasa.
  const inventado = normalizarTickersObjetivo({ 'ZZ QQ': 0.1 }, { universo: UNIVERSO });
  ok(inventado.ok === false, 'un símbolo que NO existe ni después de normalizar se rechaza');
  ok(/tampoco está en el universo/.test(inventado.error),
    'y el error dice que la normalización se intentó y no alcanzó', inventado.error.slice(0, 90));
}

// ── 2) SE RECHAZA EL OBJETIVO ENTERO, NO LA POSICIÓN ─────────────────
console.log('\n── una cartera a la que se le saca una pata ya no es la que decidió el PM ──');
{
  const r = normalizarTickersObjetivo({ NVDA: 0.2, ZZQQ: 0.1, DELL: 0.15 }, { universo: UNIVERSO });
  ok(r.ok === false, 'un solo símbolo inventado invalida el objetivo completo');
  ok(/objetivo ENTERO/.test(r.error), 'y se dice por qué', r.error.slice(-80));
  ok(r.desconocidos.length === 1 && r.desconocidos[0].pedido === 'ZZQQ',
    'nombrando cuál fue', JSON.stringify(r.desconocidos));
}

// ── 3) LOS BORDES ────────────────────────────────────────────────────
console.log('\n── los bordes de la normalización ──');
{
  ok(normalizarTickersObjetivo({ 'brk.b': 0.1 }, { universo: UNIVERSO }).weights['BRK.B'] === 0.1,
    'el punto de las clases de acciones sobrevive (BRK.B)');
  ok(normalizarTickersObjetivo({ '  NVDA  ': 0.1 }, { universo: UNIVERSO }).weights.NVDA === 0.1,
    'los espacios de los bordes ya los quitaba el parser, y siguen quitándose');

  // Dos claves que colapsan al mismo símbolo: sumarlas inventaría un peso.
  const col = normalizarTickersObjetivo({ 'NV DA': 0.1, NVDA: 0.2 }, { universo: UNIVERSO });
  ok(col.ok === false && col.colisiones.length === 1,
    'dos claves que normalizan al mismo símbolo NO se suman: eso sería inventar un peso',
    JSON.stringify(col.colisiones));

  const basura = normalizarTickersObjetivo({ '!!!': 0.1 }, { universo: UNIVERSO });
  ok(basura.ok === false && /no queda nada/.test(basura.desconocidos[0].motivo),
    'una clave que no deja nada usable se nombra en vez de desaparecer');

  // Sin universo NO se inventa una validación: se normaliza y se DECLARA que no
  // se pudo verificar. Fingir que se validó sería peor que no validar.
  const sinUni = normalizarTickersObjetivo({ 'EO G': 0.1 }, {});
  ok(sinUni.ok === true && sinUni.validado_contra_universo === false,
    'sin universo se normaliza pero se declara que NO se validó', String(sinUni.validado_contra_universo));
}

// ── 4) R11: EL SÍMBOLO TIENE QUE SER OPERABLE ────────────────────────
// La segunda mitad, y la que de verdad frena una orden: el universo dice que el
// nombre existe; Alpaca dice si se puede operar HOY. Son dos preguntas.
console.log('\n── R11: sin fila de Alpaca no se manda una orden ──');
{
  const sinFila = validateTarget({ EOG: 0.1 }, { EOG: {} }, RAILS);
  ok(sinFila.violations.some((v) => v.rail === 'R11'),
    'un LARGO sin fila de /v2/assets es violación — antes pasaba los diez rieles',
    JSON.stringify(sinFila.violations.map((v) => v.rail)));
  ok(/sin fila en \/v2\/assets/.test(sinFila.violations.find((v) => v.rail === 'R11').detail),
    'y el detalle dice exactamente qué falta');

  const conFila = validateTarget({ EOG: 0.1 }, { EOG: { tradable: true, sector: 'XLE' } }, RAILS);
  ok(!conFila.violations.length, 'con la fila confirmada, pasa', JSON.stringify(conFila.violations));

  const noOperable = validateTarget({ EOG: 0.1 }, { EOG: { tradable: false, sector: 'XLE' } }, RAILS);
  ok(noOperable.violations.some((v) => v.rail === 'R11'),
    'y un símbolo que existe pero NO es operable también se frena: fail closed cubre los dos casos');

  // R11 aplica a los cortos igual, además de R9.
  const corto = validateTarget({ EOG: -0.08 }, { EOG: { shortable: true, easy_to_borrow: true, sector: 'XLE' } }, RAILS);
  ok(corto.violations.some((v) => v.rail === 'R11'),
    'un corto con borrow confirmado pero sin `tradable` tampoco pasa');
}

// ── 5) EL ORDEN NO ES NEGOCIABLE ─────────────────────────────────────
// Validar los nombres DESPUÉS de los rieles sería evaluar la concentración
// sectorial de una cartera que contiene un símbolo que no existe.
console.log('\n── los tickers se validan ANTES de los rieles ──');
{
  const src = readFileSync('api/arena-shadow.js', 'utf8');
  const iTick = src.indexOf('normalizarTickersObjetivo(');
  const iRieles = src.indexOf('validateTarget(');
  ok(iTick > 0 && iRieles > 0 && iTick < iRieles,
    'en la sombra, la normalización ocurre antes de validateTarget', `${iTick} < ${iRieles}`);
  ok(/status: 'rejected_tickers'/.test(src),
    'y un objetivo con símbolos inventados tiene su propio estado, distinto de `rejected_rails`');

  // EL LINT: cualquier archivo que valide rieles tiene que normalizar primero.
  // Cuando el contrato nuevo se encienda en el camino VIVO, este test se pone
  // rojo si alguien conecta los rieles sin este paso — que es exactamente el
  // momento en que el bug pasaría de la sombra a una orden real.
  for (const f of ['api/arena-shadow.js', 'api/arena-run.js']) {
    const s2 = readFileSync(f, 'utf8');
    if (!s2.includes('validateTarget(')) continue;
    ok(s2.includes('normalizarTickersObjetivo('),
      `${f} valida rieles Y normaliza tickers: nunca uno sin el otro`);
  }
}

// ── 6) EL ESPACIO NO SALE DE NUESTRO CÓDIGO ──────────────────────────
console.log('\n── el camino de salida no inyecta separadores ──');
{
  for (const f of ['api/_lib/arena-model.js', 'api/_lib/arena-tool-loop.js', 'api/arena-shadow.js']) {
    const s2 = readFileSync(f, 'utf8');
    // `join(' ')` sobre fragmentos de la respuesta del modelo es la forma
    // clásica de que aparezca un espacio donde no había ninguno.
    const sospechosos = (s2.match(/\.map\([^)]*\)\.join\(' '\)/g) || []);
    ok(sospechosos.length === 0,
      `${f}: ningún map().join(' ') sobre el texto del modelo`, sospechosos.join(' | '));
  }
  const loop = readFileSync('api/_lib/arena-tool-loop.js', 'utf8');
  ok(/m\.role === 'tool'/.test(loop) && !/role === 'assistant'.*compactarResultado/s.test(loop),
    'la compactación reescribe mensajes `tool`, nunca el contenido del asistente');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
