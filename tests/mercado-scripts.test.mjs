// ═══════════════════════════════════════════════════════════════════════
// TODO LO QUE `/mercado` CARGA TIENE QUE PARSEAR COMO SCRIPT CLÁSICO
//
// R2(b) estuvo a un empujón de subir la pestaña Mundo en blanco.
// `qd-mercados.js` y `qd-mundo.js` se escribieron con `export const` / `export
// function`, que es lo natural en este repo porque **todo** lo demás es ESM y
// Node lo acepta —no hay `package.json`, así que Node detecta la sintaxis y
// carga el archivo como módulo—. Las pruebas pasaban.
//
// Pero `mercado.html` los carga con `<script src="/qd-mundo.js">`, un script
// CLÁSICO, y ahí `export` es un **SyntaxError**: el archivo entero no se
// ejecuta, `armaMundo` queda `undefined` y la pestaña sale vacía. Verde en la
// suite, roto en el teléfono — el peor par que hay.
//
// Por eso `qd-periods.js` y `qd-treemap.js` usan el patrón doble: sólo
// declaraciones y un `module.exports` al final protegido con `typeof`. Esta
// prueba lo vuelve obligatorio para cualquier archivo que la página cargue, y
// se pone roja antes de que llegue al navegador.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Los `<script src="/algo.js">` del propio HTML, no una lista a mano. */
function scriptsDe(pagina) {
  const src = readFileSync(join(ROOT, pagina), 'utf8');
  return [...src.matchAll(/<script\s+src="\/([^"]+\.js)"/g)].map((m) => m[1]);
}

test('/mercado declara sus scripts y todos parsean como script clásico', () => {
  const archivos = scriptsDe('mercado.html');
  assert.ok(archivos.length >= 4, `esperaba varios, encontré ${archivos.length}`);
  for (const f of archivos) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // `new Function` compila en modo script, igual que un <script src>. Un
    // `export` o un `import` de módulo lanza acá, que es el punto.
    assert.doesNotThrow(
      () => new Function(src),
      `${f} no parsea como script clásico: el navegador no lo va a ejecutar`,
    );
    assert.doesNotMatch(src, /^\s*export\s/m, `${f} tiene un \`export\` de módulo`);
    assert.doesNotMatch(src, /^\s*import\s+[^(]/m, `${f} tiene un \`import\` de módulo`);
  }
});

test('y cada uno exporta también para node, con el guardia de typeof', () => {
  // Sin el guardia, `module` no existe en el navegador y el archivo revienta
  // en la última línea, que es la otra mitad del mismo patrón.
  for (const f of scriptsDe('mercado.html')) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /typeof module !== 'undefined'/, `${f}: falta el guardia`);
  }
});

test('lo que la página USA de cada script está exportado', () => {
  // Que el archivo cargue no alcanza: la página llama por nombre, y un nombre
  // que no viaja a `module.exports` no se puede probar en node — que es cómo
  // una función se queda sin prueba sin que nadie lo note.
  const require = createRequire(import.meta.url);
  const usados = {
    'qd-mundo.js': ['armaMundo', 'REGIONES', 'CATALOGO'],
    'qd-tablas.js': ['tablasDeMercado', 'faltanteDeTabla', 'fraseDeFuente', 'causaComunArena', 'FILAS_TABLA'],
    'qd-mercados.js': ['estadoDeBolsa', 'estado24h', 'qdEstadoMercado'],
    'qd-treemap.js': ['squarify', 'colorDe', 'etiquetaCuadro', 'agrupaPorSector'],
    'qd-periods.js': ['qdPeriodChange', 'qdPctTag', 'qdCap', 'fmtPrice'],
  };
  for (const [f, nombres] of Object.entries(usados)) {
    const m = require(join(ROOT, f));
    for (const n of nombres) {
      assert.equal(typeof m[n] !== 'undefined', true, `${f} no exporta ${n}`);
    }
  }
});

test('dos scripts clásicos no pueden declarar el MISMO nombre a nivel superior', () => {
  // Esto tumbó Mundo una vez: `qd-pesos.js` y `qd-mundo.js` tenían los dos un
  // `const num` de ayudante privado. En módulos ESM no pasa nada —cada uno
  // tiene su ámbito— pero como <script> clásicos comparten el ámbito global, y
  // dos `const` con el mismo nombre son un **SyntaxError** que tumba el
  // SEGUNDO archivo completo. La página cargó con `enPesos` inexistente y el
  // toggle MXN murió en silencio.
  const vistos = new Map();
  for (const f of scriptsDe('mercado.html')) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // Sólo declaraciones a nivel superior: las que empiezan en columna 0.
    for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (!vistos.has(m[1])) vistos.set(m[1], []);
      vistos.get(m[1]).push(f);
    }
  }
  const choques = [...vistos.entries()].filter(([, fs]) => fs.length > 1);
  assert.deepEqual(choques, [],
    'nombres declarados dos veces: ' + choques.map(([n, fs]) => `${n} (${fs.join(', ')})`).join(' · '));
});

// ═══════════════════════════════════════════════════════════════════════
// R3b: LA PÁGINA DE NOTICIAS JUEGA CON LAS MISMAS REGLAS
//
// `noticias.html` carga `qd-mercados.js` para el chip de la regla 4 y tiene su
// propio bloque de script en línea. Las dos cosas pueden romperse igual que en
// `mercado.html`: un `export` en el archivo compartido, o un error de sintaxis
// en el bloque en línea que deja la página en blanco con la consola cerrada.
// ═══════════════════════════════════════════════════════════════════════
test('/mercado/noticias carga sólo scripts clásicos, y su bloque en línea compila', () => {
  const archivos = scriptsDe('noticias.html');
  assert.ok(archivos.length >= 1, 'la página declara al menos un script');
  for (const f of archivos) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotThrow(() => new Function(src), `${f} no parsea como script clásico`);
    assert.match(src, /typeof module !== 'undefined'/, `${f}: falta el guardia`);
  }
  // El bloque EN LÍNEA: `new Function` lo compila en modo script. Un error de
  // sintaxis acá deja la página en blanco sin un solo mensaje visible.
  const html = readFileSync(join(ROOT, 'noticias.html'), 'utf8');
  const enLinea = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(enLinea.length, 1, 'un solo bloque en línea');
  assert.doesNotThrow(() => new Function(enLinea[0]), 'el bloque en línea no compila');
});

test('las pantallas arman el chip con la MISMA función, la de qd-mercados', () => {
  // Lety, 2026-10-20: *"El chip de todas las páginas nuevas dice 'no se sabe
  // de qué día es el último cierre'. Usa la misma función que el mapa."*
  //
  // La causa fue que el mapa tenía la composición dentro de su `pintarChip` y
  // las pantallas nuevas llamaban a `qdEstadoMercado` en crudo. Esta prueba
  // fija lo contrario: nadie compone el renglón a mano. Si alguien agrega una
  // pantalla y se escribe su propio chip, esto se pone rojo.
  const require2 = createRequire(import.meta.url);
  const mercados = require2(join(ROOT, 'qd-mercados.js'));
  assert.equal(typeof mercados.chipDeMercado, 'function', 'chipDeMercado no está exportado');
  for (const pagina of ['mercado.html', 'noticias.html']) {
    const html = readFileSync(join(ROOT, pagina), 'utf8');
    assert.ok(html.includes('chipDeMercado'), `${pagina} debería armar el chip con chipDeMercado`);
  }
});

test('y ninguna pantalla deja en el renglón la queja por el cierre que falta', () => {
  // La frase que se vio en producción. Puede seguir existiendo como MOTIVO
  // (va al `title`), pero no armada a mano dentro de una página.
  for (const pagina of ['mercado.html', 'noticias.html']) {
    const codigo = codigoDe(pagina);
    assert.doesNotMatch(codigo, /no se sabe de qué día/,
      `${pagina} vuelve a componer la queja a mano`);
  }
});

/**
 * El HTML sin comentarios: lo que el navegador EJECUTA Y PINTA.
 *
 * La primera versión de la prueba de abajo miraba el archivo entero y se
 * ponía roja por el comentario que explica que acá NO se guarda el cuerpo de
 * la nota — castigaba la documentación en vez del código. Una prueba que se
 * puede apagar borrando un comentario mide el comentario.
 */
function codigoDe(pagina) {
  return readFileSync(join(ROOT, pagina), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('la página de noticias NO llama a ninguna IA ni trae cuerpo de nota (reglas 1 y 6)', () => {
  const html = codigoDe('noticias.html');
  // Regla 6: cero IA en /mercado. Si alguien agrega un resumen, esto se pone rojo.
  for (const prohibido of ['anthropic', 'openai', '/api/agents', 'claude-', 'gpt-', 'resumen']) {
    assert.ok(!html.toLowerCase().includes(prohibido),
      `la página menciona "${prohibido}": acá no va IA`);
  }
  // El encargo: titular + foto + fuente + hora + link. Nada de cuerpo.
  assert.ok(!/\bsnippet\b|\bdescripcion\b|\bcuerpo_nota\b/.test(html),
    'la página no debe pintar el cuerpo de la nota');
  // Regla 5: el pie dice fuente, hora y la leyenda.
  assert.match(html, /Información, no asesoría/);
  assert.match(html, /actualizado/);
});

test('la página de noticias declara el estado en la URL (regla 9)', () => {
  const html = readFileSync(join(ROOT, 'noticias.html'), 'utf8');
  for (const p of ['seccion', 'orden', 'idioma', 'fuente']) {
    assert.ok(html.includes("'" + p + "'") || html.includes('"' + p + '"'),
      `falta el parámetro ${p} en el estado de la URL`);
  }
  assert.match(html, /history\.replaceState/, 'el estado se escribe en la URL');
  // Y los valores se validan contra una lista: un `?seccion=<script>` no puede
  // llegar a pintarse ni a viajar al endpoint.
  assert.match(html, /VALIDO/, 'los valores de la URL se validan contra una lista');
});
