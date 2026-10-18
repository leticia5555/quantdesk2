#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/arena-puerta.mjs — EL CRITERIO DE LA PUERTA, EN UN SOLO LUGAR
// Y TESTEABLE.
//
// POR QUÉ SALIÓ DEL `jq` (2026-10-05). El veredicto vivía dentro de una
// expresión de `jq` en `arena-humo.sh`. Con el criterio de dos ramas
// (entregó / no entregó) eso aguantaba; con el PISO DE SIN_AYUDA pasa a tener
// tres dimensiones por corrida —entregó × rescatado × causa del rescate— y jq
// es un mal lugar para la lógica que decide si se abre una temporada de 22
// sesiones. Acá se puede probar con corridas de juguete, una por caso.
//
// ── EL CRITERIO, FIJADO ANTES DE MEDIR ───────────────────────────────
//
//   ENTREGÓ LIBRO = el `status` NO empieza con `aborted`.
//     `rejected_rails` CUENTA: el modelo entregó un portafolio parseable y un
//     riel hizo su trabajo. La puerta pregunta si el harness saca una decisión
//     del modelo, no si la decisión gustó.
//
//   SIN AYUDA = entregó Y (no hubo rescate O el rescate fue por NUESTRA culpa).
//     Un rescate con `causa: corte` es nuestro techo de tokens apretado, no un
//     agente que no sabe cerrar: no cuenta contra él (Lety, 2026-10-05).
//     Un rescate con `causa: desconocida` —el proveedor no mandó
//     `finish_reason`— SÍ cuenta contra él, y es una decisión que se declara:
//     no se regala un crédito que no se puede probar. Empuja a ÁMBAR, que es
//     una decisión humana, no a ROJO.
//
//   VEREDICTO sobre las 3 corridas:
//     3/3 entregadas Y al menos 1 sin ayuda  →  VERDE
//     3/3 entregadas Y 0 sin ayuda           →  ÁMBAR  ← el piso
//     2/3 entregadas                         →  ÁMBAR
//     ≤1/3 entregadas                        →  ROJO
//
//   EL PISO, CON SUS PALABRAS: «un agente con 3/3 VERDE y SIN_AYUDA 0/3 —o
//   sea que las tres veces entregó SOLO con rescate— se lee igual que un 3/3
//   limpio. Abrir un mes sobre un agente que nunca cierra solo es una
//   decisión, no un detalle.»
//
//   Y TODO ÁMBAR DICE POR QUÉ. Un veredicto que manda a decidir sin decir qué
//   decidir no es un veredicto: `2/3` y `nunca cerró solo` son dos problemas
//   distintos con dos respuestas distintas.
//
// LA PUERTA ABRE sólo con los siete en VERDE y las cuatro puertas físicas en
// verde. Un agente SIN VEREDICTO no es un agente en verde: si faltan filas, la
// puerta no se puede decir (y eso es distinto de que esté cerrada).
//
// Uso:  node scripts/arena-puerta.mjs <dir> <agente,agente,…> <rondas>
// ═══════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── PURO ─────────────────────────────────────────────────────────────

// ── LOS TRES DESTINOS DE UNA CORRIDA, POR NOMBRE (2026-10-05) ────────
// La primera versión de esto decía `entrego = !status.startsWith('aborted')`, y
// el test lo cazó: **`timeout` no empieza con `aborted`**, así que una corrida
// que el harness mató a los 270s contaba como libro entregado. Un prefijo de
// string no es una clasificación.
//
// Y clasificar en dos clases tampoco alcanza, por la razón de B44: no todo lo
// que no entregó es culpa del modelo.
//
//   ENTREGÓ      el harness sacó una decisión del modelo.
//   FALLÓ        el modelo (o su proveedor) no entregó. Esto es lo que la
//                puerta juzga.
//   NO MEDIBLE   NOSOTROS no pudimos medir: faltan las llaves de Alpaca, la
//                lectura del libro falló, el agente está en halt. Contar esto
//                como ROJO del agente es la tercera culpa de B44 otra vez —
//                archivaría nuestro bug como falla del modelo. Va a
//                INCOMPLETO, que manda a un humano y nombra la causa real.
//
// Lo que queda AFUERA de "entregó", y por qué, para que sea una decisión y no
// un accidente del prefijo:
//   · `rejected_tickers` — el JSON parseó, pero con símbolos que no existen.
//     Un portafolio de tickers inventados no es una decisión usable; es un
//     hallazgo sobre el modelo.
//   · `timeout` / `threw` — el harness lo mató o algo lanzó. No hay libro.
//
// Un status que NO esté en ninguna lista sale como `desconocido` y manda la
// tanda a INCOMPLETO. Un estado nuevo nunca pasa en silencio, ni para bien ni
// para mal.
export const STATUS_ENTREGO = ['ok_target', 'ejecutado_parcial', 'rejected_rails'];
export const STATUS_FALLO = [
  'rejected_tickers', 'timeout', 'threw',
  'aborted_malformed_target', 'aborted_cuerpo_vacio', 'aborted_llm_error', 'aborted_llm_threw',
];
export const STATUS_NO_MEDIBLE = ['halted', 'aborted_no_alpaca_keys', 'aborted_alpaca_read'];

export function claseDeStatus(status) {
  const s = String(status || '').trim();
  if (!s) return 'desconocido';
  if (STATUS_ENTREGO.includes(s)) return 'entregó';
  if (STATUS_FALLO.includes(s)) return 'falló';
  if (STATUS_NO_MEDIBLE.includes(s)) return 'no_medible';
  return 'desconocido';
}

// Una corrida, normalizada desde la respuesta de /api/arena-shadow.
export function lecturaDeCorrida(g) {
  const status = (g && g.status) || null;
  const clase = claseDeStatus(status);
  const entrego = clase === 'entregó';
  const r = (g && g.reintento_json) || null;
  const rescatado = !!(r && r.resuelto === true);
  const causa = (r && r.causa) || null;
  return {
    status: status || 'sin_status',
    clase,
    entrego,
    rescatado,
    causa_rescate: rescatado ? causa : null,
    // NUESTRA culpa no cuenta contra el agente.
    sin_ayuda: entrego && (!rescatado || causa === 'corte'),
    reintento_omitido_por_reloj: !!(r && r.omitido_por_reloj),
    error: ((g && g.error) || '').slice(0, 120) || null,
    techo_usado: (g && g.lectura_cierre && g.lectura_cierre.techo_usado) ?? null,
    truncado: (g && g.lectura_cierre && g.lectura_cierre.truncado) ?? null,
  };
}

export function veredictoDeAgente(corridas, rondas = corridas.length) {
  const n = rondas;
  const entregadas = corridas.filter((c) => c.entrego).length;
  const limpias = corridas.filter((c) => c.sin_ayuda).length;
  const faltan = n - corridas.length;
  const noMedibles = corridas.filter((c) => c.clase === 'no_medible');
  const desconocidas = corridas.filter((c) => c.clase === 'desconocido');

  // Faltan respuestas, o alguna no la pudimos medir → no se puede decir. No es
  // verde y tampoco es rojo DEL AGENTE: es una tanda incompleta, y confundirlas
  // manda a arreglar al que no falló.
  if (faltan > 0 || noMedibles.length || desconocidas.length) {
    const partes = [];
    if (faltan > 0) partes.push(`faltan ${faltan} de ${n} respuestas`);
    if (noMedibles.length) partes.push(`${noMedibles.length} corrida(s) que NOSOTROS no pudimos medir (${[...new Set(noMedibles.map((c) => c.status))].join(', ')}): es nuestra infra, no el agente`);
    if (desconocidas.length) partes.push(`${desconocidas.length} corrida(s) con un status que esta puerta no conoce (${[...new Set(desconocidas.map((c) => c.status))].join(', ')}): clasificalo antes de juzgarlo`);
    return {
      entregadas, limpias, rondas: n, veredicto: 'INCOMPLETO',
      porque: `${partes.join(' · ')} — un agente sin corrida no es un agente en verde`,
    };
  }

  const motivos = [];
  let veredicto;
  if (entregadas <= 1) {
    veredicto = 'ROJO';
    motivos.push(`${entregadas}/${n} entregaron libro`);
  } else if (entregadas < n) {
    veredicto = 'ÁMBAR';
    motivos.push(`${entregadas}/${n} entregaron libro`);
  } else if (limpias === 0) {
    // EL PISO. Las tres entregaron, y las tres sólo con rescate del agente.
    veredicto = 'ÁMBAR';
    motivos.push(`entregó ${n}/${n} pero NUNCA cerró solo (sin_ayuda 0/${n}): las ${n} veces necesitó el reintento`);
  } else {
    veredicto = 'VERDE';
  }
  // Los rescates nuestros se nombran igual, aunque no cambien el veredicto:
  // son trabajo NUESTRO pendiente (subir `ARENA_MAX_TOKENS`), y callarlos los
  // deja sin dueño.
  const nuestros = corridas.filter((c) => c.causa_rescate === 'corte').length;
  if (nuestros) motivos.push(`${nuestros} rescate(s) por NUESTRO techo de tokens (no cuentan contra él)`);
  const sinReloj = corridas.filter((c) => c.reintento_omitido_por_reloj).length;
  if (sinReloj) motivos.push(`${sinReloj} corrida(s) sin reloj para el reintento: el riel no le alcanzó`);

  return {
    entregadas, limpias, rondas: n, veredicto,
    porque: motivos.join(' · ') || null,
  };
}

export function puertaDeLaTanda(veredictos) {
  const ids = Object.keys(veredictos);
  const de = (v) => ids.filter((a) => veredictos[a].veredicto === v);
  const incompletos = de('INCOMPLETO');
  const rojos = de('ROJO');
  const ambares = de('ÁMBAR');
  if (incompletos.length) {
    return { estado: 'NO SE PUEDE DECIR', agentes: incompletos, salida: 2,
      texto: `faltan corridas de: ${incompletos.join(', ')}. Un agente sin veredicto NO es un agente en verde.` };
  }
  if (rojos.length) {
    return { estado: 'CERRADA', agentes: rojos, salida: 1, texto: `ROJO en: ${rojos.join(', ')}` };
  }
  if (ambares.length) {
    return { estado: 'ÁMBAR', agentes: ambares, salida: 1,
      texto: `ÁMBAR en: ${ambares.join(', ')} — no abre sola. Mirá el POR QUÉ de esa fila antes de decidir.` };
  }
  return { estado: 'LOS SIETE EN VERDE', agentes: [], salida: 0,
    texto: 'Revisá igual las cuatro puertas físicas antes de abrir.' };
}

// ── CLI ──────────────────────────────────────────────────────────────

function main() {
  const [dir, agentesCsv, rondasStr] = process.argv.slice(2);
  if (!dir || !agentesCsv) {
    console.error('uso: node scripts/arena-puerta.mjs <dir> <agente,agente,…> [rondas]');
    process.exit(64);
  }
  const agentes = agentesCsv.split(',').map((x) => x.trim()).filter(Boolean);
  const rondas = Number(rondasStr) || 3;

  const veredictos = {};
  const filas = [];
  for (const a of agentes) {
    const corridas = [];
    for (let r = 1; r <= rondas; r++) {
      const f = join(dir, `${a}-r${r}.json`);
      if (!existsSync(f)) continue;
      let g = null;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        g = (j.agents && j.agents[0]) || null;
      } catch { g = null; }
      // Un archivo ilegible NO se saltea en silencio: se cuenta como corrida
      // faltante, que es lo que es. Uno CON status entra siempre, incluso con
      // un status que esta puerta no conoce — ahí el veredicto lo dice.
      if (!g || !g.status) continue;
      const c = lecturaDeCorrida(g);
      corridas.push(c);
      filas.push({ agente: a, ronda: r, ...c });
    }
    veredictos[a] = veredictoDeAgente(corridas, rondas);
  }

  const anchoA = Math.max(6, ...agentes.map((a) => a.length));
  const fmt = (a, libros, puerta, sinAyuda, porque) =>
    `${String(a).padEnd(anchoA)} ${String(libros).padStart(6)} ${String(puerta).padEnd(14)} ${String(sinAyuda).padStart(9)}  ${porque}`;
  console.log(fmt('AGENTE', 'LIBROS', 'PUERTA', 'SIN_AYUDA', 'POR QUÉ'));
  console.log('─'.repeat(anchoA + 36 + 40));
  for (const a of agentes) {
    const v = veredictos[a];
    console.log(fmt(a, `${v.entregadas}/${v.rondas}`, v.veredicto, `${v.limpias}/${v.rondas}`, v.porque || '—'));
  }

  const p = puertaDeLaTanda(veredictos);
  console.log('');
  console.log(`PUERTA DE APERTURA: ${p.estado} — ${p.texto}`);
  process.exit(p.salida);
}

// `import.meta.main` no existe en todas las versiones de node: se compara el
// path, que es lo que sí funciona desde 18.
if (process.argv[1] && process.argv[1].endsWith('arena-puerta.mjs')) main();
