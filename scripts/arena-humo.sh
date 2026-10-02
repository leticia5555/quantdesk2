#!/usr/bin/env bash
# ── CORRIDA DE HUMO DE LA T3 ─────────────────────────────────────────
# Secuencial a propósito (B43: siete en paralelo comparten el minuto malo).
# El halt se queda puesto: /api/arena-shadow fuerza `vivo: false` y su broker
# LANZA en toda escritura, así que no puede mandar una orden.
set -u
BASE="${BASE:-https://quantdesk2.vercel.app}"
: "${ARENA_ADMIN_KEY:?falta ARENA_ADMIN_KEY (set -a && . ./.env.local && set +a)}"
OUT="humo-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

printf '%-10s %-22s %6s %5s %7s %9s %8s %6s %7s\n' \
  AGENTE ESTADO CORTO VLTAS RELOJ% LECT_MAX TECHO VACÍAS NUESTROS
printf '%.0s─' {1..92}; echo

for a in claude control openai grok gemini deepseek qwen; do
  curl -s -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-shadow?agent=$a" > "$OUT/$a.json"
  jq -r --arg a "$a" '
    (.context.tools.vueltas_medidas // []) as $v |
    [ $a,
      (.status // "sin_status"),
      (.context.tools.stopped_by // "—"),
      (.context.tools.turns // 0),
      (.context.tools.limites.reloj_ms.pct // 0),
      ([$v[].ms // 0] | max // 0),
      ([$v[].techo_ms // 0] | max // 0),
      ([$v[] | select(.vacio)] | length),
      ([$v[] | select(.reloj_nuestro)] | length)
    ] | @tsv' "$OUT/$a.json" \
  | awk -F'\t' '{printf "%-10s %-22s %6s %5s %7s %9s %8s %6s %7s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}'
done

echo
echo "── LAS TRES PUERTAS ─────────────────────────────────────────────"
jq -s -r '
  [ .[] | {
      a: .agent,
      aborto: ((.status // "") | startswith("aborted")),
      reloj:  (.context.tools.limites.reloj_ms.pct // 0),
      lect:   ([(.context.tools.vueltas_medidas // [])[].ms // 0] | max // 0)
    } ] as $r |
  "1 · sin abortar          : " + (if ([$r[]|select(.aborto)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.aborto)|.a]|join(", ")) end),
  "2 · reloj_pct < 90       : " + (if ([$r[]|select(.reloj>=90)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.reloj>=90)|.a+" ("+(.reloj|tostring)+"%)"]|join(", ")) end),
  "3 · lectura < 90000 ms   : " + (if ([$r[]|select(.lect>=90000)]|length)==0 then "VERDE" else "ROJO → " + ([$r[]|select(.lect>=90000)|.a+" ("+(.lect|tostring)+"ms)"]|join(", ")) end)
' "$OUT"/*.json

echo
echo "── CACHÉ (la medición de caché ES el humo) ──────────────────────"
jq -s -r '.[] | [.agent, (.context.cost.usd // "null"), (.context.tools.used // 0)] | @tsv' "$OUT"/*.json \
  | awk -F'\t' 'BEGIN{printf "%-10s %10s %6s\n","AGENTE","USD","HTAS"}{printf "%-10s %10s %6s\n",$1,$2,$3}'
echo
echo "respuestas crudas en ./$OUT/ — mandámelas si algo sale rojo"
