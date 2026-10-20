// ═══════════════════════════════════════════════════════════════════════
// tests/fixtures/form4.mjs — Form 4 con la forma que manda la SEC.
//
// No es un XML mínimo: lleva los pedazos que el parser de R5 tiene que leer
// y los que tiene que ignorar sin romperse.
//
//   · CINCO transacciones con códigos distintos (P, S, A, F, M) — porque el
//     default de la pantalla es "todas", no sólo las compras;
//   · `postTransactionAmounts` con la tenencia posterior, que es la columna
//     "le quedan". Una de ellas en CERO: es el "vendió todo", la afirmación
//     más fuerte de la pantalla;
//   · una transacción SIN tenencia posterior: tiene que salir null con su
//     causa, no cero — cero diría que el insider se salió;
//   · una DERIVADA (opción), que vive en otra tabla del mismo documento;
//   · un otorgamiento SIN precio: no es dinero que entró ni salió, y con
//     precio 0 ensuciaría el neto sin que se note;
//   · dos dueños, uno de ellos dueño del 10%;
//   · el prefijo de namespace, que algunos filings traen.
// ═══════════════════════════════════════════════════════════════════════

export const FORM4_COMPLETO = `<?xml version="1.0"?>
<ownershipDocument>
  <aff10b5One>1</aff10b5One>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Acme Corp</issuerName>
    <issuerTradingSymbol>ACME</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001111111</rptOwnerCik><rptOwnerName>Ruiz Ana</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner>
      <officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0002222222</rptOwnerCik><rptOwnerName>Fondo Grande LP</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-10-15</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>50.25</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>12000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-10-16</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>12000</value></transactionShares>
        <transactionPricePerShare><value>52.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>0</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-10-14</value></transactionDate>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>4000</value></transactionShares>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>11000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership>
        <natureOfOwnership><value>By trust</value></natureOfOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-10-14</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>900</value></transactionShares>
        <transactionPricePerShare><value>49.10</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Employee Stock Option (right to buy)</value></securityTitle>
      <transactionDate><value>2026-10-13</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2500</value></transactionShares>
        <transactionPricePerShare><value>12.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>7500</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;

/** El mismo documento con prefijo de namespace, que varios filings traen. */
export const FORM4_CON_NAMESPACE = `<?xml version="1.0"?>
<ns1:ownershipDocument xmlns:ns1="http://www.sec.gov/edgar/ownership">
  <ns1:issuer><ns1:issuerCik>0000111</ns1:issuerCik><ns1:issuerName>Nspace Inc</ns1:issuerName>
    <ns1:issuerTradingSymbol>NSPC</ns1:issuerTradingSymbol></ns1:issuer>
  <ns1:reportingOwner><ns1:reportingOwnerId><ns1:rptOwnerCik>0003</ns1:rptOwnerCik>
    <ns1:rptOwnerName>Lee Kim</ns1:rptOwnerName></ns1:reportingOwnerId>
    <ns1:reportingOwnerRelationship><ns1:isDirector>1</ns1:isDirector>
    </ns1:reportingOwnerRelationship></ns1:reportingOwner>
  <ns1:nonDerivativeTable><ns1:nonDerivativeTransaction>
    <ns1:transactionDate><ns1:value>2026-10-10</ns1:value></ns1:transactionDate>
    <ns1:transactionCoding><ns1:transactionCode>P</ns1:transactionCode></ns1:transactionCoding>
    <ns1:transactionAmounts>
      <ns1:transactionShares><ns1:value>300</ns1:value></ns1:transactionShares>
      <ns1:transactionPricePerShare><ns1:value>10</ns1:value></ns1:transactionPricePerShare>
      <ns1:transactionAcquiredDisposedCode><ns1:value>A</ns1:value></ns1:transactionAcquiredDisposedCode>
    </ns1:transactionAmounts>
    <ns1:postTransactionAmounts>
      <ns1:sharesOwnedFollowingTransaction><ns1:value>300</ns1:value></ns1:sharesOwnedFollowingTransaction>
    </ns1:postTransactionAmounts>
  </ns1:nonDerivativeTransaction></ns1:nonDerivativeTable>
</ns1:ownershipDocument>`;
