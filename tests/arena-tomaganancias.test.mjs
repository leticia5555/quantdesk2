// ═══════════════════════════════════════════════════════════════
// tests/arena-tomaganancias.test.mjs — la capa de toma de ganancias.
//
// Qué habría pasado si cada agente vendiera todo al llegar a +X% en el día.
// Mismas decisiones, resultado alternativo.
//
// Lo que se blinda:
//
//   1. UN DISPARO ES UN HECHO; LA AUSENCIA DE DISPARO NO ES UNA PRUEBA. Con
//      muestreo cada 5 min, el equity pudo tocar el umbral entre dos muestras
//      y volver. El conteo es un PISO, y la respuesta lo dice DONDE se lee la
//      conclusión — no en una nota al pie.
//   2. EL SESGO DE LA CONTRAFACTUAL VA A FAVOR DE LA REGLA. Sin costos ni
//      slippage, la regla siempre se ve mejor de lo que sería. Eso se declara:
//      es la dirección peligrosa, la que hace comprar una estrategia mala.
//   3. DISPARAR EN LA ÚLTIMA MUESTRA NO ES UN ACIERTO. Si la regla vende en el
//      cierre, no cambió nada, y contarlo como "ganó 0" infla los aciertos.
//   4. NO TOCA LA LIGA. Cero escrituras, cero órdenes.
//
// Correr con `node tests/arena-tomaganancias.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { simularUmbral, simularDia, barrer, UMBRAL_DEFAULT } from '../api/_lib/arena-tomaganancias.js';
import { serieDe } from '../api/_lib/arena-equity.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// El día que motiva la regla: sube, toca su pico y lo devuelve.
const devuelto = serieDe([
  { minuto: '2026-09-18T13:30:00Z', equity: '100000' },
  { minuto: '2026-09-18T15:00:00Z', equity: '102400' },
  { minuto: '2026-09-18T16:00:00Z', equity: '103800' },
  { minuto: '2026-09-18T19:55:00Z', equity: '101100' },
]);

console.log('\n── el caso que motiva la regla: subió y lo devolvió ──');
{
  const r = simularUmbral(devuelto, { umbral: 0.02 });
  ok(r.disparo === true && r.disparo_ts === '2026-09-18T15:00:00Z',
    'dispara en la PRIMERA muestra que toca el umbral, no en la mejor');
  ok(r.equity_con_regla === 102400 && r.equity_real === 101100,
    'sale a ese equity y el real es el del cierre', `${r.equity_con_regla} vs ${r.equity_real}`);
  ok(r.diferencia === 1300, 'la diferencia es a favor de la regla ese día', String(r.diferencia));
  ok(/la regla gana/.test(r.lectura), 'y la lectura lo dice en una línea', r.lectura);
}

console.log('\n── el caso contrario: el día siguió subiendo ──');
{
  const siguio = serieDe([
    { minuto: '2026-09-18T13:30:00Z', equity: '100000' },
    { minuto: '2026-09-18T15:00:00Z', equity: '102400' },
    { minuto: '2026-09-18T19:55:00Z', equity: '108000' },
  ]);
  const r = simularUmbral(siguio, { umbral: 0.02 });
  ok(r.disparo === true && r.diferencia === -5600,
    'la regla PIERDE cuando el día siguió: salir temprano cuesta', String(r.diferencia));
  ok(/la regla cuesta/.test(r.lectura), 'y se dice así, sin suavizarlo', r.lectura);
}

console.log('\n── la ausencia de disparo NO es una prueba ──');
{
  const plano = serieDe([
    { minuto: '2026-09-18T13:30:00Z', equity: '100000' },
    { minuto: '2026-09-18T19:55:00Z', equity: '100500' },
  ]);
  const r = simularUmbral(plano, { umbral: 0.02 });
  ok(r.disparo === false && r.diferencia === 0,
    'sin disparo, la contrafactual es idéntica al día real');
  ok(/NO prueba que el equity nunca llegó/.test(r.nota) && /pudo tocarlo entre dos muestras/.test(r.nota),
    'y la nota va DONDE se lee la conclusión: es un "no lo vimos", no un "no pasó"', r.nota);
  ok(r.muestras === 2, 'con cuántas muestras tuvo el día — dos muestras no son un día observado', String(r.muestras));
}

console.log('\n── disparar en la última muestra no es un acierto ──');
{
  const alFinal = serieDe([
    { minuto: '2026-09-18T13:30:00Z', equity: '100000' },
    { minuto: '2026-09-18T19:55:00Z', equity: '103000' },
  ]);
  const r = simularUmbral(alFinal, { umbral: 0.02 });
  ok(r.disparo === true && r.diferencia === 0 && r.muestras_despues === 0,
    'si vende en el cierre no cambió nada, y `muestras_despues: 0` lo dice — contarlo como acierto inflaría el resultado',
    JSON.stringify({ dif: r.diferencia, despues: r.muestras_despues }));
  ok(/no cambió nada/.test(r.lectura), 'la lectura no lo vende como una ganancia', r.lectura);
}

console.log('\n── sin serie, no se inventa un resultado ──');
{
  const r = simularUmbral(serieDe([]), { umbral: 0.02 });
  ok(r.aplicable === false && r.diferencia === undefined,
    'un día sin muestras sale `aplicable: false`, no con diferencia 0 — que se leería como "la regla no sirvió"');
  ok(simularUmbral(null).aplicable === false, 'y sin serie tampoco revienta');
}

console.log('\n── el barrido muestra la FORMA, que es lo que se puede mirar ──');
{
  const b = barrer(devuelto, { umbrales: [0.01, 0.02, 0.03, 0.05] });
  ok(b.length === 4, 'un resultado por umbral');
  ok(b[0].diferencia === 1300 && b[2].diferencia === 2700,
    'umbrales distintos dan salidas distintas: a +3% habría salido más arriba', `${b[0].diferencia} / ${b[2].diferencia}`);
  ok(b[3].disparo === false,
    'y a +5% no dispara ese día — el barrido es lo que muestra dónde deja de ayudar');
}

console.log('\n── el agregado del día ──');
{
  const dia = simularDia({
    claude: devuelto,
    control: serieDe([
      { minuto: '2026-09-18T13:30:00Z', equity: '100000' },
      { minuto: '2026-09-18T19:55:00Z', equity: '104000' },
    ]),
    qwen: serieDe([]),   // abortó: no tiene serie
  }, { umbral: 0.02 });

  ok(dia.agentes === 3 && dia.con_serie === 2,
    'los agentes sin serie se cuentan aparte: no se promedian como ceros', JSON.stringify({ a: dia.agentes, c: dia.con_serie }));
  ok(dia.dispararon === 2, 'cuántos habrían disparado');
  ok(dia.filas[0].agente === 'claude',
    'ordenado por diferencia: primero para quién la regla habría servido más');
  ok(/PISO/.test(dia.advertencia) && /sesgo va SIEMPRE a favor de la regla/.test(dia.advertencia),
    'con las DOS advertencias en el agregado, que es donde se saca la conclusión');
  ok(typeof dia.diferencia_total_usd === 'number',
    'y el neto en dólares — nombrado como total, no como retorno: sumar dólares de cuentas con baselines distintos no es una media de nada');
}

console.log('\n── el umbral por defecto y el parseo ──');
{
  ok(UMBRAL_DEFAULT === 0.02, 'el default es +2%', String(UMBRAL_DEFAULT));
  const ep = readFileSync(new URL('../api/liga-tomaganancias.js', import.meta.url), 'utf8');
  ok(/n > 1 \? n \/ 100 : n/.test(ep),
    'el endpoint acepta "2" y "2%" como 2%: un umbral de 200% no es una petición, es un error de dedo');
}

console.log('\n── no toca la liga ──');
{
  const src = readFileSync(new URL('../api/liga-tomaganancias.js', import.meta.url), 'utf8');
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/insert into|update |delete from/i.test(codigo), 'cero escrituras');
  ok(!/createLimitOrder|enviarOrdenes|alpaca/i.test(codigo), 'ni una sola orden, ni siquiera el import');
  ok(!/from '\.\/arena-(run|watch)/.test(codigo), 'y no importa nada del camino de decisión');
  const lib = readFileSync(new URL('../api/_lib/arena-tomaganancias.js', import.meta.url), 'utf8');
  ok(!/import .*db\.js/.test(lib),
    'el simulador es una función PURA sobre la serie: ni siquiera conoce la base de datos');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
