// ═══════════════════════════════════════════════════════════════════════
// EL ÍNDICE DIARIO DE EDGAR — la lista completa, no la ventana
//
// Lety, 2026-10-22: *"Insiders completos, no solo la ventana de
// `getcurrent`."* El feed de lo recién presentado son los últimos ~200
// filings de TODOS los formularios: en un día de temporada de reportes se
// presentan más de mil Form 4, así que esa ventana cubre menos de una hora.
//
// El índice diario sí es la lista completa del día, y con ella hay
// DENOMINADOR. Sin denominador, "cobertura" es una palabra.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimestreDe, urlIndiceDiario, diasHabiles, accessionDeArchivo,
  parseIndiceEdgar, form4DelIndice, coberturaDeDia,
} from '../api/_lib/edgar-indice.js';

// ── LA RUTA ──────────────────────────────────────────────────────────
test('la URL del índice lleva el trimestre, que es parte de la ruta', () => {
  assert.equal(urlIndiceDiario('2026-10-21'),
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261021.idx');
  assert.equal(urlIndiceDiario('2026-01-02'),
    'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR1/form.20260102.idx');
  // El `master.idx` del trimestre sirve para el relleno inicial.
  assert.match(urlIndiceDiario('2026-07-01', { tipo: 'master' }), /master\.20260701\.idx$/);
});

test('los límites del trimestre no se corren por un mes', () => {
  assert.equal(trimestreDe('2026-03-31'), 1);
  assert.equal(trimestreDe('2026-04-01'), 2);
  assert.equal(trimestreDe('2026-09-30'), 3);
  assert.equal(trimestreDe('2026-10-01'), 4);
  assert.equal(trimestreDe('no-es-fecha'), null);
});

// ── LOS DÍAS ─────────────────────────────────────────────────────────
test('los días hábiles saltan el fin de semana, del más nuevo al más viejo', () => {
  // 2026-10-21 es miércoles.
  assert.deepEqual(diasHabiles('2026-10-21', 5),
    ['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-16', '2026-10-15']);
});

test('los FERIADOS no se modelan, y es deliberado', () => {
  // EDGAR no publica índice los días que no abre, así que el 404 ES la
  // respuesta. Un calendario de feriados escrito a mano se pudre solo — ya
  // costó un chip mintiendo tres días — y acá no hace falta.
  const dias = diasHabiles('2026-12-25', 3);   // 25-dic es viernes y feriado
  assert.ok(dias.includes('2026-12-25'), 'se pide igual: la ausencia del archivo contesta');
});

// ── EL PARSER ────────────────────────────────────────────────────────
const FORM_IDX = `Description:           Daily Index of EDGAR Dissemination Feed
Last Data Received:    October 21, 2026
Comments:              webmaster@sec.gov

Form Type   Company Name                                   CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------
4           Aadi Bioscience, Inc.                          1422142     2026-10-21  edgar/data/1422142/0001209191-26-012345.txt
4           A  DOUBLE  SPACE CORP                          99          2026-10-21  edgar/data/99/0000000099-26-000001.txt
4/A         ENMIENDA CORP                                  1234        2026-10-21  edgar/data/1234/0000001234-26-000002.txt
8-K         OTRA COSA INC                                  5678        2026-10-21  edgar/data/5678/0000005678-26-000003.txt
40-APP      FONDO RARO                                     9999        2026-10-21  edgar/data/9999/0000009999-26-000004.txt`;

const MASTER_IDX = `CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
1422142|Aadi Bioscience, Inc.|4|2026-10-21|edgar/data/1422142/0001209191-26-012345.txt
5678|OTRA COSA INC|8-K|2026-10-21|edgar/data/5678/0000005678-26-000003.txt`;

test('parsea el índice de columnas, con la cabecera y los separadores fuera', () => {
  const r = parseIndiceEdgar(FORM_IDX);
  assert.equal(r.filas.length, 5);
  assert.equal(r.descartadas, 0);
  assert.equal(r.filas[0].form, '4');
  assert.equal(r.filas[0].cik, '1422142');
  assert.equal(r.filas[0].accession, '0001209191-26-012345');
  assert.equal(r.filas[0].empresa, 'Aadi Bioscience, Inc.');
});

test('y el nombre con DOS espacios seguidos no lo rompe', () => {
  // Partir por `\\s{2,}` parece razonable y se cae con esto, que existe.
  // Por eso se lee desde la derecha, donde los tres últimos campos tienen
  // forma inconfundible.
  const fila = parseIndiceEdgar(FORM_IDX).filas.find((f) => f.cik === '99');
  assert.equal(fila.empresa, 'A  DOUBLE  SPACE CORP');
  assert.equal(fila.form, '4');
});

test('parsea también el de barras (master.idx), que es otra forma del mismo día', () => {
  const r = parseIndiceEdgar(MASTER_IDX);
  assert.equal(r.filas.length, 2);
  assert.equal(r.filas[0].form, '4');
  assert.equal(r.filas[0].accession, '0001209191-26-012345');
  assert.equal(r.filas[0].empresa, 'Aadi Bioscience, Inc.');
});

test('un 40-APP no es un Form 4, por más que empiece con 4', () => {
  // `startsWith('4')` habría metido 40-APP, 40-17G y compañía en el
  // denominador, y la cobertura no habría cerrado nunca.
  const f4 = form4DelIndice(parseIndiceEdgar(FORM_IDX).filas);
  assert.equal(f4.total, 2);
  assert.ok(f4.filas.every((f) => f.form === '4'));
});

test('las enmiendas (4/A) quedan fuera de los dos lados del quebrado, y se cuentan', () => {
  // Una 4/A corrige un Form 4 anterior. En el denominador haría que la
  // cobertura pidiera guardar dos veces el mismo hecho; sólo en el
  // denominador, no cerraría nunca.
  const f4 = form4DelIndice(parseIndiceEdgar(FORM_IDX).filas);
  assert.equal(f4.enmiendas, 1);
  assert.ok(!f4.filas.some((f) => f.form === '4/A'));
});

test('el accession sale de la ruta del documento', () => {
  assert.equal(accessionDeArchivo('edgar/data/320193/0000320193-26-000070.txt'), '0000320193-26-000070');
  assert.equal(accessionDeArchivo('no-tiene'), null);
});

// ── LA COBERTURA ─────────────────────────────────────────────────────
//
// La prueba que pidió Lety: para un día cerrado, lo que guardamos tiene que
// ser igual a las líneas de Form 4 del índice de ese día.
test('un día cerrado con todo guardado dice 100% CON los dos números', () => {
  const idx = parseIndiceEdgar(FORM_IDX);
  const f4 = form4DelIndice(idx.filas);
  // Se guardaron los dos Form 4 del índice.
  const c = coberturaDeDia({ fecha: '2026-10-21', enIndice: f4.total, guardados: 2 });
  assert.equal(c.completa, true);
  assert.equal(c.pct, 100);
  assert.equal(c.texto, 'Cobertura: 100% de los Form 4 del día (2 de 2)');
});

test('si falta uno, lo dice con el número que falta', () => {
  const c = coberturaDeDia({ fecha: '2026-10-21', enIndice: 1842, guardados: 1700 });
  assert.equal(c.completa, false);
  assert.match(c.texto, /92\.3%/);
  assert.match(c.texto, /\(1700 de 1842\)/);
  assert.match(c.texto, /faltan 142/);
});

test('un porcentaje sin los dos números no se puede auditar, así que nunca va solo', () => {
  // "100%" de un denominador equivocado también dice 100%.
  for (const [n, d] of [[0, 10], [5, 10], [10, 10], [12, 10]]) {
    assert.ok(coberturaDeDia({ fecha: 'x', enIndice: d, guardados: n }).texto.includes(`(${n} de ${d})`),
      `${n}/${d}: ` + coberturaDeDia({ fecha: 'x', enIndice: d, guardados: n }).texto);
  }
});

test('un día sin índice no es 0%: es que EDGAR no publicó', () => {
  // Decir "0% de cobertura" un feriado sería acusarnos de un hueco que no
  // existe. Son dos cosas distintas y se arreglan distinto.
  const c = coberturaDeDia({ fecha: '2026-12-25', enIndice: null, guardados: 0 });
  assert.equal(c.pct, null);
  assert.equal(c.completa, false);
  assert.match(c.texto, /no publicó/);
  const conMotivo = coberturaDeDia({ fecha: '2026-12-25', motivo: 'EDGAR no publicó índice ese día (feriado o fin de semana)' });
  assert.match(conMotivo.texto, /feriado/);
});

test('guardar MÁS de los que el índice trae sigue siendo completa, no 120%', () => {
  // Pasa cuando una enmienda trae filas de un filing que ya teníamos.
  const c = coberturaDeDia({ fecha: 'x', enIndice: 10, guardados: 12 });
  assert.equal(c.completa, true);
});

// ── EL XML DENTRO DEL ENVÍO ──────────────────────────────────────────
//
// El índice da la ruta del `.txt`: el envío entero. Leer el XML de ahí cuesta
// UNA petición; averiguar su nombre con `index.json` y después pedirlo cuesta
// dos. En el relleno de 30 días eso son ~45.000 peticiones menos a la SEC.
const ENVIO = `-----BEGIN PRIVACY-ENHANCED MESSAGE-----
<SEC-DOCUMENT>0001209191-26-012345.txt : 20261021
<SEC-HEADER>
ISSUER:
  COMPANY DATA:
    COMPANY CONFORMED NAME: AADI BIOSCIENCE INC
</SEC-HEADER>
<DOCUMENT>
<TYPE>4
<SEQUENCE>1
<FILENAME>doc4.xml
<TEXT>
<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerCik>1422142</issuerCik><issuerName>Aadi</issuerName>
    <issuerTradingSymbol>AADI</issuerTradingSymbol></issuer>
</ownershipDocument>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>EX-24
<TEXT>
<html><body>Poder notarial, que NO es el Form 4</body></html>
</TEXT>
</DOCUMENT>`;

test('el XML del Form 4 se saca del envío completo', async () => {
  const { ownershipDeEnvio, urlDeArchivo } = await import('../api/_lib/edgar-indice.js');
  const xml = ownershipDeEnvio(ENVIO);
  assert.match(xml, /^<ownershipDocument>/);
  assert.match(xml, /<\/ownershipDocument>$/);
  // La cabecera SGML queda fuera: trae líneas como `ISSUER:` que no son
  // etiquetas y no hay por qué pasearle por delante al parser.
  assert.ok(!xml.includes('SEC-HEADER'));
  // Y el adjunto que NO es el Form 4, tampoco.
  assert.ok(!xml.includes('Poder notarial'));
  assert.equal(urlDeArchivo('edgar/data/1422142/0001209191-26-012345.txt'),
    'https://www.sec.gov/Archives/edgar/data/1422142/0001209191-26-012345.txt');
});

test('y el parser de Form 4 lo lee tal cual sale del envío', async () => {
  const { ownershipDeEnvio } = await import('../api/_lib/edgar-indice.js');
  const { form4Completo } = await import('../api/_lib/form4.js');
  const doc = form4Completo(ownershipDeEnvio(ENVIO));
  assert.ok(doc, 'el parser tiene que reconocerlo');
  assert.equal(doc.emisora.ticker, 'AADI');
  assert.equal(doc.emisora.cik, '1422142');
});

test('un envío sin Form 4 devuelve null, para poder caer al camino largo', async () => {
  const { ownershipDeEnvio } = await import('../api/_lib/edgar-indice.js');
  // Un `4` del índice cuyo envío no trae `ownershipDocument` es raro y real.
  assert.equal(ownershipDeEnvio('<SEC-HEADER>…</SEC-HEADER><DOCUMENT><TYPE>4</DOCUMENT>'), null);
  assert.equal(ownershipDeEnvio(''), null);
  // Abierto y sin cerrar tampoco: medio documento no se parsea.
  assert.equal(ownershipDeEnvio('<ownershipDocument><issuer>'), null);
});

// ═══════════════════════════════════════════════════════════════════════
// LOS CRONS, Y EL RITMO QUE SE PUEDE SOSTENER
//
// Lety: *"No quiero correr form4 a mano muchas veces."* El plan es Pro —los
// crons `*/10` y `*/5` que este repo ya corre fallarían al desplegar en
// Hobby, que sólo admite una vez al día— así que la frecuencia por minuto
// está permitida.
//
// Lo que ACOTA el ritmo no es Vercel: es la SEC. El cliente de EDGAR corre a
// 6 peticiones por segundo por defecto (`REQ_POR_SEGUNDO_DEFAULT`) y el techo
// de la SEC son 10. Con una petición por filing y 40 s de presupuesto, una
// corrida alcanza ~240 filings. Esta prueba fija esa aritmética para que
// nadie suba el tope creyendo que va a ir más rápido.
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { join as join2, dirname as dirname2 } from 'node:path';
import { fileURLToPath as fileURL2 } from 'node:url';

const RAIZ = join2(dirname2(fileURL2(import.meta.url)), '..');
const VERCEL = JSON.parse(readFileSync(join2(RAIZ, 'vercel.json'), 'utf8'));
const cronDe = (frag) => (VERCEL.crons || []).find((c) => c.path.includes(frag));

test('el índice se baja UNA vez al día, con dos días de margen', () => {
  const c = cronDe('job=indice');
  assert.ok(c, 'falta el cron del índice');
  assert.match(c.path, /dias=3/, 'tres días: el de ayer más margen por si una corrida falló');
  // Una vez al día alcanza: el índice de un día cerrado ya no cambia.
  assert.match(c.schedule, /^\d+ \d+ \* \* \*$/, c.schedule);
});

test('los XML se recogen cada diez minutos, no a mano', () => {
  const c = cronDe('job=form4');
  assert.ok(c, 'falta el cron de los XML');
  assert.equal(c.schedule, '*/10 * * * *');
});

test('y el presupuesto de la corrida cabe en el límite de la función', () => {
  // `api/*.js` da 60 s. El paso de XML se corta a los 40 y después escribe en
  // Neon: sin margen, la función muere a mitad de la escritura y los filings
  // quedan marcados como leídos sin haberse guardado.
  const glob = (VERCEL.functions || {})['api/*.js'];
  assert.ok(glob && glob.maxDuration >= 60, JSON.stringify(glob));
  const src = readFileSync(join2(RAIZ, 'api/stock-tracker.js'), 'utf8');
  const presupuesto = Number((src.match(/XML_PRESUPUESTO_MS = ([\d_]+)/) || [])[1].replace(/_/g, ''));
  assert.ok(presupuesto <= (glob.maxDuration - 15) * 1000,
    `el paso dura ${presupuesto} ms y la función ${glob.maxDuration} s`);
});

test('el tope por corrida no promete más de lo que el ritmo de la SEC da', () => {
  const src = readFileSync(join2(RAIZ, 'api/stock-tracker.js'), 'utf8');
  const tope = Number((src.match(/XML_POR_CORRIDA = (\d+)/) || [])[1]);
  const presupuestoS = Number((src.match(/XML_PRESUPUESTO_MS = ([\d_]+)/) || [])[1].replace(/_/g, '')) / 1000;
  const edgar = readFileSync(join2(RAIZ, 'api/_lib/edgar.js'), 'utf8');
  const techo = Number((edgar.match(/TECHO_SEC_REQ_POR_SEGUNDO = (\d+)/) || [])[1]);
  // UNA petición por filing (el `.txt` del envío trae el XML dentro). Si
  // alguien vuelve al camino de dos, esta cuenta deja de cerrar.
  assert.ok(tope <= presupuestoS * techo,
    `el tope es ${tope} y en ${presupuestoS}s a ${techo}/s caben ${presupuestoS * techo}`);
});
