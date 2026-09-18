// ═══════════════════════════════════════════════════════════════
// /api/arena-universe — reconstruye el UNIVERSO del día (B1), pre-apertura.
//
// ~600 nombres (S&P 500 + Nasdaq 100 + hasta 100 del día) × precio, volumen y
// market cap NO cabe dentro de una corrida del PM. Vive acá, en su propio cron,
// ANTES de la apertura, y la corrida solo LEE el resultado — el mismo patrón
// que el canal screener (`arena-screener` precomputa, `arena-run` lee).
//
//   GET (cron)                   → reconstruye y guarda el universo de hoy
//   GET ?dry=1                   → lo construye y lo devuelve SIN guardar
//   GET ?refresh=1               → fuerza el refresco de constituyentes contra
//                                  FMP, salteando la ventana semanal
//   GET ?emit=1                  → además IMPRIME los constituyentes (solo para
//                                  mirarlos). NO hace falta guardarlos a mano:
//                                  la lista se persiste sola en Neon en cuanto
//                                  se baja de FMP — ver abajo.
//   GET ?peek=1                  → NO construye nada: muestra qué universo hay
//                                  guardado y de cuándo es (gratis)
//
// GATES: CRON_SECRET (el cron) **o** ARENA_ADMIN_KEY (a mano). Los dos sirven y
// se prueban los dos: el cron no tiene la llave de admin y la persona que lo
// dispara a mano no debería tener que buscar la del cron.
//
// NO GASTA UN TOKEN: acá no hay ninguna llamada a un LLM. Es datos de mercado y
// una lista de constituyentes.
//
// ── LA LISTA SE GUARDA SOLA. NADIE COMMITEA NADA ─────────────────────
// Cuando los constituyentes se bajan de FMP, `resolveConstituents` los escribe
// en Neon (`arena_universe`, clave `constituents:<índice>`) en el mismo paso.
// Eso los hace sobrevivir al deploy, a una caída de FMP y al reinicio de la
// lambda, y es lo que convierte al cron de las 13:00 UTC en autosuficiente: la
// primera corrida encuentra Neon vacío, baja la lista y la guarda; las
// siguientes la leen de ahí y solo vuelven a FMP cuando cumple una semana
// (`refreshDue`, por EDAD y no por calendario, así que un cron que no corrió el
// lunes refresca el martes en vez de esperar al lunes siguiente).
//
// El JSON de `data/universe/` es SOLO el arranque en frío (Neon vacío Y FMP
// caído el mismo día). Está vacío a propósito y no hace falta llenarlo: sin él
// el universo sigue teniendo dos fuentes por delante. `persisted` en la
// respuesta dice, por índice, si la lista quedó guardada.
//
// ENV VARS: FMP_API_KEY (opc) · FINNHUB_API_KEY (market cap de la admisión) ·
//           ALPACA_PAPER_KEY/SECRET · DATABASE_URL · CRON_SECRET ·
//           ARENA_ADMIN_KEY · ARENA_UNIVERSE_REFRESH_DAYS · ARENA_UNIVERSE_MOVERS_MAX
// ═══════════════════════════════════════════════════════════════

import { ensureSchema } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import { alpacaCreds } from './_lib/alpaca.js';
import { buildUniverse, saveUniverse, loadUniverse, resolveConstituents, REFRESH_DAYS, MOVERS_MAX } from './_lib/arena-universe.js';
import { sectorFromGics } from './_lib/arena-meta.js';
import { beat } from './_lib/heartbeat.js';
import { buildInfo } from './_lib/build-info.js';

// ~600 nombres × admisión (Finnhub profile2 + Yahoo, en lotes) es lo más lento
// del Arena. Mismo techo que el resto (plan Pro); vercel.json tiene que decir
// lo mismo o este número no existe.
export const maxDuration = 300;

// Las DOS llaves. El cron manda `Authorization: Bearer $CRON_SECRET`; la
// persona manda `x-admin-key`. Cualquiera de las dos abre.
function autorizado(req) {
  const cron = process.env.CRON_SECRET;
  if (cron) {
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
    if (h === 'Bearer ' + cron) return { ok: true, via: 'cron' };
  }
  const admin = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (admin.ok) return { ok: true, via: 'admin' };
  // Sin CRON_SECRET configurado, el endpoint queda solo detrás de la llave de
  // admin — y si ésa tampoco está, gana el 503 de checkAdminAuth, que explica
  // exactamente qué falta.
  return { ok: false, status: admin.status, body: admin.body };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const auth = autorizado(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const dry = String(q.dry || '') === '1';
  const force = String(q.refresh || '') === '1';
  // Re-baja los CSV de tenencias ignorando la ventana de refresco. Aparte de
  // `?refresh=1` porque reconstruir el universo del día y re-bajar las listas de
  // constituyentes son dos costos distintos con dos cadencias distintas.
  const forceConstituents = String(q.force_constituents || '') === '1';
  const emit = String(q.emit || '') === '1';
  const peek = String(q.peek || '') === '1';
  const now = new Date();

  try {
    await ensureSchema();

    // ── ?diag=DELL,COP — QUÉ SABE EL UNIVERSO DE ESTOS NOMBRES ─────────
    // Gratis, cero construcción, cero llamadas a Alpaca: lee lo GUARDADO.
    //
    // Existe porque tres bugs distintos (`sector(XLE)` en 0, `with_sector` en 0,
    // el screener en 0) tienen la misma pregunta debajo y no había forma de
    // contestarla sin entrar a Neon a mano: ¿el dato está en el universo del
    // día, o no está?
    //
    // La respuesta distingue las TRES cosas que se confunden: el nombre no está
    // en el universo · el nombre está pero sin ese campo · el campo está y el
    // consumidor no lo lee. Sin separarlas, cualquier arreglo es a ciegas.
    const diag = String(q.diag || '').trim();
    if (diag) {
      const u = await loadUniverse({ now });
      if (!u) return res.status(200).json({ diag: true, universe: null, hint: 'No hay universo guardado. Corré el endpoint sin ?diag= para construir uno.' });
      const pedidos = diag.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 40);
      const enUniverso = new Set(u.symbols || []);
      const deIndice = new Set(u.from_index || []);
      // ── POR QUÉ NO ESTÁ: LAS TRES RESPUESTAS SON DISTINTAS ────────
      // `en_universo: false` contesta "¿está?" y no "¿por qué no?", y ésas son
      // preguntas distintas con arreglos distintos:
      //   · lo RECHAZÓ la admisión (precio, volumen, market cap) → el nombre
      //     existe y no califica hoy; puede volver mañana solo.
      //   · NUNCA FUE CANDIDATO → no está en los constituyentes de hoy ni
      //     entre los movers. Si es un nombre grande, eso apunta a la lista de
      //     índices, no al filtro.
      //   · está y le falta un campo → el bug está en el consumidor.
      // Sin separarlas, "OKTA no está" manda a revisar el filtro de volumen
      // cuando el problema puede ser que la lista del índice no lo trae.
      const rechazoDe = new Map(
        (((u.admission || {}).rejected) || []).map((r) => [String(r.symbol || '').toUpperCase(), r]),
      );
      const sectores = u.sectores || {};
      const retornos = u.retornos || {};
      const caps = u.market_caps || {};
      const w52 = u.fifty_two_week || {};
      return res.status(200).json({
        diag: true,
        build: buildInfo(),
        universo: {
          built_at: u.built_at, loaded_from: u.loaded_from, is_today: u.is_today,
          universe_source: u.universe_source,
          symbols: (u.symbols || []).length,
          from_index: (u.from_index || []).length,
          from_day: (u.from_day || []).length,
          // LOS CUATRO CONTADORES QUE DECIDEN TODO. Si `sectores` es 0, no hay
          // nada que arreglar en los rieles ni en la herramienta `sector`: el
          // dato no llegó a guardarse, y el bug está una capa antes.
          sectores: Object.keys(sectores).length,
          retornos: Object.keys(retornos).length,
          market_caps: Object.keys(caps).length,
          fifty_two_week: Object.keys(w52).length,
          note: u.note || null,
        },
        // De dónde salieron los constituyentes, y si ESA foto trae sectores. Un
        // snapshot guardado por una versión anterior al soporte de la columna
        // `Sector` se relee tal cual —el refresco es semanal— y deja el universo
        // sin sectores sin que nada falle a la vista.
        indices: u.indices || null,
        nombres: pedidos.map((sym) => ({
          symbol: sym,
          en_universo: enUniverso.has(sym),
          origen: !enUniverso.has(sym) ? null : (deIndice.has(sym) ? 'indice' : 'canal_del_dia'),
          sector_gics: sectores[sym] ?? null,
          sector_etf: sectorFromGics(sectores[sym]) || null,
          ret_5d: (retornos[sym] || {}).ret_5d ?? null,
          ret_1m: (retornos[sym] || {}).ret_1m ?? null,
          market_cap: caps[sym] ?? null,
          fifty_two_week: w52[sym] || null,
          // El veredicto de admisión, cuando lo hubo: trae el motivo EXACTO
          // ("volumen $8.7M/día < $10M", "market cap no disponible"), que es
          // lo que se necesita para saber si el nombre volverá solo o si hay
          // algo que arreglar.
          rechazo_admision: rechazoDe.get(sym) || null,
          por_que: enUniverso.has(sym)
            ? 'admitido'
            : rechazoDe.get(sym)
              ? 'rechazado_por_admision'
              : 'nunca_fue_candidato',
          lectura: !enUniverso.has(sym)
            ? (rechazoDe.get(sym)
              ? `NO está porque la ADMISIÓN lo rechazó: ${rechazoDe.get(sym).reason}. El nombre existe y hoy no califica; si el motivo es precio o volumen, puede volver solo mañana sin que nadie toque nada.`
              : 'NO está y NI SIQUIERA FUE CANDIDATO: no aparece en los constituyentes de índice de hoy ni entre los movers del día. Si es un nombre grande, el problema NO es el filtro de admisión — mirá `indices` (¿se bajó la lista?, ¿de cuándo es?) y si salió del índice de verdad. OJO: la lista de rechazados se journalea acotada a 50, así que en un día con muchos rechazos un nombre rechazado puede caer acá; el conteo real está en `admission.rejected_count`.')
            : sectores[sym] == null
              ? 'Está en el universo pero SIN sector. Si `origen` es `canal_del_dia`, es esperado: los sectores vienen del CSV del índice y un mover de fuera del S&P no los trae. Si `origen` es `indice`, el CSV no trajo la columna Sector o el snapshot guardado es de antes de que se leyera.'
              : 'Tiene sector en el universo. Si igual llega como UNKNOWN a los rieles o la herramienta `sector` lo ignora, el bug está en el consumidor, no en el dato.',
        })),
      });
    }

    // ?peek=1 — gratis: qué hay guardado, sin construir nada.
    if (peek) {
      const u = await loadUniverse({ now });
      return res.status(200).json({
        peek: true,
        universe: u ? {
          built_at: u.built_at, loaded_from: u.loaded_from, is_today: u.is_today,
          universe_source: u.universe_source, counts: u.counts, indices: u.indices, note: u.note || null,
        } : null,
        hint: u ? null : 'No hay universo guardado todavía. Corré este endpoint sin ?peek=1 para construir el primero.',
      });
    }

    const universe = await buildUniverse({ creds: alpacaCreds(), now, force, forceConstituents });

    let saved = false;
    if (!dry) saved = await saveUniverse(universe, now);

    const out = {
      ran_at: now.toISOString(),
      // Qué build contestó. Si pediste `?diag=` y esto no trae la sección de
      // diagnóstico, comparar este commit contra el que esperabas dice si el
      // deploy salió — sin tener que preguntar.
      build: buildInfo(),
      mode: dry ? 'dry_run' : 'saved',
      // Qué se forzó en esta corrida, para que la respuesta diga por qué tardó
      // (o por qué NO se refrescó lo que se esperaba).
      forzado: { universo: force, constituyentes: forceConstituents },
      saved,
      universe_source: universe.universe_source,
      built_at: universe.built_at,
      market_day: universe.market_day,
      counts: universe.counts,
      indices: universe.indices,
      // ¿La key llegó a ESTE entorno? Solo el booleano, nunca el valor.
      fmp_key_present: universe.fmp_key_present,
      // Cada intento contra cada fuente de constituyentes (tenencias del ETF
      // primero, FMP solo si hay key), con su status y los primeros bytes del
      // cuerpo. Sin esto, "sin constituyentes" era la única salida para seis
      // causas distintas y ninguna llegaba a `errors`.
      constituents_diagnostics: universe.constituents_diagnostics,
      admission: { ...universe.admission, rejected: universe.admission.rejected.slice(0, 20) },
      errors: universe.errors,
      caveat: universe.caveat,
      // La lista entera no se imprime por default: son ~600 símbolos que nadie
      // lee en una terminal y que tapan el diagnóstico, que es lo que sí se lee.
      sample: universe.symbols.slice(0, 20),
      refresh_days: REFRESH_DAYS,
      movers_max: MOVERS_MAX,
    };

    // ?emit=1 — los constituyentes, para MIRARLOS. La persistencia no depende de
    // esto: ya quedaron en Neon cuando se bajaron. El formato coincide con el de
    // data/universe/*.json por si algún día se quiere congelar un arranque en
    // frío, pero eso es opcional y nadie tiene que hacerlo para que B1 funcione.
    if (emit) {
      const [sp, nq] = await Promise.all([
        resolveConstituents('sp500', { now, force: false }),
        resolveConstituents('nasdaq100', { now, force: false }),
      ]);
      const snap = (r, index) => ({
        index, source: r.source, built_at: r.built_at, symbols: r.symbols,
        note: 'Snapshot generado por /api/arena-universe?emit=1. Respaldo de arranque en frío; la fuente viva es FMP con refresco semanal.',
      });
      out.constituents = { sp500: snap(sp, 'sp500'), nasdaq100: snap(nq, 'nasdaq100') };
      out.emit_hint = 'Esto es para MIRAR. No hay que guardarlo: la lista ya quedó en Neon (ver indices[].persisted) y el cron de las 13:00 UTC la refresca solo cada 7 días.';
    }

    // Si una lista vino FRESCA de FMP pero no se pudo escribir, la próxima
    // corrida la vuelve a pedir: no se rompe nada, pero se está pagando cuota de
    // más y conviene que se vea.
    const sinPersistir = Object.entries(universe.indices || {})
      .filter(([, v]) => v && v.refreshed && v.persisted === false).map(([k]) => k);
    if (sinPersistir.length) {
      out.persistence_warning = `No se pudo guardar en Neon: ${sinPersistir.join(', ')}. La lista de hoy sirve igual, pero mañana se va a volver a pedir a FMP en vez de leerse de la base.`;
    }

    // ── LA PISTA, SOLO CUANDO HAY ALGO QUE ARREGLAR ───────────────────
    // Un índice OPCIONAL que no contestó NO genera pista: es una decisión
    // tomada, no un problema. Si generara, la pista estaría encendida todos los
    // días y dejaría de leerse — que es como se pierden las pistas que sí
    // importan.
    const idx = universe.indices || {};
    const obligatoriosCaidos = Object.entries(idx)
      .filter(([k, v]) => v && typeof v === 'object' && k !== 'solo_en' && !v.opcional && v.source === 'none')
      .map(([k]) => k);

    if (obligatoriosCaidos.length) {
      out.constituents_hint = `No se pudieron bajar los constituyentes de: ${obligatoriosCaidos.join(', ')}. Mirá \`constituents_diagnostics\` — \`html_no_csv\` significa que la URL se movió (se corrige SIN deploy con ARENA_HOLDINGS_URL_<INDICE>); \`sin_encabezado\` significa que cambiaron los nombres de columna y ahí hacen falta las \`primeras_lineas\` para ajustarlo.`;
    }
    const opcionalesAusentes = Object.entries(idx)
      .filter(([k, v]) => v && typeof v === 'object' && k !== 'solo_en' && v.opcional && v.source === 'none')
      .map(([k]) => k);
    if (opcionalesAusentes.length) {
      out.opcionales_ausentes = opcionalesAusentes;
      out.opcionales_note = `${opcionalesAusentes.join(', ')}: índice OPCIONAL sin fuente. NO es un error — el universo sale con los obligatorios. \`indices.solo_en\` (OJO: DENTRO de \`indices\`, no en la raíz) dice cuántos nombres únicos aportaría si se activara.`;
    }

    // ── ¿CORRIÓ EL PASO DE LAS TABLAS PÚBLICAS? AL NIVEL DE ARRIBA ────
    // Esto existe por un ida y vuelta concreto del 2026-09-18: el Nasdaq 100
    // volvía `source: "none"` y no había forma de distinguir "el código nuevo
    // no está en este deploy" de "corrió y falló", porque la respuesta lo decía
    // en `constituents_diagnostics` —que es largo, va al final, y se filtra sin
    // querer con cualquier jq— y el `note` no lo mencionaba.
    //
    // La regla que sale de eso: un diagnóstico que hay que SABER BUSCAR no es
    // un diagnóstico. Va arriba, en una frase, y dice las tres cosas que se
    // pueden querer saber: si corrió, qué contestó cada fuente, y qué se hizo.
    const nq = idx.nasdaq100;
    if (nq) {
      const filasTabla = (universe.constituents_diagnostics || [])
        .filter((d) => d && d.fuente === 'tabla_publica' && d.index === 'nasdaq100');
      out.nasdaq100_paso = filasTabla.length
        ? {
          corrio: true,
          publicados: nq.count || 0,
          resumen: nq.tabla_publica || (nq.count ? `Publicó ${nq.count} nombres.` : null),
          intentos: filasTabla,
        }
        : {
          corrio: false,
          publicados: 0,
          resumen: 'El paso de tablas públicas (Wikipedia + slickcharts) NO dejó una sola fila de diagnóstico, y siempre deja al menos dos. O este deploy no trae el código, o `resolveConstituents` devolvió antes de llegar ahí (lista guardada vigente en Neon, o el índice resuelto por otra fuente). Comparar `build.commit` con el commit esperado separa los dos casos.',
          intentos: [],
        };
    }

    out.verdict = universe.counts.admitidos === 0
      ? 'VACÍO: ningún nombre pasó. Revisá `errors` y `indices[].source` — el tablero va a caer a movers_only o a nada.'
      : `${universe.counts.admitidos} nombres (${universe.counts.indices} de índices + ${universe.counts.del_dia_nuevos} del día), fuente ${universe.universe_source}.` +
        (universe.admission.rejected_count ? ` ${universe.admission.rejected_count} rechazados por admisión (${universe.admission.data_unavailable} por falta de datos).` : '');

    await beat('arena:universe', universe.counts.admitidos ? 'ok' : 'empty', {
      source: universe.universe_source, admitidos: universe.counts.admitidos,
    });
    return res.status(200).json(out);
  } catch (err) {
    await beat('arena:universe', 'error', { error: String((err && err.message) || err) });
    return res.status(500).json({ error: 'arena-universe: ' + ((err && err.message) || 'unknown') });
  }
}
