// ═══════════════════════════════════════════════════════════════
// Respuestas REALES de FMP con HTTP 402, copiadas TAL CUAL de producción.
//
// No se reformatean, no se "limpian", no se completan: el valor de un fixture
// real es que es lo que FMP dijo, con sus rarezas. Dos que importan:
//
//   · Las comillas están DESBALANCEADAS: `'Special Parameters : The values for
//     'limit' must be…` abre una comilla antes de "Special" que nunca cierra.
//     Un parser que busque pares de comillas se tropieza ahí.
//   · SYMBOL viene CORTADO en "https://financialmo": es el recorte del
//     `body_sample` del censo. Se deja cortado porque así es como el código lo
//     va a ver en producción.
//
// Hasta acá los tests usaban reconstrucciones del formato de FMP. Estas tres
// reemplazan a las reconstrucciones donde la respuesta es real; las
// reconstrucciones que quedan (casos sin etiqueta, el endpoint entero no
// disponible) están marcadas como SINTÉTICAS en cada test.
// ═══════════════════════════════════════════════════════════════

// Del smoke de NKE con `limit=1000` (/stable/grades-historical).
export const FMP_402_LIMIT = "Premium Query Parameter: 'Special Parameters : The values for 'limit' must be between 0 and 10 based on your current subscription. Please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";

// Del censo de grades, primer fallo: ABNB (/stable/grades-historical).
// CORTADO por el body_sample — así lo ve el código.
export const FMP_402_SYMBOL = "Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription please visit our subscription page to upgrade your plan at https://financialmo";

// De una corrida a mano con `period=quarter` (/stable/analyst-estimates).
export const FMP_402_PERIOD = "Premium Query Parameter: 'Special Endpoint : This value set for 'period' is not available under your current subscription please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";

export const PROCEDENCIA = {
  FMP_402_LIMIT: 'smoke de NKE con limit=1000 — grades-historical',
  FMP_402_SYMBOL: 'censo de grades, primer fallo ABNB — grades-historical (cortado por body_sample)',
  FMP_402_PERIOD: 'corrida a mano con period=quarter — analyst-estimates',
};
