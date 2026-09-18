// ═══════════════════════════════════════════════════════════════
// tests/arena-universe-tabla-publica.test.mjs — que el `note` nombre la causa.
//
// EL PROBLEMA (2026-09-18, reportado desde el curl de producción): el Nasdaq
// 100 salió con `source: "none"` y un `note` que solo hablaba de poner una URL
// de CSV en ARENA_HOLDINGS_URL_NASDAQ100. Ese texto se escribió cuando la
// única fuente era Invesco; con las tablas públicas cableadas hay TRES formas
// distintas de terminar ahí y las tres daban el mismo mensaje, así que leerlo
// mandaba a buscar una URL cuando el problema podía ser otro.
//
// Lo que más importa acá: `resumenTablaPublica` devuelve NULL cuando el paso ni
// se intentó. Eso distingue "el código nuevo no está en este deploy" de "corrió
// y falló", que es justo la pregunta que no se podía contestar desde el curl.
// Correr con `node tests/arena-universe-tabla-publica.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { resumenTablaPublica } from '../api/_lib/arena-universe.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── null significa "ni se intentó" ──');
{
  ok(resumenTablaPublica([], 'nasdaq100') === null,
    'sin filas de tabla_publica → null: el paso no corrió, y eso es una respuesta (el deploy no llegó)');
  ok(resumenTablaPublica(null, 'nasdaq100') === null, 'diag null tampoco explota');
  ok(resumenTablaPublica([{ fuente: 'etf', index: 'nasdaq100', ok: false }], 'nasdaq100') === null,
    'las filas de OTRA fuente no cuentan: el ETF fallando no dice nada de las tablas');
  ok(resumenTablaPublica([{ fuente: 'tabla_publica', index: 'sp500', ok: false, reason: 'x' }], 'nasdaq100') === null,
    'ni las de otro índice');
}

console.log('\n── cuando sí corrió, dice qué pasó ──');
{
  const caido = resumenTablaPublica([{ fuente: 'tabla_publica', index: 'nasdaq100', origen: 'slickcharts', ok: false, reason: 'fallo', status: 403 }], 'nasdaq100');
  ok(/slickcharts/.test(caido) && /403/.test(caido), 'una fuente caída sale con su nombre y su status', caido);

  const cruce = resumenTablaPublica([{ fuente: 'tabla_publica', index: 'nasdaq100', ok: false, reason: 'cruce_insuficiente', ratio: 0.4, detail: 'no coinciden' }], 'nasdaq100');
  ok(/cruce_insuficiente/.test(cruce) && /40%/.test(cruce),
    'un cruce fallido sale con el porcentaje de coincidencia, que es el número que dice si el parser está leyendo otra cosa', cruce);

  const larga = resumenTablaPublica([{ fuente: 'tabla_publica', index: 'nasdaq100', origen: 'wikipedia', ok: false, reason: 'lista_larga', recibidos: 300 }], 'nasdaq100');
  ok(/lista_larga/.test(larga) && /300 nombres/.test(larga), 'y una lista fuera de la horquilla, con cuántos llegaron', larga);

  const todoOk = resumenTablaPublica([{ fuente: 'tabla_publica', index: 'nasdaq100', origen: 'wikipedia', ok: true, recibidos: 100 }], 'nasdaq100');
  ok(todoOk && !/null/.test(String(todoOk)),
    'si se intentó y nada falló, lo dice en vez de devolver null: "corrió bien" y "no corrió" no pueden verse igual', String(todoOk));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
