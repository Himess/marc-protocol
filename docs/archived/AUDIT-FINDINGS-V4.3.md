# FHE x402 — Audit Findings V4.3

**Tarih:** 2026-03-11
**Scope:** Contracts, SDK, Frontend, Demo, Integrations, Config
**Toplam Bulgu:** 4 CRITICAL + 4 HIGH + 11 MEDIUM + 10 LOW + 6 ADDITION

---

## CRITICAL BULGULAR (Hemen Duzeltilmeli)

### C-1: Frontend App.tsx — recordPayment ABI 4 parametre (yanlis)
- **Dosya:** `frontend/src/App.tsx:28`
- **Sorun:** `recordPayment(address payer, address server, bytes32 nonce, uint64 minPrice)` — 4 param ABI. Gercek kontrat 3 param: `recordPayment(address server, bytes32 nonce, uint64 minPrice)` (msg.sender = payer).
- **Etki:** Frontend'den yapilan odeme cagrilari revert eder.
- **Fix:** ABI'yi 3 param yap, `onPay` fonksiyonundaki cagirindan `address` parametresini kaldir.

### C-2: Demo agent-buyer.ts — V3 poolAddress kullanıyor
- **Dosya:** `demo/agent-buyer.ts:14,45`
- **Sorun:** `POOL_ADDRESS` ve `fheFetch({ poolAddress: ... })` — V3 API. V4.0'da `tokenAddress` + `verifierAddress` kullanilmali.
- **Etki:** fheFetch uyumsuz parametrelerle cagrilir, hata verir.
- **Fix:** `poolAddress` → `tokenAddress` + `verifierAddress` degistir.

### C-3: Demo agent-seller.ts — V3 poolAddress kullanıyor
- **Dosya:** `demo/agent-seller.ts:11,41`
- **Sorun:** `fhePaywall({ poolAddress: ... })` — V3 API. V4.0 `tokenAddress` + `verifierAddress` bekliyor.
- **Etki:** Paywall middleware baslatılamaz.
- **Fix:** `poolAddress` → `tokenAddress` + `verifierAddress` degistir.

### C-4: Eliza Plugin — V3 Pool API (deposit/finalizeWithdraw/cancelWithdraw)
- **Dosya:** `examples/eliza-plugin/fhe-plugin.ts`
- **Sorun:** `POOL_ABI` import, `pool.deposit()`, `pool.finalizeWithdraw()`, `pool.cancelWithdraw()`, `pool.isInitialized()` — V3 havuz API'si. V4.0'da pool yok, token-centric mimari.
- **Etki:** Plugin tamamen calismaz.
- **Fix:** Token-centric V4.0 API'ye yeniden yaz (wrap/unwrap/confidentialTransfer).

---

## YUKSEK ONCELIKLI BULGULAR

### H-1: Frontend fhevmInstance init — window.ethereum yerine RPC URL
- **Dosya:** `frontend/src/App.tsx:114`
- **Sorun:** `network: (window as any).ethereum || SEPOLIA_RPC` — relayer-sdk `network` parametresi RPC URL string bekliyor, Ethereum provider object degil.
- **Fix:** `network: SEPOLIA_RPC` yap.

### H-2: SDK fhePaymentHandler — Encryption timeout yok
- **Dosya:** `sdk/src/fhePaymentHandler.ts:120`
- **Sorun:** `await input.encrypt()` — timeout yok. WASM islemci takilirsa sonsuza kadar bekler.
- **Fix:** `Promise.race` ile 30s timeout ekle.

### H-3: SDK facilitator — CORS headers eksik
- **Dosya:** `sdk/src/facilitator.ts`
- **Sorun:** Cross-origin istekler icin CORS header yok. Browser-based client'lar baglanamiyor.
- **Fix:** CORS middleware ekle.

### H-4: SDK peerDependencies — fhevmjs yerine @zama-fhe/relayer-sdk
- **Dosya:** `sdk/package.json:26-31`
- **Sorun:** `peerDependencies: { "fhevmjs": ">=0.6.0" }` — fhevmjs deprecated. @zama-fhe/relayer-sdk kullaniliyor.
- **Fix:** peerDependencies'i guncelle.

---

## MEDIUM ONCELIKLI BULGULAR

### M-1: ConfidentialUSDC.sol — accumulatedFees rate() carpimi
- **Dosya:** `contracts/ConfidentialUSDC.sol:103,153`
- **Sorun:** `accumulatedFees += uint256(fee) * rate()` — rate() ERC7984ERC20Wrapper'dan gelir, USDC icin 1 donmesi beklenir. Ama rate() degisirse fee hesabi bozulur.
- **Risk:** Dusuk (rate USDC icin her zaman 1, ama defensive programming icin assert eklenmeli).
- **Fix:** Constructor'da `require(rate() == 1)` assertion ekle.

### M-2: X402PaymentVerifier — minPrice > 0 dogrulama yok
- **Dosya:** `contracts/X402PaymentVerifier.sol:76`
- **Sorun:** `recordPayment()` minPrice=0 kabul eder. Bedava odeme kaydi olusturulabilir.
- **Fix:** `require(minPrice > 0)` ekle.

### M-3: OpenClaw unwrap.ts — parseFloat kullanıyor (parseAmount yerine)
- **Dosya:** `packages/openclaw-skill/scripts/unwrap.ts:10-14`
- **Sorun:** `parseFloat(amountStr)` + `Math.round()` — floating point hatasi olasılığı. `_wallet.ts`'te `parseAmount()` helper var.
- **Fix:** `parseAmount()` fonksiyonunu kullan.

### M-4: Frontend App.tsx — parseFloat ile amount hesabi
- **Dosya:** `frontend/src/App.tsx:158,177,206`
- **Sorun:** `BigInt(Math.round(parseFloat(amount) * 1_000_000))` — floating point hatasi.
- **Fix:** `parseUnits(amount, 6)` veya manual string parsing kullan.

### M-5: Facilitator — Rate limiting yok
- **Dosya:** `sdk/src/facilitator.ts`
- **Sorun:** /verify endpoint'inde rate limiting yok. DDoS riski.
- **Fix:** Rate limiter ekle.

### M-6: LRU rate limiter — Insertion-order eviction (access-order degil)
- **Dosya:** `sdk/src/fhePaywallMiddleware.ts:38-45`
- **Sorun:** Map.keys() insertion order ile iterate eder. En eski giris silinir ama bu en az kullanilan olmayabilir.
- **Risk:** Dusuk — islevsel ama optimal degil.
- **Fix:** Kabul edilebilir — documented as known limitation.

### M-7: ACP hook gas limit — 100K hardcoded, belgelenmemis
- **Dosya:** `contracts/AgenticCommerceProtocol.sol`
- **Sorun:** Hook çağrısı sabit gas limiti ile yapılıyor ama belgede yok.
- **Fix:** IACP interface'ine NatSpec dokümantasyonu ekle.

### M-8: SDK index.ts — POOL_ABI export (V3 artifact)
- **Dosya:** `sdk/src/index.ts`
- **Sorun:** Eger `POOL_ABI` hala export ediliyorsa, V3 artifact'i.
- **Fix:** Kontrol et, varsa kaldir veya deprecated isaretle.

### M-9: Facilitator verifier event ABI — minPrice eksik
- **Dosya:** `sdk/src/facilitator.ts:26-27`
- **Sorun:** `PaymentVerified(address indexed payer, address indexed server, bytes32 indexed nonce)` — minPrice parametresi eksik. V4.1'de eklendi.
- **Fix:** ABI'yi guncelle.

### M-10: Root package.json version — 0.3.0 (V4.3 olmali)
- **Dosya:** `package.json:4`
- **Sorun:** Versiyon 0.3.0 ama proje V4.3'te.
- **Fix:** 4.3.0 yap.

### M-11: SDK package.json version — 0.1.0 (V4.3 olmali)
- **Dosya:** `sdk/package.json:3`
- **Sorun:** Versiyon 0.1.0.
- **Fix:** 4.3.0 yap.

---

## DUSUK ONCELIKLI BULGULAR

### L-1: IConfidentialUSDC — InvalidUnwrapRequest error eksik
- **Dosya:** `contracts/interfaces/IConfidentialUSDC.sol`
- **Sorun:** `InvalidUnwrapRequest(euint64)` error'u kontrat kodunda var ama interface'te yok.
- **Fix:** Interface'e ekle.

### L-2: IACP — IACPHook gas limit dokümantasyonu eksik
- **Dosya:** `contracts/interfaces/IACP.sol:4-6`
- **Sorun:** `afterAction()` fonksiyonunun gas limiti belgelenmemis.
- **Fix:** NatSpec ekle.

### L-3: Frontend V4.0 subtitle
- **Dosya:** `frontend/src/App.tsx:230`
- **Sorun:** "(V4.0 Token-Centric)" yaziyor, V4.3 olmali.
- **Fix:** V4.3 yap.

### L-4: Facilitator version string
- **Dosya:** `sdk/src/facilitator.ts:84`
- **Sorun:** `version: "4.0.0"` — 4.3.0 olmali.
- **Fix:** Guncelle.

### L-5: agent-buyer.ts — console.log "Pool" yaziyor
- **Dosya:** `demo/agent-buyer.ts:29`
- **Sorun:** `[Buyer] Pool: ${POOL_ADDRESS}` — V4.0'da pool yok.
- **Fix:** "Token" ve "Verifier" olarak degistir.

### L-6: agent-seller.ts — console.log "Pool" yaziyor
- **Dosya:** `demo/agent-seller.ts:22`
- **Sorun:** `[Seller] Pool: ${POOL_ADDRESS}` — V4.0'da pool yok.
- **Fix:** "Token" ve "Verifier" olarak degistir.

### L-7: Frontend callback ebool — kullanilmiyor
- **Dosya:** `contracts/ConfidentialUSDC.sol:192-194`
- **Sorun:** `returns (ebool accepted)` — accepted degeri kullanilmiyor, sadece store ediliyor.
- **Risk:** Dusuk — ERC-7984 spec uyumlulugu icin doğru davranış, ama document edilmeli.
- **Fix:** Yorum ekle.

### L-8: Eliza plugin — POOL_ABI import hala var
- **Dosya:** `examples/eliza-plugin/fhe-plugin.ts:8`
- **Sorun:** SDK'dan `POOL_ABI` import ediyor ama V4.0'da pool yok.
- **Fix:** C-4 ile birlikte duzeltilecek.

### L-9: OpenClaw tests mock address uyumsuzlugu
- **Dosya:** Kontrol gerekli
- **Risk:** Dusuk

### L-10: Hardhat config audit warning
- **Dosya:** `hardhat.config.ts`
- **Sorun:** `npm audit` bypass eslint gibi uyarilar olabilir.
- **Risk:** Dusuk

---

## EKLEMELER (Yeni Ozellikler)

### A-1: Encryption timeout — 30s Promise.race
SDK'da `input.encrypt()` icin 30 saniye timeout.

### A-2: Facilitator CORS + rate limiting
Cross-origin destek ve rate limiter.

### A-3: Emergency withdraw fonksiyonu
Owner'in acil durumda underlying USDC'yi cekebilmesi. (NOT: Bu tartismali — mevcut `treasuryWithdraw` + `pause` yeterli olabilir. Skip.)

### A-4: Redis NonceStore ornegi
SDK'da Redis-based nonce store ornegi veya dokümantasyonu.

### A-5: Nonce pruning dokümantasyonu
On-chain `usedNonces` mapping'in bounded olmadigi belgelenmeli.

### A-6: Version alignment
Tum package.json'lar 4.3.0'a guncellenmeli.

---

## KNOWN LIMITATIONS

### KL-1: Single-TX Payment Flow Incompatible with FHE Input Proof Binding
- **Sorun:** `payAndRecord()` ve `confidentialTransferAndCall()` single-TX akislari fhEVM input proof binding nedeniyle calismaz.
- **Sebep:** FHE input proof'lari `msg.sender`'a baglidir. Agent proof olusturur (`msg.sender = agent`), ama verifier kontrat `confidentialTransferFrom()` cagirdiginda `msg.sender = verifier` olur. FHE VM proof'u reddeder.
- **Cozum:** 2-TX akisi dogru yaklasimdir:
  - TX1: Agent → `confidentialTransfer()` (msg.sender = agent = proof signer) ✓
  - TX2: Agent → `recordPayment()` (no FHE involved) ✓
- **Durum:** BY DESIGN — fhEVM mimarisinin bir sonucu. Tek cozum Zama'nin proof binding'i gevsetmesi.

### KL-2: FHE Silent Failure Pattern
- **Sorun:** `confidentialTransfer()` yetersiz bakiyede 0 transfer eder ama revert etmez.
- **Sebep:** `FHE.select(success, amount, 0)` — encrypted boolean; deger cozulene kadar sonuc bilinmez.
- **Cozum:** SDK'da heuristic silent failure guard eklendi:
  - Pre-transfer: Sender'in zero-handle kontrolu
  - Post-transfer: Balance handle degisim kontrolu
  - Kesin cozum yok — FHE mimarisinin dogal sonucu
- **Durum:** MITIGATED — heuristic guard eklendi, kesin cozum mumkun degil.

### KL-3: Unwrap/FinalizeUnwrap Async KMS Dependency
- **Sorun:** `unwrap()` step 1'i calisir ama `finalizeUnwrap()` Zama KMS callback gerektirir.
- **Sebep:** FHE decryption proof'u KMS tarafindan uretilir. Kullanici beklemeli.
- **Durum:** KNOWN — Zama altyapisina bagli. Sepolia'da test icin KMS online olmali.

---

## KAPSAM DISI (Kullanici tarafindan bekletilen)

- LangChain/CrewAI entegrasyonu
- L2 deployment (Base/Arbitrum)
- Multisig treasury
- UUPS proxy pattern

---

## DURUM TABLOSU

| # | Seviye | Bulgu | Durum |
|---|--------|-------|-------|
| C-1 | CRITICAL | Frontend ABI 4→3 param | FIXED |
| C-2 | CRITICAL | agent-buyer V3 pool | FIXED |
| C-3 | CRITICAL | agent-seller V3 pool | FIXED |
| C-4 | CRITICAL | eliza-plugin V3 API | FIXED |
| H-1 | HIGH | Frontend fhevm init | FIXED |
| H-2 | HIGH | Encryption timeout | FIXED |
| H-3 | HIGH | Facilitator CORS | FIXED |
| H-4 | HIGH | SDK peerDeps | FIXED |
| M-1 | MEDIUM | rate() assertion | FIXED |
| M-2 | MEDIUM | minPrice > 0 | FIXED |
| M-3 | MEDIUM | unwrap parseAmount | FIXED |
| M-4 | MEDIUM | Frontend parseFloat | FIXED |
| M-5 | MEDIUM | Facilitator rate limit | FIXED |
| M-6 | MEDIUM | LRU eviction order | DOCUMENTED |
| M-7 | MEDIUM | ACP hook gas docs | FIXED |
| M-8 | MEDIUM | POOL_ABI export check | N/A (not exported) |
| M-9 | MEDIUM | Facilitator verifier ABI | FIXED |
| M-10 | MEDIUM | Root version 0.3.0→4.3.0 | FIXED |
| M-11 | MEDIUM | SDK version 0.1.0→4.3.0 | FIXED |
| L-1 | LOW | Interface error (inherited) | DOCUMENTED |
| L-2 | LOW | IACP gas docs | FIXED |
| L-3 | LOW | Frontend V4.3 subtitle | FIXED |
| L-4 | LOW | Facilitator version | FIXED |
| L-5 | LOW | buyer log "Pool" | FIXED |
| L-6 | LOW | seller log "Pool" | FIXED |
| L-7 | LOW | ebool accepted comment | FIXED |
| L-8 | LOW | POOL_ABI import | FIXED |

---

## TEST SONUCLARI (Post-Fix)

| Suite | Test Sayisi | Durum |
|-------|------------|-------|
| Contracts (Hardhat) | 175 | ALL PASSING |
| SDK (Vitest) | 148 | ALL PASSING |
| Virtuals Plugin | 37 | ALL PASSING |
| OpenClaw Skill | 31 | ALL PASSING |
| **TOPLAM** | **391** | **ALL PASSING** |
