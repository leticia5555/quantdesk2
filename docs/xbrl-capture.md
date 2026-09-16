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

Viven en `api/_lib/emisoras.json`. **30 emisoras: 29 con id verificado, 1 sin id.**
El id interno de BMV no se deriva del ticker, así que cada uno se confirma
viéndolo en una URL real; **el que no se confirmó va `id: null` y el capturador
lo salta reportando el motivo.** Nunca se inventa un id.

| Clave | id BMV | Nombre | Sector | Estado | Verificado |
|---|---|---|---|---|---|
| AMX | 6024 | América Móvil | telecom | activa | ✅ |
| WALMEX | 5214 | Walmart de México y Centroamérica | consumo | activa | ✅ |
| FEMSA | 5305 | Fomento Económico Mexicano | consumo | activa | ✅ |
| GMEXICO | 6008 | Grupo México | materiales | activa | ✅ |
| CEMEX | 5203 | Cemex | materiales | activa | ✅ |
| BIMBO | 5163 | Grupo Bimbo | consumo | activa | ✅ |
| TLEVISA | 5720 | Grupo Televisa | telecom | activa | ✅ |
| ORBIA | 5188 | Orbia Advance Corporation | materiales | activa | ✅ |
| KOF | 5525 | Coca-Cola FEMSA | consumo | activa | ✅ |
| ALFA | 5052 | Alfa | industrial | activa | ✅ |
| PE&OLES | 5608 | Industrias Peñoles | materiales | activa | ✅ |
| GRUMA | 5454 | Gruma | consumo | activa | ✅ |
| ALSEA | 5059 | Alsea | consumo | activa | ✅ |
| ASUR | 6001 | Grupo Aeroportuario del Sureste | industrial | activa | ✅ |
| LIVEPOL | 5536 | El Puerto de Liverpool | consumo | activa | ✅ |
| KIMBER | 5524 | Kimberly-Clark de México | consumo | activa | ✅ |
| GCARSO | 5393 | Grupo Carso | industrial | activa | ✅ |
| ELEKTRA | 5457 | Grupo Elektra | consumo | **deslistada** | ✅ |
| PINFRA | 5725 | Promotora y Operadora de Infraestructura | industrial | activa | ✅ |
| CHDRAUI | 5209 | Grupo Comercial Chedraui | consumo | activa | ✅ |
| GCC | 5394 | Grupo Cementos de Chihuahua | materiales | activa | ✅ |
| BOLSA | 7029 | Bolsa Mexicana de Valores | servicios financieros no bancarios | activa | ✅ |
| CUERVO | 32378 | Becle (José Cuervo) | consumo | activa | ✅ |
| GAP | 6579 | Grupo Aeroportuario del Pacífico | industrial | activa | ✅ |
| OMA | 6707 | Grupo Aeroportuario Centro Norte | industrial | activa | ✅ |
| AC | 6081 | Arca Continental | consumo | activa | ✅ |
| VESTA | 7793 | Corporación Inmobiliaria Vesta | inmobiliario | activa | ✅ |
| MEGA | 6854 | Megacable Holdings | telecom | activa | ✅ |
| LASITE | — | Sitios Latinoamérica | telecom | activa | ❌ **[NO VERIFICADO]** |
| VOLAR | 30023 | Controladora Vuela (Volaris) | industrial | activa | ✅ |

**Sólo falta LASITE.** Es una visita al navegador.

**El campo `estado`** (`activa` / `deslistada` / `sin_reporte`) es una anotación
humana para saber si una fila vieja es esperada o es un problema. **No es de lo
que depende la detección**: el capturador calcula solo el atraso contra el
trimestre esperado (§2.4), así que el próximo ELEKTRA se detecta aunque nadie
se acuerde de anotarlo.

**Excluidas a propósito** (usan taxonomías distintas de ICS, decisión de Fase 0
§2.1): GFNORTE, BBAJIO, RA, GENTERA, GFINBUR (bancos), Q (aseguradora), FUNO y
FIBRAMQ (FIBRAs).

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

### 2.3 Reparación de `fecha_publicacion`

`doc_id` es único, así que un segundo `?run=1` no reescribe nada… lo cual sería
un problema si una fila quedó mal guardada. Por eso hay **una sola** columna que
se repara desde la red:

```sql
on conflict (doc_id) do update
   set fecha_publicacion = excluded.fecha_publicacion
 where xbrl_reports.fecha_publicacion is null
```

**Por qué sólo ésa:** todo lo demás se puede recalcular de `raw_json`, que se
guarda completo. La fecha de envío **no está en el archivo** (D8): vive
únicamente en el listado de BMV. Si quedó `null`, la única forma de obtenerla es
volver a leer la página — y eso deja de ser posible cuando el trimestre sale de
la vista gratis.

Y la reparación **no cuesta una descarga**: la fecha viene de la página, que el
run ya pidió para saber el `doc_id`. Por eso el capturador localiza la fila
primero y sólo baja el zip si la fila es nueva.

### 2.4 Detección de emisoras que dejaron de reportar

`trimestreEsperado()` toma el último trimestre cuyo cierre lleva más de 60 días
—una emisora reporta ~1-2 meses después del cierre— y el run compara contra eso.
Una fila atrasada **sale como alerta, nunca como éxito silencioso**:

| Tipo de alerta | Cuándo |
|---|---|
| `atrasada` | la última fila está N trimestres detrás y la emisora figura como activa |
| `deslistada_esperado` | atrasada, pero ya estaba marcada `deslistada` — se confirma, no alarma |
| `revivio` | marcada `deslistada` pero publicó al día — hay que actualizar `emisoras.json` |
| `sin_fecha` | la fila no trae fecha-hora legible |

### 2.5 Cron

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
node tests/xbrl-capture-fila.test.mjs   # 17 tests de la fila, el '&' y el atraso
```

---

## 5. Resultado de la primera corrida **[VERIFICADO EN PROD]**

`?run=1` en prod: **23 capturadas con 9/9 campos, 0 fallidas, 7 saltadas sin id.**
Dos cosas salieron raras y las dos están arregladas.

### 5.1 PE&OLES: `fecha_publicacion` null — y el `&` no era lo que yo creía

PE&OLES capturó bien (doc 1579656, 2026-T2, 9/9 campos) pero sin fecha; las
otras 22 sí la trajeron.

**Primero descarté la hipótesis obvia.** Probé el parseo de la fila con el `&`
en sus tres formas —literal, como `&amp;`, y dentro de un `href`— y **las tres
sacan la fecha bien**. El `&` no rompe el parseo. Hay test para las tres.

**Lo que sí estaba mal era la URL.** Yo pedía:

```
.../informacionfinanciera/PE%26OLES-5608-CGEN_CAPIT     ← encodeURIComponent
.../informacionfinanciera/PE&OLES-5608-CGEN_CAPIT       ← lo que publica BMV
```

El `&` es un carácter **legal** dentro de un segmento de ruta (RFC 3986,
sub-delim): escaparlo era un error mío. La captura funcionó igual —el zip salió
bien— así que `%26` llega a *alguna* página válida; mi lectura es que cae en una
variante que lista el documento sin la columna de fecha.

**No pude comprobarlo** porque no tengo egress a BMV. Pero mandar la URL tal como
BMV la publica es correcto de todos modos, y ahora hay dos redes por si no era
eso: la fila sin fecha **genera alerta `sin_fecha`** en vez de un null callado, y
el siguiente `?run=1` **repara la fila ya guardada** (§2.3) sin re-descargar nada.

### 5.2 ELEKTRA: no es un bug, se deslistó

Su última fila es 2025-T4 (doc 1536787, publicado 2026-02-25) porque **Grupo
Elektra salió de la BMV**:

- **27-dic-2024** — la asamblea de accionistas aprueba cancelar el registro de
  las acciones en el RNV.
- **30-sep-2025** — BMV **suspende la cotización**, paso previo a la cancelación
  definitiva. Motivo formal: dejó de cumplir el mínimo de capital flotante
  (12% en manos del público).
- La empresa montó un fideicomiso para recomprar el ~1.08% que quedaba en manos
  del público.

Fuentes: [La Jornada](https://www.jornada.com.mx/noticia/2025/09/30/economia/bmv-suspende-cotizacion-de-grupo-elektra-tras-anuncio-previo-de-desliste),
[Bloomberg Línea](https://www.bloomberglinea.com/latinoamerica/mexico/grupo-elektra-avanza-en-el-desliste-de-sus-acciones-en-la-bolsa-mexicana/),
[La Silla Rota](https://lasillarota.com/negocios/2025/9/30/grupo-elektra-se-despide-de-la-bolsa-mexicana-de-valores-559495.html).

O sea que **el 4T2025 fue su última obligación de reporte** y la fila vieja es el
dato correcto, no una falla. Queda marcada `estado: "deslistada"` con su nota, y
el run la reporta como `deslistada_esperado`.

**Lo importante no es la anotación, es que ahora se detecta sola.** El atraso se
calcula contra el trimestre esperado (§2.4): ELEKTRA sale con 2 trimestres de
atraso aunque nadie hubiera escrito la nota. La anotación sólo cambia el tono de
la alerta de "revisar" a "confirmado".

**Consecuencia para el universo:** ELEKTRA deja de ser parte del IPC vivo. Se
mantiene en `emisoras.json` porque su histórico ya capturado vale, pero no debe
contarse como cobertura activa.

### 5.3 Qué esperar de la próxima corrida

| | |
|---|---|
| Emisoras intentadas | **29** (LASITE sigue sin id) |
| Nuevas capturas | 6 — GAP, OMA, VOLAR, AC, MEGA, VESTA |
| Reparaciones | 1 si PE&OLES ahora sí trae fecha; si no, alerta `sin_fecha` |
| Ya existentes | 23, sin descargar el zip |
| Alertas esperadas | al menos `deslistada_esperado` de ELEKTRA |

## 6. Qué me preocupa

1. **El reloj.** Es el riesgo que no se arregla con código. Si el 2T2026 se cae
   antes de la primera corrida, ese trimestre hay que comprarlo. **Correr el
   smoke y el run el mismo día que leas esto** vale más que cualquier mejora al
   capturador.
2. **LASITE sigue sin id.** Es una visita al navegador. Mientras tanto esa
   emisora no se captura, y cada trimestre que pase sin ella es un trimestre
   suyo que se pierde.
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
