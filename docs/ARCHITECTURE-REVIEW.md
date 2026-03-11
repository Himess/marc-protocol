# FHE x402 — Derin Mimari Analiz

**Tarih:** 2026-03-11
**Versiyon:** V4.3 Post-Audit
**Scope:** Mimari kararlar, mainnet readiness, entegrasyon durumu, test gerçekliği

---

## 1. TASARIM KARARLARI: DOĞRU MU?

### Token-Centric vs Pool-Based → ✅ DOĞRU KARAR

Pool-based'den V4.0'da token-centric'e geçiş haklıydı:
- Pool = tek merkezî risk noktası, tüm fonlar tek kontratta
- Token-centric = agentlar cUSDC'yi kendi cüzdanında tutuyor, custody riski yok
- `wrap/unwrap` standart ERC-7984 operasyonları

**Tek tradeoff:** Agent'lar single-TX için `setOperator()` çağırmalı. Bu kabul edilebilir.

### Fee Modeli: %0.1 wrap/unwrap, transfer ücretsiz → ⚠️ TARTIŞILIR

| Miktar | Wrap Fee | Transfer | Unwrap Fee | Round-trip | Efektif Oran |
|--------|----------|----------|------------|-----------|-------------|
| $0.10 | $0.01 | $0 | $0.01 | $0.02 | %20 |
| $1 | $0.01 | $0 | $0.01 | $0.02 | %2 |
| $10 | $0.01 | $0 | $0.01 | $0.02 | %0.2 |
| $100 | $0.10 | $0 | $0.10 | $0.20 | %0.2 |

**Sorun:** Gelir sadece wrap/unwrap hacmine bağlı. Agent $100K wrap edip 1000 transfer yapsa, sadece $200 fee kazanırsın.

**Öneri:** V5.0'da transferlerde %0.05 (5 bps) opsiyonel fee düşünülebilir.

### ERC-7984 Compliance → %75 Uyumlu

- Interface ve inheritance doğru
- Ama parent'ın `_unwrapRequests` mapping'i **private** → override edemiyorsun → kendi `_unwrapRecipients` mapping'ini yazdın
- **Alternatif:** ERC7984ERC20Wrapper'ı fork'la, `_unwrapRequests`'i `protected` yap

### ACP (AgenticCommerceProtocol) Entegrasyonu → ⚠️ GEVŞEK

- ACP düz USDC kabul ediyor (cUSDC değil)
- Hook sistemi var ama **FHE hook implementasyonu yok**
- **Eksik:** `FheEscrowHook` referans implementasyonu

---

## 2. MAİNNET'E GEÇEBİLİR Mİ?

### Gas Maliyetleri — L1'de İMKANSIZ

| İşlem | Gas | $ Maliyet (30 gwei, $1800 ETH) |
|-------|-----|--------------------------------|
| wrap() | 200K | $1.08 |
| confidentialTransfer() | 400K | $2.16 |
| payAndRecord() | 450K | $2.43 |
| **Round-trip** | **~1M** | **~$5.40** |

- $0.01 API çağrısı için $2.43 gas → ROI: -24,200%
- Batch 100 request prepay = $0.024/request → $0.10+ API'ler için geçerli
- L2 gas 100x ucuz → $0.02/TX → geçerli

**Sonuç:** L1 mainnet yapılamaz. Zama L2 coprocessor veya Base/Arbitrum gerekli.

### Silent Failure Pattern

FHE'de `confidentialTransfer()` her zaman başarılı döner — bakiye yetersizse 0 transfer eder.
- Sepolia'da kabul edilebilir
- Mainnet'te: ERC-8004 reputation + minBalanceCheck + rate limiting gerekli

### Trust Assumptions

| Varsayım | Risk | Mainnet için |
|----------|------|-------------|
| Zama KMS online | KMS kapalıysa unwrap durur | Emergency timelock gerekli |
| Owner dürüst | Fee'leri çalabilir | Multisig + timelock |
| Server nonce doğrular | Sahte ödeme | Redis NonceStore şart |
| Agent dürüst | minPrice'ı düşük yazar | ERC-8004 reputation |

---

## 3. SDK ANALİZİ

### Çalışanlar ✅
- FhePaymentHandler — tam, production-ready
- fheFetch (auto-402) — tam, tek sunucu için
- Error hierarchy — iyi tasarlanmış

### Yarım Kalanlar ⚠️
- fhePaywall: In-memory nonce → sunucu restart = replay attack
- fheBatchPaywall: In-memory credit store → cluster'da çalışmaz
- Facilitator: Half-baked, middleware zaten verify ediyor

### Stub/Eksikler 🔴
- ERC-8004 SDK: %90 stub — sadece data encoding, kontrat çağrısı yok
- ERC-8183 SDK: Partial — sadece helper, createJob/fund/submit/complete yok
- Facilitator: Ya tam yap ya sil

---

## 4. ENTEGRASYON DURUMU

### Virtuals Plugin: KOD VAR, ENTEGRASYON YOK
- 5 GameFunction doğru interface'le yazılmış
- Virtuals platformuna kayıtlı değil
- cUSDC balance decryption yok (sadece public USDC)
- Unwrap Step 2 (finalizeUnwrap) eksik
- Testler %100 mock

### OpenClaw Skill: CLİ SCRIPTLER VAR, PLATFORM ENTEGRASYONU YOK
- 5 standalone script (wrap, pay, unwrap, balance, info)
- skill.json yok
- Unwrap Step 2 eksik
- Testler %100 mock

---

## 5. TEST GERÇEKLİĞİ

### FHE'yi Test Etmiyor
- Hardhat fhevm mock = plaintext passthrough
- `euint64` = düz `uint64` gibi davranıyor
- `FHE.checkSignatures()` = format kontrolü, gerçek STARK proof yok

| Test | Ne Test Ediyor | Gerçek mi? |
|------|---------------|-----------|
| wrap() fee hesabı | USDC transfer + fee math | ✅ Gerçek |
| recordPayment nonce | Nonce registry | ✅ Gerçek |
| ACP job lifecycle | Escrow state machine | ✅ Gerçek |
| confidentialTransfer() | Mock FHE transfer | ❌ Sahte |
| unwrap finalizeUnwrap() | Mock KMS proof | ❌ Sahte |

---

## 6. AKSİYON PLANI

1. Unwrap Step 2 — Plugin/skill'de finalizeUnwrap() çağrısı
2. Redis NonceStore — SDK'ya built-in Redis adapter
3. Virtuals/OpenClaw kayıt — skill.json, platform registration
4. cUSDC balance decryption — KMS ile encrypted bakiye
5. 1-TX'i default yap — 2-TX orphaned transfer riski
6. L2 deployment planı
7. .env key rotation
8. ERC-8004 reputation loop
9. FheEscrowHook referans implementasyonu
10. Zama Sepolia'da gerçek FHE testi

---

## 7. GENEL PUAN

| Alan | Puan |
|------|------|
| Mimari tasarım | 9/10 |
| Kontrat güvenliği | 9/10 |
| SDK kalitesi | 7/10 |
| Test gerçekliği | 5/10 |
| Entegrasyonlar | 3/10 |
| Mainnet readiness | 4/10 |

**Mimari temel sağlam — üstüne inşa edilebilir.**

---

## 8. POST-REVIEW FIX RAPORU (2026-03-11)

### Yapılan Düzeltmeler

| # | Sorun | Düzeltme | Durum |
|---|-------|----------|-------|
| 1 | recordPayment 4-arg bug (plugin+skill) | 3-arg'a düzeltildi (msg.sender=payer) | ✅ |
| 2 | OpenClaw skill.json eksik | skill.json oluşturuldu (6 command) | ✅ |
| 3 | Unwrap Step 2 eksik | finalizeUnwrap fonksiyonu eklendi (plugin+skill) | ✅ |
| 4 | cUSDC balance gösterilmiyor | confidentialBalanceOf eklendi (plugin+skill) | ✅ |
| 5 | ERC-8183 SDK stub | 9 gerçek contract fonksiyonu eklendi | ✅ |
| 6 | ERC-8004 SDK stub | 7 gerçek contract fonksiyonu eklendi | ✅ |
| 7 | Test ABI yanlış | Tüm mock ABI'ler düzeltildi | ✅ |
| 8 | Verifier Sepolia outdated | V4.3 redeployed: 0xCc60280A10FEB7fBdf20fBefc2abe6E0e99A5A83 | ✅ |
| 9 | Sepolia on-chain test yok | 19 on-chain test yazıldı, hepsi geçiyor | ✅ |

### Güncel Test Sayıları

| Suite | Önceki | Şimdi | Değişim |
|-------|--------|-------|---------|
| Contracts (Hardhat) | 175 | 175 | 0 |
| SDK (Vitest) | 125 | 148 | +23 |
| Virtuals Plugin | 30 | 37 | +7 |
| OpenClaw Skill | 25 | 31 | +6 |
| Sepolia On-Chain | 0 | 19 | +19 |
| **TOPLAM** | **355** | **410** | **+55** |

### Sepolia On-Chain Verified Gas Costs

```
┌─────────────────────────┬──────────────┐
│ Operation               │ Gas Used     │
├─────────────────────────┼──────────────┤
│ USDC approve            │        45921 │
│ cUSDC wrap              │       314980 │
│ recordPayment           │        46964 │
│ recordBatchPayment      │        47411 │
│ setOperator             │        46649 │
└─────────────────────────┴──────────────┘
```

### Güncel Puan

| Alan | Önceki | Şimdi |
|------|--------|-------|
| Mimari tasarım | 9/10 | 9/10 |
| Kontrat güvenliği | 9/10 | 9/10 |
| SDK kalitesi | 7/10 | 9/10 |
| Test gerçekliği | 5/10 | 8/10 |
| Entegrasyonlar | 3/10 | 7/10 |
| Mainnet readiness | 4/10 | 6/10 |
