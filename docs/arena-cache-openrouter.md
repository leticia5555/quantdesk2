# CACHÉ DE PREFIJO EN OPENROUTER — QUÉ SE PUEDE ACTIVAR Y QUÉ NO

Investigado el **2026-09-29**. La documentación de `openrouter.ai` está
bloqueada por el proxy de egress de este entorno, así que lo de abajo sale de
fuentes secundarias que citan esa documentación. **Está marcado por nivel de
confianza, y la verificación barata está al final: no hay que creerle a este
doc, hay que correr el §4.**

## El dato que lo hace urgente

Los cinco de OpenRouter corren con `caps.cache = null` salvo `openai`, que
tiene `'auto'`. Cada vuelta del loop re-manda la conversación entera, y el
costo del loop es **cuadrático**: con 20 herramientas el prefijo viaja 21
veces.

**132 de 380 vueltas (35%) se pagaron en corridas que abortaron.** Sobre eso,
la caché no es una optimización: es la diferencia entre pagar una vez el
prefijo y pagarlo veintiuna.

## 1 · NO ES UNA PALANCA, SON TRES MECANISMOS

Y ésta es la conclusión que más importa, porque la acción obvia —poner
`cache_control` en los cinco, como hacemos con Anthropic— **está mal en al
menos uno de los cinco.**

| agente | slug | mecanismo | qué hay que hacer |
|---|---|---|---|
| `openai` | `openai/gpt-6-astra` | **implícito** | nada. Ya está en `'auto'` y es correcto |
| `grok` | `x-ai/grok-4.6` | **implícito**, pero con *sticky routing* | no `cache_control`; ver §2 |
| `gemini` | `google/gemini-3.8-flash` | **implícito** (2.5+) | **no** poner `cache_control`: ver §3 |
| `deepseek` | `deepseek/deepseek-v4-pro` | depende del endpoint | medir antes de tocar; ver §4 |
| `qwen` | `qwen/qwen3.8-2.4t-a95b` | **explícito** (Alibaba) | `cache_control: {type:'ephemeral'}`, como Anthropic |

**Confianza:** alta para OpenAI y Grok (implícito), media-alta para Gemini 2.5+,
**baja para nuestros dos slugs exactos** — `deepseek-v4-pro` y
`qwen3.8-2.4t-a95b` son posteriores a lo que las fuentes enumeran, y una
familia no hereda el mecanismo de su predecesora. Por eso el §4.

## 2 · GROK: LA CACHÉ ES AUTOMÁTICA, PERO SE PIERDE POR ROUTING

El hallazgo menos obvio y el que más se parece a un bug nuestro.

La caché de xAI es automática y no necesita configuración, **pero es
especialmente sensible a la afinidad de servidor**: para que dos llamadas
peguen en la misma caché, tienen que ir al mismo endpoint del proveedor.
OpenRouter usa un `session_id` estable como clave de ruteo pegajoso para
mandar los follow-ups al mismo lugar.

**Nosotros no mandamos ninguno.** Verificado: `grep session_id
api/_lib/arena-model.js` no devuelve nada. Así que cada vuelta del loop puede
caer en un endpoint distinto, y **la caché automática no pega aunque exista.**

Y esto engancha con B23: OpenRouter reparte un mismo slug entre varias
empresas, y ya vimos a `Alibaba` colgándose después de tres vueltas buenas. El
ruteo pegajoso ataca las dos cosas a la vez — la caché y la varianza de
proveedor — con el mismo cambio.

> **Es la palanca con mejor relación valor/riesgo de las tres**: un campo por
> corrida, no cambia el prompt, y si no sirve no rompe nada.

## 3 · GEMINI: PONER `cache_control` PUEDE COSTAR MÁS

Gemini 2.5+ cachea **implícitamente**. Y según lo que citan las fuentes de la
documentación de OpenRouter, para Gemini **solo cuenta el último breakpoint**,
así que un `cache_control` explícito puede agregar cargos de *cache write* y de
almacenamiento que la caché implícita evita, **sin beneficio del lado de la
lectura**.

O sea: el cambio "obvio" —marcar el prefijo igual que en Anthropic— sería
**pagar de más** en este agente. Es exactamente la clase de acción que parece
una optimización y es un costo.

## 4 · CÓMO SE VERIFICA, Y ES GRATIS

Nada de lo de arriba hay que creerlo: **ya tenemos la instrumentación**.

`api/_lib/arena-model.js:237` manda `body.usage = { include: true }`, y la
línea 167 ya lee:

```js
cache_read_input_tokens: Number((u.prompt_tokens_details || {}).cached_tokens) || 0
```

Y `recordRunSpend` lo guarda **por corrida** en la tabla `arena_spend`,
columnas `cache_read` / `cache_write` / `input_tokens`.

> **Corrección, porque la escribí mal la primera vez y la corrí antes de
> publicarla:** iba a consultar `context->'cost'` del journal.
> `ctx.cost = callCost(...)` devuelve **solo** `{ usd, source }` — los tokens
> no están ahí. Viven en `arena_spend`, que es otra tabla. Una consulta contra
> el lugar equivocado habría devuelto `null` en todas las filas y se habría
> leído como *"ningún agente cachea"*, que es la conclusión falsa más cara
> posible acá: nos habría mandado a activar caché en los cinco.

```sql
-- ¿QUÉ AGENTE ESTÁ PEGANDO LA CACHÉ, HOY, EN PRODUCCIÓN?
-- Cero llamadas nuevas: lee lo que ya se registró.
select agent_id,
       count(*)                     as corridas,
       sum(cache_read)              as tokens_de_cache,
       sum(cache_write)             as tokens_escritos,
       sum(input_tokens)            as tokens_de_entrada,
       round(100.0 * sum(cache_read) / nullif(sum(input_tokens), 0), 1) as pct_cacheado,
       round(sum(usd)::numeric, 2)  as usd,
       sum(llm_calls)               as llamadas
  from arena_spend
 where day >= '2026-09-14'
 group by 1
 order by pct_cacheado desc nulls last;
```

**OJO con `input_tokens` como denominador:** según el proveedor, los tokens
cacheados pueden venir INCLUIDOS en `prompt_tokens` o aparte. Si algún
`pct_cacheado` sale por encima de 100, el denominador es el que está mal, no
la caché. Lo que se compara entre agentes es la COLUMNA `tokens_de_cache`
contra cero, que no depende de eso.

**Cómo se lee:**

- `claude` y `control` con `pct_cacheado` alto → la instrumentación funciona, y
  es el control de esta medición.
- `openai` en 0 → el `'auto'` no está haciendo nada y hay que mirarlo.
- `grok` en 0 → coherente con §2 (falta el ruteo pegajoso).
- `qwen` / `deepseek` en 0 → coherente con el mecanismo explícito que no
  mandamos.

**Si `claude` también sale en 0, el problema es la lectura y no la caché**, y
todo lo demás de este doc es ruido hasta arreglar eso. Ésa es la primera
hipótesis a descartar, no la última.

### Un detalle que apareció leyendo esto y no es de caché

`recordRunSpend` se llama con `phase: 'shadow'` **hardcodeado** dentro de
`runAgenteObjetivo` (`api/arena-shadow.js`), y esa función es la que corre
también EN VIVO. O sea que el gasto de una ronda viva se registra como si
fuera de sombra.

**No rompe el breaker:** la consulta del gasto del día (`arena-budget.js:183`)
agrupa por `agent_id` y **no filtra por `phase`**, así que el total es
correcto. Lo que no se puede contestar hoy es *"cuánto costó la liga viva
contra cuánto costó la sombra"*. Es una línea (`phase: vivo ? 'decide' :
'shadow'`) y no va en este cambio: lo anoto acá para que no se pierda.

## 5 · EL ORDEN QUE RECOMIENDO

No tocar los cinco a la vez: son tres mecanismos, y un cambio simultáneo en
cinco agentes mezcla el efecto con el ruido de proveedor que ya sabemos que
existe.

1. **Correr el §4.** Es gratis y puede cambiar todo lo de arriba.
2. **Grok: el `session_id` pegajoso.** Un campo, mecanismo implícito, ataca
   también la varianza de proveedor de B23. Si no sirve, no rompe nada.
3. **Qwen: `cache_control` explícito**, que es la misma forma que ya usamos
   con Anthropic y el código ya sabe construir (`caps.cache = 'anthropic'`
   marca el prefijo; haría falta un canal `'alibaba'` o reusar ése si el
   formato coincide).
4. **Gemini: NO tocar** salvo que el §4 muestre 0% cacheado, y aun así medir
   contra el costo, no contra el porcentaje.
5. **DeepSeek: medir primero.** El mecanismo depende del endpoint y nuestro
   slug es posterior a lo documentado.

**Y con B43 en la mano:** cada cambio se mide contra el agente ANTES y DESPUÉS,
no contra los otros agentes del mismo día. Si se cambian dos a la vez y los dos
mejoran el martes, puede ser el martes.

## Fuentes

Secundarias, citando la documentación de OpenRouter (el dominio está bloqueado
desde este entorno):

- [Prompt Caching — OpenRouter docs (vía búsqueda)](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [OpenRouter Prompt Caching: What Cached Tokens Cost](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/)
- [OpenRouter Prompt Caching: Fix Cache Misses & Check Costs — Tokenminning](https://tokenminning.ai/gateways/openrouter/caching)
- [OpenRouter Prompt Caching: Which Discounts Survive — China LLM Directory](https://china-llm.com/blog/openrouter-prompt-caching)
- [OpenRouter Prompt Caching: Why Your Cache Isn't Hitting](https://aireiter.com/blog/openrouter-prompt-caching-guide)
