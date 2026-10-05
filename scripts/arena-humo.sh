#!/usr/bin/env bash
# ── LA PUERTA DE APERTURA DE LA T3 ───────────────────────────────────
# TRES CORRIDAS POR AGENTE, y el criterio sobre las TRES.
#
# POR QUÉ TRES Y NO UNA (2026-10-02). Las dos primeras tandas dieron 5 de 7 y
# 5 de 7, pero NO los mismos cinco por las mismas razones: en la primera qwen
# murió por un techo nuestro; en la segunda ese techo ya no existía y qwen
# murió por formato. Con UNA corrida por agente no hay forma de distinguir
# "este modelo no sirve" de "este minuto no sirvió" — y abrir una temporada de
# 22 sesiones sobre esa duda es exactamente lo que tiró la T2.
#
# ── EL CRITERIO, ESCRITO ANTES DE VER LOS NÚMEROS ────────────────────
# Por AGENTE, sobre sus 3 corridas:
#
#     3 de 3 entregan libro  →  VERDE
#     2 de 3 entregan libro  →  ÁMBAR   (no abre solo: lo decide Lety)
#     ≤ 1 de 3               →  ROJO
#
# "ENTREGA LIBRO" = el `status` NO empieza con `aborted`. Eso incluye
# `rejected_rails`: un objetivo que los rieles rechazan es un modelo que SÍ
# entregó un portafolio parseable y un riel que hizo su trabajo. Son dos cosas
# distintas y la tabla las muestra separadas, pero para la puerta las dos
# cuentan como entregado — la puerta pregunta si el harness saca una decisión
# del modelo, no si la decisión le gustó.
#
# LA PUERTA ABRE si los SIETE son VERDE y las cuatro puertas físicas están en
# verde. Un solo ÁMBAR no abre la puerta: la deja en manos de Lety, con el
# detalle de qué falló en esa corrida.
#
# ── POR QUÉ RONDA Y NO RÁFAGA ────────────────────────────────────────
# Las 3 corridas de un agente NO van seguidas: se hace ronda completa de los
# siete, y después la siguiente. B43 al revés — si las tres de qwen cayeran
# dentro del mismo apagón de Alibaba, qwen saldría ROJO por un minuto malo y
# el minuto malo es justo lo que las tres corridas existen para separar.
# Así, las tres de cada agente caen en tres ventanas de ~7 minutos distintas.
#
# El halt se queda puesto: /api/arena-shadow fuerza `vivo: false` y su broker
# LANZA en toda escritura, así que no puede mandar una orden.
set -u
BASE="${BASE:-https://quantdesk2.vercel.app}"
RONDAS="${RONDAS:-3}"
AGENTES="${AGENTES:-claude control openai grok gemini deepseek qwen}"
[ -n "${REUSAR:-}" ] || : "${ARENA_ADMIN_KEY:?falta ARENA_ADMIN_KEY (set -a && . ./.env.local && set +a)}"
# ── REUSAR: REIMPRIMIR SIN VOLVER A GASTAR (2026-10-02) ──────────────
# `REUSAR=./humo-20261002T...` rearma la tabla y los veredictos desde las
# respuestas ya guardadas, sin pedir una sola llamada. Dos motivos:
#   · 21 corridas son ~50 minutos y dinero de verdad: si el formato de la tabla
#     está mal, arreglarlo no puede costar otra tanda;
#   · el jq de este script se puede PROBAR contra respuestas de juguete, que es
#     justo lo que no se hizo antes (y por eso leía `.status` de la raíz y
#     devolvía `sin_status` en las siete filas, sin que nadie lo notara).
OUT="${REUSAR:-humo-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"

# ── EL CRITERIO SE IMPRIME PRIMERO ───────────────────────────────────
# Antes de la primera fila, no después de la última. Un umbral que aparece
# junto al resultado es un umbral que se puede haber elegido mirándolo.
cat <<'CRIT'
── CRITERIO DE LA PUERTA (fijado antes de medir) ────────────────────
  por agente, sobre sus 3 corridas:
    3/3 entregados y al menos 1 SIN AYUDA  →  VERDE
    3/3 entregados y 0 sin ayuda           →  ÁMBAR   (el piso, ver abajo)
    2/3 entregados                         →  ÁMBAR
    ≤1/3 entregados                        →  ROJO
  "entrega libro" = status NO empieza con `aborted` (rejected_rails CUENTA)
  abre sólo con los SIETE en VERDE y las cuatro puertas físicas en verde

  REINTENTO SOLO-JSON: es un riel y lo tienen los siete igual, así que un libro
  rescatado CUENTA como entregado. PERO hay un piso:

    SIN_AYUDA = entregó Y (sin rescate O el rescate fue por NUESTRO techo)
    3/3 entregados con SIN_AYUDA 0/3  →  ÁMBAR, aunque el 3/3 se cumpla

  Un agente que las tres veces entregó SÓLO con rescate no se puede leer igual
  que un 3/3 limpio: abrir un mes sobre un agente que nunca cierra solo es una
  decisión, no un detalle. Un rescate con causa `corte` NO cuenta contra él —
  ése es nuestro techo de tokens apretado, no el agente.
  Un rescate con causa `desconocida` (el proveedor no mandó finish_reason) SÍ
  cuenta: no se regala un crédito que no se puede probar. Empuja a ÁMBAR, que
  lo decidís vos, no a ROJO.
CRIT
echo

# ── ¿QUÉ BUILD VAMOS A MEDIR? (2026-10-05) ───────────────────────────
# El 2026-10-05 el commit con el diagnóstico nuevo estaba en una rama SIN
# MERGEAR y producción seguía sirviendo el build del viernes. Era la TERCERA vez
# que casi medimos el sistema anterior.
#
# Esto no se arregla con cuidado, se arregla con una comparación: el catálogo es
# una llamada de 0 tokens y desde este commit devuelve `build.commit_full`. Si
# no es el HEAD local, la tanda NO arranca. `IGNORAR_BUILD=1` la fuerza — hay
# casos legítimos (medir a propósito el build anterior), y entonces se dice en
# voz alta en vez de descubrirse después.
if [ -z "${REUSAR:-}" ]; then
  LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
  CAT=$(curl -s -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-smoke?catalog=1")
  PROD=$(printf '%s' "$CAT" | jq -r '.build.commit_full // ""' 2>/dev/null || echo "")
  PRODMSG=$(printf '%s' "$CAT" | jq -r '.build.mensaje // "—"' 2>/dev/null || echo "—")
  echo "── QUÉ BUILD SE VA A MEDIR ──────────────────────────────────────"
  echo "  local (HEAD) : ${LOCAL:0:7}  $(git log -1 --format=%s 2>/dev/null | cut -c1-70)"
  echo "  producción   : ${PROD:0:7}  $(printf '%s' "$PRODMSG" | cut -c1-70)"
  if [ -z "$PROD" ]; then
    echo
    echo "  NO SE PUDO LEER EL BUILD DE PRODUCCIÓN."
    echo "  Si el catálogo no trae \`build\`, producción es anterior a este commit:"
    echo "  eso YA responde la pregunta — no está sirviendo lo que vas a medir."
    [ -n "${IGNORAR_BUILD:-}" ] || exit 3
  elif [ "$PROD" != "$LOCAL" ]; then
    echo
    echo "  PRODUCCIÓN NO SIRVE ESTE COMMIT. La tanda mediría otro sistema."
    echo "  Mergeá la rama, esperá el deploy, y verificá con:"
    echo "    curl -s -H \"x-admin-key: \$ARENA_ADMIN_KEY\" \\"
    echo "      \"$BASE/api/arena-smoke?catalog=1\" | jq '{build, cierre: .relojes.cierre_techo_ms}'"
    echo "  (IGNORAR_BUILD=1 la corre igual, a propósito y declarado.)"
    [ -n "${IGNORAR_BUILD:-}" ] || exit 3
    echo "  IGNORAR_BUILD=1: se corre igual, midiendo ${PROD:0:7}."
  else
    echo "  COINCIDEN: la tanda mide el commit que tenés acá."
  fi
  echo
fi

TOTAL=$(( RONDAS * $(echo "$AGENTES" | wc -w) ))
HECHAS=0
if [ -n "${REUSAR:-}" ]; then
  echo "REUSANDO $OUT — ninguna llamada nueva."
else
  for r in $(seq 1 "$RONDAS"); do
    for a in $AGENTES; do
      HECHAS=$(( HECHAS + 1 ))
      printf '\r  corriendo… ronda %s/%s · %-9s · %2s/%s   ' "$r" "$RONDAS" "$a" "$HECHAS" "$TOTAL" >&2
      curl -s -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-shadow?agent=$a" > "$OUT/$a-r$r.json"
    done
  done
  printf '\r%*s\r' 60 '' >&2
fi

# ── LA TABLA: UNA FILA POR CORRIDA ───────────────────────────────────
# Las tres corridas de cada agente juntas y a la vista. Un promedio de tres
# esconde justo el caso que importa — dos buenas y una muerta.
printf '%-10s %s %-24s %-13s %5s %7s %9s %6s %8s %-11s %5s %7s %-9s\n' \
  AGENTE R ESTADO CORTO VLTAS RELOJ% LECT_MAX VACÍAS NUESTROS STOP TRUNC TECHO% REINT
printf '%.0s─' {1..134}; echo

for a in $AGENTES; do
  for r in $(seq 1 "$RONDAS"); do
    f="$OUT/$a-r$r.json"
    [ -s "$f" ] || { printf '%-10s %s %-24s\n' "$a" "$r" "SIN_RESPUESTA"; continue; }
    # `.agents[0]`, NO la raíz. /api/arena-shadow devuelve `{agents:[…]}`
    # incluso con `?agent=`, y el jq viejo leía la raíz: `.status` daba null y
    # la tabla imprimía `sin_status` para TODAS las filas. Nunca se notó porque
    # las dos tandas se corrieron desde el navegador, a ojo.
    jq -r --arg a "$a" --arg r "$r" '
      (.agents[0] // {}) as $g |
      ($g.loop // {}) as $l |
      ($g.lectura_cierre // {}) as $c |
      [ $a, $r,
        ($g.status // "sin_status"),
        ($l."cortó_por" // "—"),
        ($l.vueltas // 0),
        ($l.reloj_pct // "—"),
        ($l.lectura_max_ms // "—"),
        ($l.vacias // 0),
        ($l.cortes_nuestros // 0),
        ($c.stop_reason // "—"),
        (if $c.truncado == true then "SÍ" elif $c.truncado == false then "no" else "?" end),
        ($c.techo_usado // "—"),
        (if ($g.reintento_json // null) == null then "—"
         elif $g.reintento_json.concedido != true then "omitido"
         elif $g.reintento_json.resuelto == true then "RESCATÓ:" + ($g.reintento_json.causa // "?")
         else "falló" end)
      ] | @tsv' "$f" \
    | awk -F'\t' '{printf "%-10s %s %-24s %-13s %5s %7s %9s %6s %8s %-11s %5s %7s %-9s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13}'
  done
done

# ── EL VEREDICTO POR AGENTE ──────────────────────────────────────────
# NO va en `jq`. Con el piso de SIN_AYUDA el criterio tiene tres dimensiones
# por corrida (entregó × rescatado × causa del rescate), y jq es un mal lugar
# para la lógica que decide si se abre una temporada de 22 sesiones. Vive en
# `scripts/arena-puerta.mjs`, que se prueba con corridas de juguete —una por
# caso— en `tests/arena-puerta.test.mjs`.
echo
echo "── VEREDICTO POR AGENTE ─────────────────────────────────────────"
AGENTES_CSV=$(echo "$AGENTES" | tr -s ' ' ',' | sed 's/^,//; s/,$//')
node "$(dirname "$0")/arena-puerta.mjs" "$OUT" "$AGENTES_CSV" "$RONDAS"
PUERTA=$?

# ── LAS CUATRO PUERTAS FÍSICAS, SOBRE LAS 21 CORRIDAS ────────────────
# Estas NO se promedian ni se votan: un solo desborde de reloj en una corrida
# de 21 es un desborde que puede repetirse cualquier día de la temporada.
echo
echo "── LAS PUERTAS FÍSICAS (sobre TODAS las corridas) ───────────────"
jq -s -r '
  [ .[] | (.agents[0] // {}) | {
      a: (.agent // "?"),
      reloj:  ((.loop // {}).reloj_pct // 0),
      lect:   ((.loop // {}).lectura_max_ms // 0),
      trunc:  ((.lectura_cierre // {}).truncado),
      nuestro:((.loop // {}).cortes_nuestros // 0)
    } ] as $r |
  "1 · reloj_pct < 90        : " + (if ([$r[]|select(.reloj>=90)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.reloj>=90)|.a+" ("+(.reloj|tostring)+"%)"]|join(", ")) end),
  "2 · lectura < 90000 ms    : " + (if ([$r[]|select(.lect>=90000)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.lect>=90000)|.a+" ("+(.lect|tostring)+"ms)"]|join(", ")) end),
  "3 · cero cortes nuestros  : " + (if ([$r[]|select(.nuestro>0)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.nuestro>0)|.a]|unique|join(", ")) end),
  "4 · cierre sin truncar    : " + (if ([$r[]|select(.trunc==true)]|length)==0 then (if ([$r[]|select(.trunc==null)]|length)==0 then "VERDE" else "VERDE con hueco → sin finish_reason en: " + ([$r[]|select(.trunc==null)|.a]|unique|join(", ")) end) else "ROJO → TRUNCADO en " + ([$r[]|select(.trunc==true)|.a]|unique|join(", ")) + " (eso es ARENA_MAX_TOKENS, no el modelo)" end)
' "$OUT"/*-r*.json

# ── CACHÉ: LA RONDA 2 Y LA 3 SON LA MEDICIÓN ─────────────────────────
# En la ronda 1 `cache_read` es 0 y eso es lo esperado (el prefijo se escribe).
# El ahorro aparece en las rondas siguientes, dentro del TTL — con una sola
# corrida por agente esto no se podía medir nunca.
echo
echo "── COSTO Y HERRAMIENTAS POR CORRIDA ─────────────────────────────"
for a in $AGENTES; do
  for r in $(seq 1 "$RONDAS"); do
    f="$OUT/$a-r$r.json"; [ -s "$f" ] || continue
    jq -r --arg a "$a" --arg r "$r" '(.agents[0] // {}) | [$a, $r, (.cost_usd // "null"), ((.loop // {}).herramientas // 0)] | @tsv' "$f"
  done
done | awk -F'\t' 'BEGIN{printf "%-10s %s %10s %6s\n","AGENTE","R","USD","HTAS"}
  {printf "%-10s %s %10s %6s\n",$1,$2,$3,$4; if($3!="null"){t+=$3; n+=1} else nulos+=1}
  END{printf "%-10s %s %10.4f %6s\n","TOTAL","·",t,n" corridas";
      if(nulos>0) printf "  (%d corrida(s) sin costo reportado: el total SUBESTIMA)\n", nulos}'

echo
echo "respuestas crudas en $OUT/ ($TOTAL archivos) — mandámelas si algo sale rojo o ámbar"

# El código de salida ES el veredicto: 0 los siete en verde · 1 ámbar o rojo ·
# 2 tanda incompleta · 3 producción no sirve este commit.
exit "${PUERTA:-0}"
