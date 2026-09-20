# e2e — suite de regresión de app.html (Chromium)

Harness de la auditoría de wrappers (#42-#45), ahora regresión permanente:
34 checks que cubren el mapa de wrappers, el autocomplete (#45), la
biblioteca de edges (#43), agentes (#44), paywall (#42), el restore de tabs
y la integridad del flag `illiquid` — con todas las APIs stubbeadas
(sin red, sin claves).

```bash
node e2e/server.mjs &   # sirve el repo en :8931
node e2e/run.mjs        # corre los 34 checks (usa el Chromium de Playwright)
```

Requiere `playwright` (local o global). Los `net::ERR_FAILED` de la consola
son recursos externos bloqueados a propósito por el harness (fonts/CDN);
cualquier PAGEERROR o error propio de la app sí cuenta como rojo.

## historia.mjs — la página de HISTORIA

31 checks sobre `historia.html` con `/api/historia` stubbeada. No prueban el
endpoint (eso es `tests/historia-lectura.test.mjs`): prueban lo que el usuario
VE, que es donde las reglas del módulo se rompen de verdad — un hueco sin
etiqueta, un YoY nulo dibujado como 0%, una cita que no enlaza, una cifra con
escala corta que se lee por mil.

```bash
node e2e/server.mjs &   # sirve el repo en :8931
node e2e/historia.mjs
```
