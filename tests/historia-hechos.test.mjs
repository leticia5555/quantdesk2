// ═══════════════════════════════════════════════════════════════
// Tests de company_hecho_extraido — el almacén de la doble verificación.
//
// La tabla existe porque el plan de extracción NO guarda cuerpos (§11.8). Lo
// que sostiene una comilla en pantalla es el FRAGMENTO guardado, y eso solo
// funciona si guardarlo es honesto. Lo que se prueba acá:
//
//   1. **La verificación vive en el almacén, no en el que llama.** Podría
//      recibir `verificado: true` y creerle, pero una garantía que depende de
//      que alguien se acuerde no es una garantía.
//   2. **El offset lo calcula el almacén.** Un modelo que devuelve un índice
//      está adivinando, y un índice equivocado apunta a otra parte del
//      documento con toda la apariencia de ser correcto.
//   3. **Los descartes se guardan.** H3 se mide contando descartes: sin la
//      fila no hay denominador.
//   4. **Solo los verificados salen** hacia el narrador. Devolver los
//      descartados para que el llamador filtre es ofrecerle la oportunidad
//      de no filtrar.
//
// Correr con `node tests/historia-hechos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { crearRepo } from '../api/_lib/historia-db.js';
import { apareceLiteral } from '../api/_lib/historia-guardia.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

// Un ejecutor falso que captura las sentencias, como en el resto de la fase:
// este contenedor no tiene DATABASE_URL y ésa es la única manera de que los
// upserts estén probados y no solo escritos.
const capturar = (filasDevueltas = []) => {
  const hechas = [];
  const repo = crearRepo({
    sql: async (q, p) => { hechas.push([q.replace(/\s+/g, ' ').trim(), p]); return filasDevueltas; },
    sqlBatch: async (sentencias) => { for (const [q, p] of sentencias) hechas.push([q.replace(/\s+/g, ' ').trim(), p]); },
  });
  return { hechas, repo };
};

// El cuerpo tal como llegaría del des-etiquetador: el marcado ya fuera, los
// espacios todavía como los dejó el HTML.
const CUERPO = `On March 1, 2026, the Company announced the departure of
   Jane Doe, its Chief Financial Officer, effective March 15, 2026.
   The Board has begun a search for a successor.`;

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La verificación NO se le cree al que llama');
{
  const { hechas, repo } = capturar();
  const r = await repo.guardarHechos('0001', 'acc-1', {
    modelo: 'claude-haiku-4-5', promptVersion: 1, cuerpo: CUERPO,
    hechos: [
      // Éste SÍ está en el cuerpo.
      { item: '5.02', campo: 'nombre', valor: 'Jane Doe',
        fragmento: 'the departure of Jane Doe, its Chief Financial Officer' },
      // Éste NO, y viene marcado como verificado por el que llama. Si se le
      // creyera, una frase inventada quedaría como material citable — y la
      // comilla en pantalla diría algo que el documento nunca dijo.
      { item: '5.02', campo: 'motivo', valor: 'renunció por desacuerdos',
        fragmento: 'resigned over disagreements with the board', verificado: true },
    ],
  });

  eq(r.guardados, 2, 'se guardan los dos hechos');
  eq(r.verificados, 1, 'pero solo UNO queda verificado');
  eq(r.descartados, 1, 'y el otro, descartado');

  const insert = hechas.find(([q]) => q.startsWith('insert into company_hecho_extraido'));
  ok(insert, 'se hace el insert');
  const p = insert[1];
  // Doce columnas por fila: la 11ª de cada tupla es `verificado`.
  eq(p[10], true, 'el que está en el cuerpo se marca verificado');
  eq(p[22], false, 'y el que NO está se marca falso, aunque lo hayan declarado true');
  eq(p[23], 'no_aparece_literal', 'con el motivo del descarte, que es parte del dato');

  // El descarte SE GUARDA. H3 se mide contando descartes: sin la fila no hay
  // denominador.
  eq(p.length, 24, 'las dos filas viajan al insert, la buena y la descartada');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El offset lo calcula el almacén, no el modelo');
{
  const { hechas, repo } = capturar();
  await repo.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: CUERPO,
    hechos: [{
      campo: 'cargo', valor: 'Chief Financial Officer',
      fragmento: 'its Chief Financial Officer',
      // Un índice inventado. Un modelo que devuelve un offset está
      // adivinando, y un índice equivocado apunta a otra parte del documento
      // con toda la apariencia de ser correcto.
      offset_texto: 9999,
    }],
  });
  const p = hechas.find(([q]) => q.startsWith('insert'))[1];
  const esperado = CUERPO.replace(/\s+/g, ' ').trim().indexOf('its Chief Financial Officer');
  eq(p[6], esperado, 'el offset es el real, no el que mandaron');
  ok(p[6] > 0 && p[6] !== 9999, 'y desde luego no el inventado');

  // El fragmento se guarda NORMALIZADO, que es contra el que se verificó:
  // guardar el crudo dejaría el offset apuntando a otra cadena que la que
  // está en la columna de al lado.
  eq(p[5], 'its Chief Financial Officer', 'el fragmento guardado es el normalizado');

  // Un fragmento que no verifica no lleva offset: un índice sobre algo que
  // no está sería un número sin referente.
  const { hechas: h2, repo: r2 } = capturar();
  await r2.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: CUERPO,
    hechos: [{ campo: 'x', fragmento: 'esto no está en el documento' }],
  });
  eq(h2.find(([q]) => q.startsWith('insert'))[1][6], null, 'sin verificación no hay offset');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La huella del cuerpo, que es lo que hace auditable al offset');
{
  const { hechas, repo } = capturar();
  const r = await repo.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: CUERPO,
    hechos: [{ campo: 'nombre', fragmento: 'Jane Doe' }],
  });
  ok(r.huella_cuerpo && r.huella_cuerpo.length === 32, 'se devuelve la huella del cuerpo');
  eq(hechas.find(([q]) => q.startsWith('insert'))[1][7], r.huella_cuerpo, 'y se guarda con cada fila');

  // La huella es del texto NORMALIZADO, así que el mismo documento con los
  // saltos de línea en otro lado da la misma. Si el des-etiquetador cambia de
  // verdad —deja una etiqueta, se come una palabra— la huella cambia y los
  // offsets quedan marcados como viejos en vez de silenciosamente corridos.
  const { repo: r2 } = capturar();
  const otra = await r2.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: CUERPO.replace(/\n\s+/g, ' '),
    hechos: [{ campo: 'nombre', fragmento: 'Jane Doe' }],
  });
  eq(otra.huella_cuerpo, r.huella_cuerpo, 'los espacios no cambian la huella');

  const { repo: r3 } = capturar();
  const distinta = await r3.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: `${CUERPO} Una palabra de más.`,
    hechos: [{ campo: 'nombre', fragmento: 'Jane Doe' }],
  });
  ok(distinta.huella_cuerpo !== r.huella_cuerpo, 'pero una palabra distinta sí');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Se reemplaza en bloque, y dos corridas conviven');
{
  const { hechas, repo } = capturar();
  await repo.guardarHechos('0001', 'acc-1', {
    modelo: 'claude-haiku-4-5', promptVersion: 2, cuerpo: CUERPO,
    hechos: [{ campo: 'nombre', fragmento: 'Jane Doe' }],
  });
  const [q, p] = hechas[0];
  ok(/^delete from company_hecho_extraido/.test(q), 'primero se borra la corrida anterior');
  hondo(p, ['0001', 'acc-1', 'claude-haiku-4-5', 2],
    'de ESE documento, ESE modelo y ESA versión de prompt — no del documento entero');

  // Que el modelo y la versión entren en la clave del borrado es lo que deja
  // comparar dos corridas: es como se mide H3 y H4.
  ok(/modelo = \$3 and prompt_version = \$4/.test(q),
    'así dos modelos conviven en la tabla y se pueden comparar');

  // Sin hechos, se borra igual y no se inserta nada: una extracción que no
  // encontró nada es un resultado, no un no-op.
  const { hechas: h2, repo: r2 } = capturar();
  const r = await r2.guardarHechos('0001', 'acc-1', { modelo: 'm', promptVersion: 1, cuerpo: CUERPO, hechos: [] });
  eq(h2.length, 1, 'sin hechos solo corre el delete');
  eq(r.guardados, 0, 'y se reporta cero');

  // Un hecho sin campo no entra: sería una fila sin qué decir.
  const { repo: r3 } = capturar();
  eq((await r3.guardarHechos('0001', 'acc-1', {
    modelo: 'm', promptVersion: 1, cuerpo: CUERPO,
    hechos: [{ fragmento: 'Jane Doe' }, { campo: '', fragmento: 'Jane Doe' }],
  })).guardados, 0, 'un hecho sin campo no se guarda');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Solo los verificados salen hacia el narrador');
{
  const { hechas, repo } = capturar([
    { accession: 'acc-1', fragmento: 'la acción está infravalorada' },
    { accession: 'acc-1', fragmento: 'la acción está infravalorada' },
    { accession: 'acc-1', fragmento: 'el consejo no comparte esa lectura' },
    { accession: 'acc-2', fragmento: 'otro documento, otra frase' },
  ]);
  const mapa = await repo.fragmentosVerificados('0001', ['acc-1', 'acc-2']);

  const [q, p] = hechas[0];
  ok(/and verificado/.test(q), 'la consulta filtra por verificado: los descartados no salen');
  ok(/accession in \(\$2, \$3\)/.test(q), 'con placeholders explícitos, no un any() que dependa del driver');
  hondo(p, ['0001', 'acc-1', 'acc-2'], 'y los accessions van como parámetros');

  hondo(mapa.get('acc-1'), ['la acción está infravalorada', 'el consejo no comparte esa lectura'],
    'los fragmentos vienen agrupados por documento');
  eq(mapa.get('acc-1').length, 2, 'y sin repetir: la misma frase puede sostener dos campos');
  hondo(mapa.get('acc-2'), ['otro documento, otra frase'], 'cada documento con los suyos');

  const { hechas: h2, repo: r2 } = capturar();
  eq((await r2.fragmentosVerificados('0001', [])).size, 0, 'sin accessions no hay consulta');
  eq(h2.length, 0, 'y no se manda un `in ()` que Postgres rechazaría');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El mapa que sale es el que el guardia espera');
{
  // La prueba de que las dos puntas encajan: lo que devuelve el almacén entra
  // tal cual en el guardia de la salida, y una comilla dentro de un fragmento
  // verifica.
  const { repo } = capturar([
    { accession: 'acc-1', fragmento: 'the departure of Jane Doe, its Chief Financial Officer' },
  ]);
  const mapa = await repo.fragmentosVerificados('0001', ['acc-1']);
  const { guardar } = await import('../api/_lib/historia-guardia.js');

  const r = guardar(
    [{ id: 'direccion', texto: 'El 8-K dice «its Chief Financial Officer» [acc-1].' }],
    new Set(['acc-1']),
    { verificado: mapa },
  );
  eq(r.estado, 'ok', 'una comilla dentro de un fragmento guardado verifica en el guardia');
  ok(apareceLiteral('its Chief Financial Officer', mapa.get('acc-1')[0]),
    'y es el mismo verificador literal en las dos puntas: "verificado" significa lo mismo');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
