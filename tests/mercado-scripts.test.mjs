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
    'qd-tablas.js': ['tablasDeMercado', 'faltanteDeTabla', 'fraseDeFuente', 'FILAS_TABLA'],
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
