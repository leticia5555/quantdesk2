# FASE 1a — Captura trimestral automática del XBRL de BMV

> **Reloj:** BMV publica gratis **sólo el trimestre vigente**. Cuando salga el
> 3T2026 (finales de octubre), el 2T2026 desaparece de la página gratis y el
> histórico sólo se consigue comprándolo (`docs/xbrl-fase0.md` §1.2, §3.2).
> **La primera corrida completa tiene que pasar antes del 20 de octubre.**
>
> **Estado: código listo, nada corrido contra BMV.** Mi sandbox no llega a
> `bmv.com.mx` (mismo caso que la SEC), así que **no ejecuté una sola request
> contra ellos**. El smoke lo corres tú desde prod. Lo que sí está verificado
> acá son los 29 tests del parser y del scraping de la fila.

---

## 1. Censo

### 1.1 Universo v1 — emisoras ICS

Viven en `api/_lib/emisoras.json`. **30 emisoras: 23 con id verificado, 7 sin
id.** El id interno de BMV no se deriva del ticker, así que cada uno se confirma
viéndolo en una URL real; **el que no se confirmó va `id: null` y el capturador
lo salta reportando el motivo.** Nunca se inventa un id.

| Clave | id BMV | Nombre | Sector | Verificado |
|---|---|---|---|---|
| AMX | 6024 | América Móvil | telecom | ✅ |
| WALMEX | 5214 | Walmart de México | consumo | ✅ |
| FEMSA | 5305 | Fomento Económico Mexicano | consumo | ✅ |
| GMEXICO | 6008 | Grupo México | materiales | ✅ |
| CEMEX | 5203 | Cemex | materiales | ✅ |
| BIMBO | 5163 | Grupo Bimbo | consumo | ✅ |
| TLEVISA | 5720 | Grupo Televisa | telecom | ✅ |
| ORBIA | 5188 | Orbia | materiales | ✅ |
| KOF | 5525 | Coca-Cola FEMSA | consumo | ✅ |
| ALFA | 5052 | Alfa | industrial | ✅ |
| PE&OLES | 5608 | Industrias Peñoles | materiales | ✅ |
| GRUMA | 5454 | Gruma | consumo | ✅ |
| ALSEA | 5059 | Alsea | consumo | ✅ |
| ASUR | 6001 | Grupo Aeroportuario del Sureste | industrial | ✅ |
| LIVEPOL | 5536 | El Puerto de Liverpool | consumo | ✅ |
| KIMBER | 5524 | Kimberly-Clark de México | consumo | ✅ |
| GCARSO | 5393 | Grupo Carso | industrial | ✅ |
| ELEKTRA | 5457 | Grupo Elektra | consumo | ✅ |
| PINFRA | 5725 | Pinfra | industrial | ✅ |
| CHDRAUI | 5209 | Grupo Comercial Chedraui | consumo | ✅ |
| GCC | 5394 | Grupo Cementos de Chihuahua | materiales | ✅ |
| BOLSA | 7029 | Bolsa Mexicana de Valores | servicios fin. no bancarios | ✅ |
| CUERVO | 32378 | Becle (José Cuervo) | consumo | ✅ |
| **GAP** | — | Grupo Aeroportuario del Pacífico | industrial | ❌ **[NO VERIFICADO]** |
| **OMA** | — | Grupo Aeroportuario Centro Norte | industrial | ❌ **[NO VERIFICADO]** |
| **AC** | — | Arca Continental | consumo | ❌ **[NO VERIFICADO]** |
| **VESTA** | — | Vesta | inmobiliario | ❌ **[NO VERIFICADO]** |
| **MEGA** | — | Megacable | telecom | ❌ **[NO VERIFICADO]** |
| **LASITE** | — | Sitios Latinoamérica | telecom | ❌ **[NO VERIFICADO]** |
| **VOLAR** | — | Volaris | industrial | ❌ **[NO VERIFICADO]** |

Los 23 verificados salen de URLs vistas en resultados de búsqueda, del tipo
`bmv.com.mx/es/emisoras/informacionfinanciera/GRUMA-5454-CGEN_CAPIT`. Los 7 sin
id no aparecieron en ninguna URL que pudiera ver; **completarlos son 7 visitas
al navegador**, y hasta entonces el `?run=1` los reporta en `saltadas`.

**Excluidas a propósito** (usan taxonomías distintas de ICS, decisión de Fase 0
§2.1): GFNORTE, BBAJIO, RA, GENTERA, GFINBUR (bancos), Q (aseguradora — la
taxonomía de seguros es otra), FUNO y FIBRAMQ (FIBRAs).

### 1.2 Cómo se ve la fila del XBRL en la página

En `/es/emisoras/informacionfinanciera/{CLAVE}-{ID}-CGEN_CAPIT`, bajo
**ESTADOS FINANCIEROS BÁSICOS**, cada envío es una fila con tres cosas:

| Qué | Ejemplo |
|---|---|
| Fecha-hora de envío | `23-Jul-2026 14:11` |
| Nombre del documento | `Información Del Trimestre 2 Del Año 2026` |
| Link al visor | `visorXbrl.html?docins=../ifrsxbrl/ifrsxbrl_{DOCID}_{AAAA}-{TT}_1.zip` |

El zip directo, que es lo que se baja:

```
https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_{DOCID}_{AAAA}-{TT}_1.zip
```

**`{TT}` es el trimestre, no el mes** (`2026-02` = 2T2026). El sufijo `_1` es el
consecutivo de envío: **si hay `_2`, es una reexpresión y gana la más alta.**

> **La fecha-hora es el dato que no se puede perder.** Es la fecha de **envío**
> a BMV, la que evita look-ahead (decisión D8). **No está dentro del XBRL**: el
> archivo no trae ni siquiera la fecha de autorización del consejo
> (`docs/xbrl-fase0.md` §2.5). Existe sólo en este listado, así que **si no se
> captura al momento de bajar, se pierde para siempre.** Por eso el capturador
> la lee de la misma fila que el link, no de una fila vecina — hay un test para
> exactamente eso.

---

## 2. Diseño

```
api/_lib/emisoras.json   universo v1 (dato, no código)
api/_lib/xbrl-parse.js   lector del XBRL de BMV, extraído de scripts/xbrl-smoke.mjs
api/xbrl-capture.js      el endpoint: ?smoke=1 · ?run=1 · estado
docs/sql/xbrl-capture.sql   la tabla, para leerla sin levantar la app
```

### 2.1 `xbrl-parse.js` — el lector

Lo que BMV publica **no es XBRL estándar**: es un zip con un `.json` que es el
volcado del modelo interno del editor de EMISNET. Ninguna herramienta XBRL lo
lee (§1.1 de Fase 0). El módulo hace: zip → json → contextos y hechos → los 9
campos → identidades contables.

Sin dependencias (zip con `zlib`, como el resto del repo).

**Reglas que hereda de Fase 0 y 0b, todas con test:**

- **Sólo contextos sin dimensiones.** Un hecho con segmento/moneda/subsidiaria
  se descarta: queremos el consolidado.
- **La ventana de 3 meses manda.** Un instance trae 3m, 6m y 12m con el mismo
  cierre; la de 3m es el valor principal y las otras van en `otras_ventanas`.
  Si sólo hay acumulado, ése es el principal con su ventana real.
- **Deuda con costo es una suma**, no un tag: `CreditosBancarios*` +
  `CreditosBursatiles*` + `OtrosCreditosConCosto*`, por plazo. Los
  arrendamientos IFRS-16 van aparte (D3 sigue abierta) y **un componente
  ausente no es cero**: se reporta en `faltantes`.
- **Fail-closed.** Un campo que no resuelve queda `null` **con motivo escrito**.
  Nunca un proxy, nunca una escala adivinada.

### 2.2 `xbrl-capture.js` — el endpoint

| Modo | Auth | Escribe | Qué hace |
|---|---|---|---|
| `?smoke=1` | público | **no** | WALMEX y FEMSA: página → fila → zip → parse → compara contra Fase 0 |
| `?run=1` | `Bearer ADMIN_SECRET` | sí | recorre el universo, captura lo que falte |
| *(sin query)* | público | no | ayuda + estado de la tabla |

**Gating fail-closed**, mismo patrón que `/api/macro-events`: sin `ADMIN_SECRET`
(o `CRON_SECRET`) configurado, `?run=1` devuelve 401. Mejor un capturador
inutilizable que una tabla abierta a internet.

**Idempotencia:** `doc_id` es `UNIQUE` y el insert lleva `on conflict do
nothing`. Correr dos veces no duplica, y no depende de leer antes de escribir.

**Cortesía con BMV:** 1 request/segundo, User-Agent
`quantdesk-xbrl-capture/1.0 (+<contacto>)` configurable con `XBRL_CONTACT`, y
**un reintento sólo en 5xx o error de red — nunca en 4xx**. Un 404 significa
"no está", y martillar no lo va a materializar.

**Cero llamadas a Claude.** Esto es determinista de punta a punta.

### 2.3 Cron

```json
{ "path": "/api/xbrl-capture?run=1", "schedule": "0 13 * * 1" }
```

Lunes 13:00 UTC (7:00 CDMX), alineado con la franja de los demás crons del repo.
**Semanal** es lo más conservador posible frente al límite de plan que preocupa
al issue #66 — un reporte trimestral no cambia entre lunes, y con cuatro
ventanas de publicación al año basta con no perderse ninguna.

El cron **no sustituye la primera corrida manual**: si el 2T2026 se cae de la
página antes del lunes siguiente, el cron llega tarde.

---

## 3. Migración

No hace falta correrla a mano: `ensureSchema()` crea la tabla y sus índices en
el primer request. Está en `docs/sql/xbrl-capture.sql` para leerla y para
aplicarla en un entorno nuevo sin levantar la app.

Tres decisiones que vale la pena mirar:

- **`raw_json` es `NOT NULL`.** El original completo se guarda **siempre**,
  aunque los campos normalizados fallen. Es lo que permite re-parsear sin
  volver a BMV — y volver a BMV no va a ser una opción cuando el trimestre
  desaparezca de la página.
- **`doc_id` es `UNIQUE`.** Es la idempotencia.
- **Cada uno de los 9 campos lleva `_tag`, `_ventana` y `_motivo`.** Un campo
  que no validó queda `NULL` con el motivo escrito. Nunca un número que no pasó.

---

## 4. Cómo correr

### 4.1 Smoke (primero, siempre)

```bash
curl -s 'https://<tu-dominio>/api/xbrl-capture?smoke=1' | jq
```

Es público y no escribe nada. Devuelve, por emisora, cada paso (`pagina`,
`fila_xbrl`, `zip`, `parse`, `campos`) con su resultado, y una tabla
`comparacion` de los 9 campos contra los valores de Fase 0.

**Qué mirar:**

1. `veredicto: "ok"` — los 9 campos de ambas emisoras reproducen Fase 0.
2. Si algún `cuadra: false`, el campo, el esperado y el obtenido están ahí.
3. Si la página **ya no sirve 2T2026** sino 3T2026, el smoke lo dice en una
   `nota` y no marca error: la comparación contra Fase 0 deja de aplicar, pero
   la captura sí funcionó. **Eso también es la señal de que el 2T2026 se
   perdió.**

### 4.2 Run

```bash
curl -s -H "Authorization: Bearer $ADMIN_SECRET" \
     'https://<tu-dominio>/api/xbrl-capture?run=1' | jq
```

Devuelve `{capturadas, ya_existentes, saltadas, fallidas}` con el detalle por
emisora y el motivo de cada falla. Es seguro correrlo dos veces.

### 4.3 Estado

```bash
curl -s 'https://<tu-dominio>/api/xbrl-capture' | jq
```

### 4.4 Tests locales

```bash
node tests/xbrl-parse.test.mjs          # 18 tests del lector
node tests/xbrl-capture-fila.test.mjs   # 11 tests del scraping de la fila
```

---

## 5. Qué esperar en la primera corrida

Con el universo como está hoy:

| | |
|---|---|
| Emisoras intentadas | **23** (las que tienen id) |
| Saltadas sin tocar la red | **7** (`sin id verificado`) |
| Requests a BMV | ~46 (una página + un zip por emisora) |
| Duración estimada | **~2 minutos** (1 req/s + descarga) |
| Escrituras esperadas | 23 filas, una por emisora, del trimestre vigente |

**Lo que me sorprendería que saliera perfecto a la primera**, en orden de
probabilidad:

1. **Alguna emisora sin fila de XBRL en la página.** No todas publican al mismo
   ritmo, y alguna puede tener el trimestre anterior. Sale como `fallida` con
   motivo `sin fila de XBRL`, o se captura el trimestre que haya — que igual
   sirve, porque el `anio`/`trimestre` se leen del archivo, no se asumen.
2. **Alguna que no use ICS.** El parser lo detecta y lo pone en `alertas`
   (`entry point inesperado`), pero **igual guarda el raw**. BOLSA es la
   candidata más probable a comportarse distinto.
3. **Campos en `null` con motivo.** Esperable y correcto: WALMEX reporta deuda
   con costo en cero explícito, pero otra emisora puede simplemente no traer
   esos tags. `null` con motivo es el resultado bueno; un número inventado
   sería el malo.
4. **El import de JSON.** `api/xbrl-capture.js` hace
   `import ... with { type: 'json' }`, que es el **primer import de JSON del
   repo**. Funciona en Node 22 (probado local, los tests lo importan), pero si
   Vercel corriera un Node más viejo el endpoint fallaría al cargar. **El smoke
   lo descubre en el primer request** — si devuelve un error de módulo, es eso.

**Después de la corrida, verificar en Neon:**

```sql
select clave, anio, trimestre, fecha_publicacion, identidades_ok,
       jsonb_array_length(alertas) as n_alertas
  from xbrl_reports order by clave;
```

Una fila por emisora, `fecha_publicacion` no nula, `identidades_ok` en `true`.

---

## 6. Qué me preocupa

1. **El reloj.** Es el riesgo que no se arregla con código. Si el 2T2026 se cae
   antes de la primera corrida, ese trimestre hay que comprarlo. **Correr el
   smoke y el run el mismo día que leas esto** vale más que cualquier mejora al
   capturador.
2. **Los 7 ids que faltan.** Son 7 visitas al navegador y no las puedo hacer yo.
   Mientras tanto ese 23% del universo no se captura, y cada trimestre que pase
   sin ellos es un trimestre suyo que se pierde.
3. **El scraping de la fila es lo frágil.** El parser del XBRL está probado
   contra archivos reales; la lectura del HTML está probada contra fixtures que
   yo escribí a partir de una descripción. Si BMV rediseña esa tabla, se rompe
   ahí. Los 11 tests acotan el daño pero no sustituyen ver la página real.
4. **El límite de 300s si el universo crece.** 23 emisoras caben de sobra; a
   partir de ~60 el `?run=1` habría que partirlo por lotes.
5. **Reexpresiones.** Si una emisora reenvía como `_2`, el capturador toma la
   secuencia más alta — pero como `doc_id` es el del archivo, la reexpresión
   entra como **fila nueva**, no pisa a la anterior. Es lo correcto para
   auditoría (queda el histórico de lo que se publicó y cuándo), pero quien
   consulte la tabla tiene que quedarse con la última por `(clave, anio,
   trimestre)`, no asumir que hay una sola.

---

PR listo — no more pushes.
