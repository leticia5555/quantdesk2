# HISTORIA para la liga — inventario y costo del backfill

**Estado: NO EJECUTADO.** Este doc dice cómo medir la cobertura y cuánto
costaría completarla. No se ingirió ni se narró nada, y la cobertura de hoy
**no se midió**: medirla requiere `DATABASE_URL` (Neon), y esta sesión no la
tiene ni debía tocar producción.

## 1. Cuánto cubre HISTORIA hoy — **requiere DATABASE_URL**

```bash
DATABASE_URL=postgres://… node scripts/historia-inventario.mjs          # resumen
DATABASE_URL=postgres://… node scripts/historia-inventario.mjs --json   # con las listas
```

Son **tres SELECT** y nada más (la prueba `tests/arena-historia-herramienta`
lo verifica): el último snapshot `universe:*` de `arena_universe` —la lista que
vieron los agentes—, `company_emisor` y la última narración `ok` por emisor
de `company_narracion`. Devuelve:

| campo | qué es |
|---|---|
| `cubiertas` | nombres del universo con narración servible |
| `ingeridas_sin_narracion` | están en `company_emisor`, no tienen narración `ok` |
| `con_error_de_ingesta` | `company_emisor.estado = 'error'` |
| `faltan` | ni siquiera ingeridos — la lista de tickers |
| `por_narrar` | la suma de los tres de arriba |

`historia(ticker)` contesta `sin_cobertura` para todo lo que no esté en
`cubiertas`.

## 2. Costo por empresa

Dos números, y cada uno dice de dónde sale (`api/_lib/historia-inventario.js`):

| | entrada | salida | USD por empresa (Opus 5, $5/$25 por M) |
|---|---|---|---|
| **medido** | — | — | promedio de `company_narracion.costo.usd_total` de las ya narradas. **El script lo calcula; aquí no se pudo.** |
| supuesto típico | 13.400 tokens (evidencia ~12K medida en el emisor duro de la Fase B + prompt 1,4K) | 3.000 (supuesto) | **$0.142** |
| supuesto peor | 24.400 (evidencia en el techo de 80 KB) | 16.000 (techo de `MAX_TOKENS`) | **$0.522** |

Si el medido existe, manda el medido.

## 3. El backfill del universo (~570 nombres)

Cota superior suponiendo que **ninguno** está cubierto hoy (el número real sale
del paso 1):

| | USD |
|---|---|
| típico | 570 × $0.142 ≈ **$81** |
| peor | 570 × $0.522 ≈ **$298** |

Y el costo que no es dinero: **la ingesta**. Es gratis (EDGAR), pero lleva
~42 s por ticker (medido en la corrida 2, `docs/historia-fase0.md` §11): 570
tickers ≈ **6,7 h de goteo**, o sea ~82 invocaciones de
`/api/historia-harvest?job=goteo&limite=7`. Narrar exige ingerir antes.

## 4. Lo que NO se hizo, a propósito

- No se corrió el script (sin `DATABASE_URL`, y la regla de la noche: nada
  contra producción).
- No se ingirió ni se narró ningún ticker (cuesta dinero; se decide con Lety).
- `historia(ticker)` está **apagada** para los agentes: se enciende con
  `ARENA_TOOLS_EXTRA=historia`. Con la cobertura de hoy sin medir, encenderla
  podría devolver `sin_cobertura` a casi todo, y eso es ruido que el agente
  paga en tokens.
