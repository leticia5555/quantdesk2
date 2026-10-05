// ═══════════════════════════════════════════════════════════════
// tests/arena-puerta.test.mjs — EL CRITERIO QUE DECIDE SI SE ABRE UN MES.
//
// EL PISO DE SIN_AYUDA (Lety, 2026-10-05). Yo había publicado `SIN_AYUDA` al
// lado del veredicto y dejado el criterio sin tocar, con el argumento de que
// un libro rescatado es un libro. Ella marcó el caso que eso deja sin firmar:
//
//   «un agente con 3/3 VERDE y SIN_AYUDA 0/3 —o sea que las tres veces entregó
//   SOLO con rescate— se lee igual que un 3/3 limpio. Abrir un mes sobre un
//   agente que nunca cierra solo es una decisión, no un detalle.»
//
// Y la segunda mitad, que sale de la separación de causas: si el rescate fue
// por NUESTRO techo de tokens (`causa: corte`), el agente no necesitó ayuda —
// se la quitamos nosotros. Eso NO cuenta contra él.
//
// POR QUÉ ESTO VIVE EN JS Y NO EN `jq`. Con dos ramas (entregó / no entregó) la
// expresión de jq de `arena-humo.sh` alcanzaba. Con el piso pasa a tres
// dimensiones por corrida —entregó × rescatado × causa— y la primera versión
// de ese jq ya había fallado dos veces en silencio (leía `.status` de la raíz,
// y con el archivo de veredictos vacío imprimía "los siete en VERDE"). La
// lógica que decide una temporada de 22 sesiones se prueba caso por caso.
//
// LO QUE ESTE ARCHIVO FIJA:
//   1. LOS CUATRO VEREDICTOS, con el piso incluido.
//   2. `causa: corte` NO cuenta contra el agente; `formato` y `desconocida` SÍ.
//   3. TODO ÁMBAR DICE POR QUÉ, y `2/3` y `nunca cerró solo` dicen cosas
//      distintas: son dos problemas con dos respuestas.
//   4. UN AGENTE SIN CORRIDA NO ES UN AGENTE EN VERDE, y tampoco es un agente
//      en rojo: es una tanda incompleta, y confundirlas manda a arreglar al
//      que no falló.
//   5. `status` AUSENTE NO ES "ENTREGÓ". Una respuesta vacía o un error de red
//      no pueden leerse como éxito.
//
// Correr con `node tests/arena-puerta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { lecturaDeCorrida, veredictoDeAgente, puertaDeLaTanda } from '../scripts/arena-puerta.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Atajos para armar corridas.
const limpia = () => lecturaDeCorrida({ status: 'ok_target' });
const riel = () => lecturaDeCorrida({ status: 'rejected_rails', error: 'violó R3' });
const rescatada = (causa) => lecturaDeCorrida({ status: 'ok_target', reintento_json: { concedido: true, resuelto: true, causa } });
const abortada = () => lecturaDeCorrida({ status: 'aborted_malformed_target', error: 'sin JSON' });
const ver = (cs) => veredictoDeAgente(cs, 3);

// ── 1) LOS CUATRO VEREDICTOS ─────────────────────────────────────────
console.log('\n── 3/3 con una limpia · 3/3 sin ninguna · 2/3 · ≤1/3 ──');
{
  ok(ver([limpia(), limpia(), limpia()]).veredicto === 'VERDE', '3/3 limpias → VERDE');
  ok(ver([rescatada('formato'), limpia(), limpia()]).veredicto === 'VERDE',
    '3/3 con UNA rescatada → VERDE: el piso pide al menos una limpia, no las tres');

  // EL PISO.
  const piso = ver([rescatada('formato'), rescatada('formato'), rescatada('formato')]);
  ok(piso.veredicto === 'ÁMBAR', '3/3 pero las TRES rescatadas → ÁMBAR, no VERDE', JSON.stringify(piso));
  ok(piso.entregadas === 3 && piso.limpias === 0, 'y las dos cifras se publican juntas', JSON.stringify(piso));

  ok(ver([limpia(), abortada(), limpia()]).veredicto === 'ÁMBAR', '2/3 → ÁMBAR');
  ok(ver([limpia(), abortada(), abortada()]).veredicto === 'ROJO', '1/3 → ROJO');
  ok(ver([abortada(), abortada(), abortada()]).veredicto === 'ROJO', '0/3 → ROJO');

  // `rejected_rails` CUENTA como entregado — la decisión que Lety aprobó por su
  // razón: el modelo entregó un portafolio parseable y el riel hizo su trabajo.
  ok(ver([riel(), riel(), riel()]).veredicto === 'VERDE',
    'tres `rejected_rails` → VERDE: entregó libro tres veces y los rieles opinaron');
}

// ── 2) DE QUIÉN FUE LA CULPA DEL RESCATE ─────────────────────────────
console.log('\n── un rescate por NUESTRO techo no cuenta contra el agente ──');
{
  const nuestra = ver([rescatada('corte'), rescatada('corte'), rescatada('corte')]);
  ok(nuestra.veredicto === 'VERDE' && nuestra.limpias === 3,
    'las tres rescatadas por `corte` → VERDE: el techo lo apretamos nosotros', JSON.stringify(nuestra));
  ok(/NUESTRO techo/.test(nuestra.porque || ''),
    'y se NOMBRA igual, porque es trabajo nuestro pendiente, no un agente sano y nada más', nuestra.porque);

  const suya = ver([rescatada('formato'), rescatada('formato'), rescatada('formato')]);
  ok(suya.limpias === 0, '`formato` sí cuenta contra él', JSON.stringify(suya));

  // EL HUECO DECLARADO. Sin `finish_reason` no sabemos de quién fue, y no se
  // regala un crédito que no se puede probar: empuja a ÁMBAR, que es una
  // decisión humana, nunca a ROJO.
  const duda = ver([rescatada('desconocida'), rescatada('desconocida'), rescatada('desconocida')]);
  ok(duda.limpias === 0 && duda.veredicto === 'ÁMBAR',
    '`desconocida` cuenta contra él y topa en ÁMBAR, no en ROJO', JSON.stringify(duda));

  // Un rescate que FALLÓ no es un rescate: la corrida no entregó.
  const fallo = lecturaDeCorrida({ status: 'aborted_malformed_target', reintento_json: { concedido: true, resuelto: false, causa: 'formato' } });
  ok(fallo.entrego === false && fallo.sin_ayuda === false && fallo.rescatado === false,
    'un reintento concedido que falló no cuenta como rescate ni como entrega', JSON.stringify(fallo));
}

// ── 3) TODO ÁMBAR DICE POR QUÉ ───────────────────────────────────────
console.log('\n── un veredicto que manda a decidir sin decir qué decidir no sirve ──');
{
  const porPiso = ver([rescatada('formato'), rescatada('formato'), rescatada('formato')]);
  const porCuenta = ver([limpia(), abortada(), limpia()]);
  ok(/NUNCA cerró solo/.test(porPiso.porque || ''), 'el ÁMBAR del piso dice que nunca cerró solo', porPiso.porque);
  ok(/entregaron libro/.test(porCuenta.porque || ''), 'y el ÁMBAR de 2/3 dice que faltó una entrega', porCuenta.porque);
  ok(porPiso.porque !== porCuenta.porque,
    'y los dos ÁMBAR NO dicen lo mismo: son dos problemas con dos respuestas distintas');
  ok(ver([limpia(), limpia(), limpia()]).porque === null, 'un VERDE limpio no inventa un motivo');

  // El riel desigual se nombra aunque no cambie el veredicto.
  const sinReloj = ver([
    limpia(), limpia(),
    lecturaDeCorrida({ status: 'aborted_malformed_target', reintento_json: { concedido: false, omitido_por_reloj: true, causa: 'formato' } }),
  ]);
  ok(/sin reloj para el reintento/.test(sinReloj.porque || ''),
    'una corrida a la que el riel no le alcanzó se dice', sinReloj.porque);
}

// ── 4) UNA TANDA INCOMPLETA NO ES UN AGENTE EN ROJO ──────────────────
console.log('\n── un agente sin corrida no es un agente en verde (ni en rojo) ──');
{
  const falta = ver([limpia(), limpia()]);
  ok(falta.veredicto === 'INCOMPLETO', 'con 2 respuestas de 3 esperadas → INCOMPLETO', JSON.stringify(falta));
  ok(/no es un agente en verde/.test(falta.porque || ''), 'y lo dice con esas palabras', falta.porque);
  ok(ver([]).veredicto === 'INCOMPLETO', 'cero respuestas también: es el caso que dio el "VERDE" falso');

  // LA PUERTA. Y el orden importa: incompleto gana sobre rojo, porque "arreglá
  // openai" cuando en realidad falta la corrida de control manda a arreglar al
  // que no falló.
  const p1 = puertaDeLaTanda({ a: ver([limpia(), limpia(), limpia()]), b: ver([limpia(), limpia()]) });
  ok(p1.estado === 'NO SE PUEDE DECIR' && p1.salida === 2, 'una tanda con un hueco no se puede juzgar', JSON.stringify(p1));

  const p2 = puertaDeLaTanda({
    a: ver([limpia(), limpia(), limpia()]),
    b: ver([limpia(), abortada(), abortada()]),
    c: ver([limpia(), abortada(), limpia()]),
  });
  ok(p2.estado === 'CERRADA' && p2.agentes.join() === 'b', 'con un ROJO, cerrada, y nombra al rojo', JSON.stringify(p2));

  const p3 = puertaDeLaTanda({ a: ver([limpia(), limpia(), limpia()]), c: ver([limpia(), abortada(), limpia()]) });
  ok(p3.estado === 'ÁMBAR' && p3.salida === 1, 'sin rojos pero con un ámbar, NO abre sola', JSON.stringify(p3));

  const p4 = puertaDeLaTanda({ a: ver([limpia(), limpia(), limpia()]), b: ver([riel(), limpia(), limpia()]) });
  ok(p4.estado === 'LOS SIETE EN VERDE' && p4.salida === 0, 'todos verdes → abre, con las puertas físicas al lado', JSON.stringify(p4));
}

// ── 5) `status` AUSENTE NO ES "ENTREGÓ" ──────────────────────────────
console.log('\n── una respuesta vacía no puede leerse como éxito ──');
{
  for (const [etiqueta, g] of [
    ['objeto vacío', {}],
    ['null', null],
    ['status null', { status: null }],
    ['status vacío', { status: '' }],
  ]) {
    const c = lecturaDeCorrida(g);
    ok(c.entrego === false && c.sin_ayuda === false, `${etiqueta} → no entregó`, JSON.stringify(c));
  }
  // EL BUG QUE ESTE TEST ENCONTRÓ. La primera versión decía
  // `entrego = !status.startsWith('aborted')`, y `timeout` —el corte del
  // harness a los 270s— no empieza con `aborted`: una corrida muerta contaba
  // como libro entregado. Un prefijo de string no es una clasificación.
  for (const s of ['timeout', 'threw', 'rejected_tickers']) {
    const c = lecturaDeCorrida({ status: s });
    ok(c.entrego === false && c.clase === 'falló', `\`${s}\` es una FALLA, no una entrega`, JSON.stringify(c));
  }
}

// ── 6) NUESTRA INFRA NO ES CULPA DEL AGENTE ──────────────────────────
console.log('\n── contar nuestro bug como rojo del agente es B44 otra vez ──');
{
  for (const s of ['halted', 'aborted_no_alpaca_keys', 'aborted_alpaca_read']) {
    ok(lecturaDeCorrida({ status: s }).clase === 'no_medible',
      `\`${s}\` es NUESTRA infra: no medible`, JSON.stringify(lecturaDeCorrida({ status: s })));
  }
  const v = ver([limpia(), limpia(), lecturaDeCorrida({ status: 'aborted_no_alpaca_keys' })]);
  ok(v.veredicto === 'INCOMPLETO', 'y una corrida así manda el agente a INCOMPLETO, no a ÁMBAR', JSON.stringify(v));
  ok(/nuestra infra, no el agente/.test(v.porque || ''), 'diciendo de quién es', v.porque);

  // UN STATUS NUEVO NUNCA PASA EN SILENCIO, ni para bien ni para mal.
  const nuevo = lecturaDeCorrida({ status: 'ok_algo_que_no_existe_todavia' });
  ok(nuevo.clase === 'desconocido' && nuevo.entrego === false, 'un status que la puerta no conoce no cuenta como entrega', JSON.stringify(nuevo));
  const vn = ver([limpia(), limpia(), nuevo]);
  ok(vn.veredicto === 'INCOMPLETO' && /no conoce/.test(vn.porque || ''),
    'y manda a INCOMPLETO pidiendo que se clasifique', vn.porque);
}

// ── 7) LAS LISTAS NO PUEDEN QUEDAR VIEJAS ────────────────────────────
// El riesgo real de clasificar por nombre en vez de por prefijo es que alguien
// agregue un `status` en arena-shadow.js y la puerta lo ignore. Entonces se
// chequea contra el archivo: TODO status que el camino de la sombra puede
// emitir tiene que estar en EXACTAMENTE una de las tres listas.
//
// Un status nuevo cae en `desconocido` y manda la tanda a INCOMPLETO, así que
// el default ya es seguro. Esto hace que además se vea en el commit que lo
// agrega, y no en la tanda de 21 corridas.
console.log('\n── todo status del harness está clasificado, y en una sola lista ──');
{
  const { STATUS_ENTREGO, STATUS_FALLO, STATUS_NO_MEDIBLE } = await import('../scripts/arena-puerta.mjs');
  const fuente = String((await import('node:fs')).readFileSync('api/arena-shadow.js', 'utf8'));
  const hallados = [...new Set(
    (fuente.match(/'(ok_[a-z_]+|ejecutado_[a-z_]+|rejected_[a-z_]+|aborted_[a-z_]+|halted|timeout|threw)'/g) || [])
      .map((x) => x.replace(/'/g, '')),
  )].sort();
  ok(hallados.length >= 10, `se encontraron ${hallados.length} status en arena-shadow.js`, hallados.join(', '));
  for (const st of hallados) {
    const en = [STATUS_ENTREGO, STATUS_FALLO, STATUS_NO_MEDIBLE].filter((l) => l.includes(st)).length;
    ok(en === 1, `\`${st}\` está en exactamente una lista`, `está en ${en}`);
  }
  // Y al revés: ninguna lista nombra un status que el harness ya no emite — una
  // lista con fantasmas se lee como cobertura que no existe.
  for (const l of [STATUS_ENTREGO, STATUS_FALLO, STATUS_NO_MEDIBLE]) {
    for (const st of l) ok(hallados.includes(st), `\`${st}\` lo emite el harness de verdad`);
  }
}

console.log(failures ? `\n${failures} FALLARON\n` : '\nTODO VERDE\n');
process.exit(failures ? 1 : 0);
