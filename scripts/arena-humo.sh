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
  por agente, sobre sus 3 corridas:   3/3 → VERDE · 2/3 → ÁMBAR · ≤1/3 → ROJO
  "entrega libro" = status NO empieza con `aborted` (rejected_rails CUENTA)
  abre sólo con los SIETE en VERDE y las cuatro puertas físicas en verde

  REINTENTO SOLO-JSON: es un riel y lo tienen los siete igual, así que un libro
  rescatado CUENTA como entregado. Pero se reporta al lado (columna REINT y
  SIN_AYUDA en el veredicto): "necesitó reintento" es un hallazgo del agente y
  no se esconde. Un ÁMBAR con 3/3 entregados pero 1 rescatado se lee distinto
  de un 3/3 limpio, y el criterio NO cambia por eso — lo decide Lety mirando.
CRIT
echo

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
echo
echo "── VEREDICTO POR AGENTE (3/3 VERDE · 2/3 ÁMBAR · ≤1/3 ROJO) ─────"
VEREDICTOS="$OUT/veredictos.tsv"
: > "$VEREDICTOS"
for a in $AGENTES; do
  jq -s -r --arg a "$a" --argjson n "$RONDAS" '
    [ .[] | (.agents[0] // {}) | {
        entrego: (((.status // "sin_status") | startswith("aborted") | not) and (.status != null)),
        rescatado: (((.reintento_json // {}).resuelto // false) == true),
        status: (.status // "sin_status"),
        error: ((.error // "") | .[0:120])
      } ] as $c |
    ([$c[] | select(.entrego)] | length) as $ok |
    ([$c[] | select(.entrego and (.rescatado | not))] | length) as $limpios |
    (if $ok == $n then "VERDE" elif $ok == ($n - 1) then "ÁMBAR" else "ROJO" end) as $v |
    [ $a, ($ok|tostring) + "/" + ($n|tostring), $v,
      ($limpios|tostring) + "/" + ($n|tostring),
      ([$c[] | select(.entrego | not) | .status] | unique | join(",") | if . == "" then "—" else . end),
      ([$c[] | select(.entrego | not) | .error] | first // "—")
    ] | @tsv' "$OUT/$a"-r*.json >> "$VEREDICTOS"
done
awk -F'\t' 'BEGIN{printf "%-10s %6s %-7s %9s %-26s %s\n","AGENTE","LIBROS","PUERTA","SIN_AYUDA","ABORTÓ POR","PRIMER ERROR"}
  {printf "%-10s %6s %-7s %9s %-26s %s\n",$1,$2,$3,$4,$5,$6}' "$VEREDICTOS"

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

# ── LA PUERTA ────────────────────────────────────────────────────────
echo
# ── PRIMERO: ¿SE EVALUÓ A TODOS? (2026-10-02) ────────────────────────
# La primera prueba de este script contra respuestas de juguete falló el jq de
# los veredictos (jq no acepta tildes en una clave desnuda), el archivo quedó
# VACÍO — y el script imprimió "los siete en VERDE". Cero filas evaluadas se
# leía como cero rojos.
#
# Es el patrón que Lety ya cazó dos veces: un chequeo que confirma la propiedad
# débil ("no hay ROJO") y se lee como si confirmara la fuerte ("todos VERDE").
# Acá se cuenta ANTES de opinar.
ESPERADOS=$(echo "$AGENTES" | wc -w)
EVALUADOS=$(grep -c . "$VEREDICTOS" 2>/dev/null || echo 0)
ROJOS=$(awk -F'\t' '$3=="ROJO"{print $1}' "$VEREDICTOS" | paste -sd, -)
AMBARES=$(awk -F'\t' '$3=="ÁMBAR"{print $1}' "$VEREDICTOS" | paste -sd, -)
if [ "$EVALUADOS" -ne "$ESPERADOS" ]; then
  echo "PUERTA DE APERTURA: NO SE PUEDE DECIR — se evaluaron $EVALUADOS de $ESPERADOS agentes."
  echo "  Un agente sin veredicto NO es un agente en verde. Mirá los errores de jq de arriba y las respuestas en $OUT/."
  exit 2
elif [ -n "$ROJOS" ]; then
  echo "PUERTA DE APERTURA: CERRADA — ROJO en: $ROJOS"
elif [ -n "$AMBARES" ]; then
  echo "PUERTA DE APERTURA: ÁMBAR en: $AMBARES — no abre sola. Mirá el 'PRIMER ERROR' de esa fila y la corrida cruda antes de decidir."
else
  echo "PUERTA DE APERTURA: los siete en VERDE. Revisá igual las cuatro puertas físicas de arriba."
fi

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
done | awk -F'\t' 'BEGIN{printf "%-10s %s %10s %6s\n","AGENTE","R","USD","HTAS"}{printf "%-10s %s %10s %6s\n",$1,$2,$3,$4}'

echo
echo "respuestas crudas en $OUT/ ($TOTAL archivos) — mandámelas si algo sale rojo o ámbar"
