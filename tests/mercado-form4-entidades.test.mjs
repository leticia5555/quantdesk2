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
