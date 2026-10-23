# Capturas de cierre de cada rebanada

La regla 10 del encargo pide que cada rebanada cierre con capturas a 390 px y
a 1440 px. `.capturas/` está en `.gitignore` —ahí escriben los scripts de
Chromium cada vez que corren, y no tiene sentido versionar diez PNG por
corrida—, así que las dos de CIERRE de cada rebanada se copian acá a mano y se
suben con el PR, para que se vean en la descripción sin tener que correr nada.

Se regeneran con:

    node scripts/mercado-chromium.mjs      # /mercado          → mercado-390.png, mercado-1440.png
    node scripts/noticias-chromium.mjs     # /mercado/noticias → noticias-390.png, noticias-1440.png

Una carpeta por rebanada. Si una captura de acá no coincide con lo que el
script produce hoy, la que manda es la del script: ésta es un registro de cómo
se veía al cerrar, no una prueba.
