// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-form4-entidades.test.mjs — EL `&` SE ESCAPABA DOS VECES
//
// Lety, en `/mercado/insiders` en producción (2026-10-20): el cargo salía
// *"EVP, CFO &amp; COO"* y *"Pres. &amp; Chief Tech &amp; Prod Offr"*.
//
// El Form 4 es XML, y ahí un `&` se escribe `&amp;`. `xval` devolvía la
// cadena tal cual, se guardaba tal cual en Neon, y la pantalla la escapaba
// OTRA VEZ al pintarla: `&` → `&amp;`. El usuario leyendo la segunda capa.
//
// SE ARREGLA AL PARSEAR, NO AL PINTAR. Lo que se guarda tiene que ser el
// texto real ("EVP, CFO & COO"), y escapar al pintar es correcto: es lo que
// impide que un titular con `<script>` se ejecute. Arreglarlo en la pantalla
// dejaría la base con basura y cualquier otro consumidor —el PNG de
// compartir, un export— heredaría el problema.
//
// Y NO ES SÓLO EL CARGO: los nombres con `&` son de lo más común en el
// mercado (AT&T, Procter & Gamble, Marsh & McLennan).
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { duenosDe } from '../api/_lib/form4.js';

const envuelve = (relacion, nombre = 'Quien Sea') => `<ownershipDocument><reportingOwner>
<reportingOwnerId><rptOwnerName>${nombre}</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship>${relacion}</reportingOwnerRelationship>
</reportingOwner></ownershipDocument>`;

test('el cargo con `&` sale con un `&` de verdad, no con `&amp;`', () => {
  const d = duenosDe(envuelve('<isOfficer>1</isOfficer><officerTitle>EVP, CFO &amp; COO</officerTitle>'))[0];
  assert.equal(d.cargo, 'EVP, CFO & COO');
  assert.doesNotMatch(d.cargo, /&amp;/, 'el doble escape es lo que se veía en pantalla');
});

test('y el caso largo que Lety citó, con dos `&`', () => {
  const d = duenosDe(envuelve('<isOfficer>1</isOfficer><officerTitle>Pres. &amp; Chief Tech &amp; Prod Offr</officerTitle>'))[0];
  assert.equal(d.cargo, 'Pres. & Chief Tech & Prod Offr');
});

test('el nombre del dueño también se decodifica', () => {
  const d = duenosDe(envuelve('<isDirector>1</isDirector>', 'Marsh &amp; McLennan Trust'))[0];
  assert.equal(d.nombre, 'Marsh & McLennan Trust');
});

test('`&amp;lt;` es un `<` LITERAL del texto, no una etiqueta inventada', () => {
  // El orden importa: si `&amp;` se decodificara PRIMERO, `&amp;lt;` pasaría
  // a `&lt;` y de ahí a `<`, o sea que el parser se habría inventado una
  // etiqueta que el filing no tenía. Por eso `&amp;` se decodifica al final.
  const d = duenosDe(envuelve('<isOfficer>1</isOfficer><officerTitle>Jefe de &amp;lt;cosas&amp;gt;</officerTitle>'))[0];
  assert.equal(d.cargo, 'Jefe de &lt;cosas&gt;');
});

test('comillas, apóstrofos y numéricas del XML también', () => {
  const d = duenosDe(envuelve('<isOfficer>1</isOfficer><officerTitle>VP &quot;Ops&quot; &amp; O&apos;Brien &#38; Co</officerTitle>'))[0];
  assert.equal(d.cargo, 'VP "Ops" & O\'Brien & Co');
});

test('un cargo sin entidades no se toca', () => {
  const d = duenosDe(envuelve('<isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle>'))[0];
  assert.equal(d.cargo, 'Chief Executive Officer');
});

test('sin `officerTitle` sigue saliendo el rol, con su motivo (regla 2)', () => {
  const d = duenosDe(envuelve('<isDirector>1</isDirector>'))[0];
  assert.equal(d.cargo, 'Director');
  assert.match(d.cargo_motivo, /no declaró el puesto/);
});

// ═══════════════════════════════════════════════════════════════════════
// SÓLO LA `S` ES UNA VENTA EN EL MERCADO
//
// ATKR salía con 15 personas que "vendieron todo", 38 ventas y −$60.81 M en
// la semana. Era el cierre de una fusión: código `D` —disposición A LA
// EMISORA— que esta casa estaba contando como `venta` (Lety, 2026-10-23).
// `F` (acciones retenidas para impuestos de un vesting) es el otro caso de
// insider que entrega papel sin haber decidido vender nada.
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { CODIGOS as COD4, tipoDeCodigo as tipo4, CHIPS as CHIPS4 } from '../api/_lib/form4.js';

test('D y F dejan de ser ventas de mercado; S sigue siéndolo', () => {
  assert.equal(tipo4('S').tipo, 'venta');
  assert.equal(tipo4('D').tipo, 'entrega_emisora');
  assert.equal(tipo4('F').tipo, 'impuesto');
  // La mutación que importa: si alguien vuelve a mapear D a 'venta', ATKR
  // vuelve a encabezar el Top de la semana con una fusión.
  const comoVenta = Object.entries(COD4).filter(([, v]) => v.tipo === 'venta').map(([k]) => k);
  assert.deepEqual(comoVenta, ['S'], `sólo S puede ser 'venta'; hoy son: ${comoVenta.join(', ')}`);
});

test('y no desaparecen: cada una tiene su chip', () => {
  // La regla uno del encargo vale también acá: se mueven, no se borran.
  for (const t of ['entrega_emisora', 'impuesto']) {
    assert.ok(CHIPS4.some((c) => Array.isArray(c.tipos) && c.tipos.includes(t)),
      `${t} se quedó sin forma de verse en la pantalla`);
  }
});

test('la pantalla y el lib declaran LOS MISMOS chips', () => {
  // `insiders.html` tiene una copia a mano rotulada «espejo de
  // api/_lib/form4.js». Este repo ya pagó dos días por tener dos `xval`
  // idénticos y arreglar uno solo: mientras la copia exista, que al menos no
  // pueda separarse en silencio.
  const html = readFileSync(new URL('../insiders.html', import.meta.url), 'utf8');
  const bloque = html.slice(html.indexOf('var CHIPS = ['), html.indexOf('var VISTAS'));
  for (const c of CHIPS4) {
    assert.ok(bloque.includes(`id:'${c.id}'`), `la pantalla no tiene el chip "${c.id}" que declara el lib`);
  }
  const enHtml = [...bloque.matchAll(/id:'([a-z_0-9]+)'/g)].map((m) => m[1]);
  assert.deepEqual(enHtml, CHIPS4.map((c) => c.id), 'los chips tienen que ser los mismos y en el mismo orden');
});
