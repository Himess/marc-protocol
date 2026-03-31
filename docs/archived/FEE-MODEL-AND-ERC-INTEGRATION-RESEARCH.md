# FHE x402 — Fee Model & ERC Entegrasyon Araştırma Raporu

**Tarih:** 2026-03-10
**Scope:** Fee model analizi, ERC standartları entegrasyonu, rekabet analizi, mimari öneriler
**Amaç:** Zama Developer Program submission (Deadline: 15 Mart 2026) için mimari kararları belirlemek

---

## İçindekiler

1. [Fee Model Analizi](#1-fee-model-analizi)
   - 1.1 Zaiffer Fee Modeli
   - 1.2 CAMM Fee Modeli
   - 1.3 Bizim Seçeneklerimiz (4 Model)
   - 1.4 Gelir Projeksiyonları
   - 1.5 Öneri
2. [ERC Standartları Entegrasyonu](#2-erc-standartları-entegrasyonu)
   - 2.1 ERC-8004 (Trustless Agents)
   - 2.2 ERC-8183 (Agentic Commerce)
   - 2.3 ERC-8126 (Agent Registration & Verification)
   - 2.4 Tüm Standartların Birlikte Çalışması
3. [Rekabet Analizi](#3-rekabet-analizi)
4. [Öneri & Roadmap](#4-öneri--roadmap)

---

## 1. Fee Model Analizi

### 1.1 Zaiffer Fee Modeli

**Zaiffer** = Zama + PyratzLabs ortak girişimi (EUR 2M funding, Kasım 2025). İlk production ERC-7984 confidential token platformu.

#### Fee Yapısı

| Operasyon | Fee Tipi | Açıklama |
|-----------|----------|----------|
| **Wrap** (shielding) | Basis points | ERC-20 → cToken dönüşümünde |
| **Unwrap** (unshielding) | Basis points | cToken → ERC-20 dönüşümünde |
| **Deploy** | Flat fee | Yeni wrapper + cToken pair oluşturmada |
| **Batch Transfer** | Flat fee | Çoklu confidential transfer tek TX'de |
| **Regular Transfer** | **Ücretsiz** | Kullanıcılar arası confidential transfer |

#### Encrypted Fee Hesaplama (Anahtar İnovasyon)

Zaiffer, fee'yi **encrypted domain**'de hesaplıyor. Miktar `euint64` olarak şifrelenmiş durumda:

```solidity
// Zaiffer FeeManager pattern (audit'ten):
encryptedFee = FHE.mul(amount, FHE.asEuint64(unwrapFeeBasisPoints));
encryptedFee = FHE.div(encryptedFee, FHE.asEuint64(10000));
```

Fee kendisi de **confidential token** olarak fee recipient'a `confidentialTransfer` ile gönderiliyor — kimse fee miktarını görmüyor.

#### Zaiffer'dan Öğrenilecekler

| Öğrenim | Detay |
|---------|-------|
| ✅ Fee sadece giriş/çıkışta | Transfer ücretsiz — kullanıcı deneyimini bozmaz |
| ✅ Encrypted fee hesaplama | `FHE.mul` + `FHE.div` ile tamamen encrypted domain'de |
| ⚠️ Overflow riski | `euint64` max ~1.8×10¹⁹, büyük miktarlarda `FHE.mul` overflow yapabilir |
| ⚠️ Gas maliyeti | FHE ops ~15x daha pahalı (OpenZeppelin audit önerisi: plaintext fee toplayın) |
| 📝 2-step unwrap | FHE decryption async → `finalizeUnwrap` callback gerekli |
| 📝 Closed source | Kontrat kodu özel (`pyratzlabs/software/usdx`) |

---

### 1.2 CAMM Fee Modeli

**CAMM** = Confidential AMM (6ygb tarafından). Zama Eylül 2025 builder program kazananı.

#### Fee Yapısı

- **%1 swap fee** — LP'lere gidiyor
- **Protokol fee yok** — %100 LP'lere
- Fee, swap hesaplamasına **gömülü** (ayrı bir deduction yok)

#### "RNG Ratio Trick" — Fee'nin Encrypted Hesaplanması

CAMM, fhEVM 0.7'de `euint / euint` bölmenin desteklenmemesi sorununu şöyle çözüyor:

```solidity
// 1. Random obfuscation multiplier üret (3-16387 arası)
euint16 rng = computeRNG(16384, 3);

// 2. Fee-reduced versiyon: rng * 99/100
euint32 rngUpper = FHE.div(FHE.mul(FHE.asEuint32(rng), uint32(99)), uint32(100));

// 3. Numerator → fee-reduced rng kullanır
euint128 numerator = FHE.mul(FHE.mul(sent, reserve), rngUpper);

// 4. Denominator → tam rng kullanır
euint128 denominator = FHE.mul(reserve, rng);

// Sonuç: numerator/denominator = standard_output * 0.99 (= %1 fee)
```

**Neden böyle?** RNG çarpanı iki amaca hizmet ediyor:
1. Reserve büyüklüklerini gizliyor (denominator decrypt edilse bile `reserve * rng` anlamsız)
2. Fee'yi hesaplıyor (`rng * 99/100` vs `rng` oranı = %1 fee)

#### Diğer Confidential AMM'ler

| Proje | Fee | Pattern | GitHub |
|-------|-----|---------|--------|
| **CAMM** | %1 | `rng * 99/100` numerator'da | 6ygb/CAMM |
| **TradeCore** | %0.3 | `FHE.mul(amountIn, 997) / FHE.mul(reserveIn, 1000)` (Uniswap V2) | ob04z9ejhn/TradeCore |
| **LiquidSwap** | %1 | CAMM ile aynı pattern | y6qom3fjycxn8/LiquidSwap |

#### CAMM'dan Öğrenilecekler

| Öğrenim | Detay |
|---------|-------|
| ✅ Fee hesaplama formüle gömülü | Ayrı deduction adımı yok → daha az gas |
| ✅ LP incentive | Fee LP'lere gidiyor → likidite çeker |
| ❌ Bizim için uygulanabilir değil | AMM-spesifik pattern, x402 payment flow'una uymuyor |
| 📝 Inspiration | Encrypted fee hesaplama tekniği referans olarak kullanılabilir |

---

### 1.3 Bizim Seçeneklerimiz — 4 Fee Model

#### Model A: Token-Level Fee (Her `confidentialTransfer`'de)

```solidity
function confidentialTransfer(address to, einput amount, bytes calldata inputProof) external {
    euint64 _amount = FHE.asEuint64(amount, inputProof);
    euint64 fee = FHE.max(
        FHE.div(FHE.mul(_amount, FHE.asEuint64(FEE_BPS)), FHE.asEuint64(10000)),
        FHE.asEuint64(MIN_FEE)
    );
    euint64 netAmount = FHE.sub(_amount, fee);
    // transfer netAmount to recipient, fee to treasury
}
```

| Pro | Con |
|-----|-----|
| Her transferden gelir | ERC-7984 normunu bozar (standart: transfer ücretsiz) |
| En yüksek gelir potansiyeli | Kullanıcı deneyimi kötü — her API call'da fee |
| Zaiffer bile yapmıyor | Agent'lar alternatif (fee-free) token'a geçer |
| — | Gas maliyeti artar (her transfer'de FHE.mul + FHE.div) |

**Verdict: ❌ ÖNERİLMİYOR** — Ekosistem normu transfer'in ücretsiz olması. Zaiffer ve CAMM bile bunu yapmıyor.

#### Model B: Verifier-Level Fee (Her `recordPayment` / `payAndRecord`'da)

```solidity
function recordPayment(
    address payer, address server, bytes32 nonce, uint64 minPrice
) external {
    // Mevcut nonce replay kontrolü...
    // + Fee: minPrice'ın %0.1'i treasury'ye
    uint64 fee = max(minPrice * 10 / 10_000, 10_000); // %0.1, min 0.01 USDC
    // cUSDC.confidentialTransfer(treasury, encryptedFee)
}
```

| Pro | Con |
|-----|-----|
| Her API ödmesinden gelir | Agent `recordPayment` yerine sadece `confidentialTransfer` kullanabilir (bypass) |
| x402 flow ile doğal uyum | Verifier opsiyonel — agent/server anlaşıp skip edebilir |
| Basit implementasyon | `minPrice` plaintext — fee miktarı public (privacy leak) |
| İyi UX (tek TX) | Verifier'a cUSDC erişimi vermek = trust gerektirir |

**Verdict: ⚠️ KISMEN UYGULANABİLİR** — Bypass riski var ama x402 flow'da doğal. Optional premium olarak kullanılabilir.

#### Model C: Escrow-Level Fee (ERC-8183 Job Completion'da)

```solidity
// ERC-8183 ACP entegrasyonu ile:
function complete(uint256 jobId, bytes32 reason) external {
    // ... evaluator kontrolü ...
    uint256 fee = job.budget * PLATFORM_FEE_BPS / 10000;
    token.transfer(treasury, fee);
    token.transfer(job.provider, job.budget - fee);
}
```

| Pro | Con |
|-----|-----|
| Yüksek değerli işlerden gelir | Sadece job-based workflow'da çalışır (x402 micropayment değil) |
| Bypass edilemez (escrow lock) | cUSDC ile escrow = karmaşık (async decrypt) |
| Endüstri standardı (Virtuals, marketplace'ler) | İmplementasyon ağır (yeni kontrat + evaluator mantığı) |
| ERC-8183 ile uyumlu | Henüz Draft — değişebilir |

**Verdict: ✅ GELECEK İÇİN GÜÇLÜ** — Ama şu anki x402 micropayment flow'una ek olarak, ayrı bir gelir katmanı.

#### Model D: Facilitator-Level Fee (Off-chain Verification Service)

```typescript
// facilitator.ts — verification endpoint
app.post("/verify", async (req, res) => {
    const { payload, requirement } = req.body;
    const isValid = await verifyPayment(payload, requirement);
    // Fee: server'dan aylık abonelik veya per-verification fee
    return res.json({ valid: isValid });
});
```

| Pro | Con |
|-----|-----|
| Off-chain = düşük maliyet | On-chain enforcement yok — ödemeyen server kendi verify eder |
| SaaS gelir modeli (recurring revenue) | Facilitator opsiyonel — self-host edilebilir |
| Kolay implementasyon | Crypto-native olmayan gelir modeli |
| Compliance/analytics ek hizmet olarak satılabilir | Ölçeklenmesi zor (infra maliyeti) |

**Verdict: ⚠️ EK GELİR** — Ana gelir kaynağı olarak zayıf, ama premium hizmet katmanı olarak mantıklı.

---

### 1.4 Gelir Projeksiyonları

#### Senaryo Bazlı Karşılaştırma (Aylık)

| Model | $10K Hacim | $100K Hacim | $1M Hacim | $10M Hacim |
|-------|-----------|------------|----------|----------|
| **A: Token Fee (%0.1)** | $10 | $100 | $1,000 | $10,000 |
| **B: Verifier Fee (%0.1)** | $10 | $100 | $1,000 | $10,000 |
| **C: Escrow Fee (%1)** | $100 | $1,000 | $10,000 | $100,000 |
| **D: Facilitator (SaaS)** | $50/mo flat | $200/mo | $500/mo | $2,000/mo |
| **Mevcut: Wrap/Unwrap (%0.1)** | $20 | $200 | $2,000 | $20,000 |

#### Hibrit Model Projeksiyonu

| Katman | Fee | Açıklama | $1M Hacimde Gelir |
|--------|-----|----------|-------------------|
| Wrap/Unwrap | %0.1 (10 bps) | Giriş/çıkış fee (mevcut) | $2,000 |
| Escrow (ERC-8183) | %1 (100 bps) | Job completion fee | $10,000 |
| Facilitator | $200-2,000/mo | Premium verification SaaS | $500 |
| **Toplam** | — | — | **$12,500** |

**Karşılaştırma:** Sadece wrap/unwrap ile $2,000 vs hibrit ile $12,500 = **6.25x artış**.

---

### 1.5 Fee Model Önerisi

#### Önerilen Hibrit Model: "Wrap + Escrow + Facilitator"

```
┌─────────────────────────────────────────────────────┐
│                   FHE x402 Fee Stack                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: TOKEN FEES (mevcut)                       │
│  ├── Wrap:   %0.1 (10 bps), min 0.01 USDC         │
│  ├── Unwrap: %0.1 (10 bps), min 0.01 USDC         │
│  └── Transfer: Ücretsiz (ERC-7984 norm)            │
│                                                     │
│  Layer 2: ESCROW FEES (yeni — ERC-8183)            │
│  ├── Job completion: %1 (100 bps)                  │
│  ├── cUSDC escrow via ACP hook                     │
│  └── Evaluator: smart contract veya DAO            │
│                                                     │
│  Layer 3: FACILITATOR FEES (yeni — SaaS)           │
│  ├── Free tier: 1,000 verification/ay              │
│  ├── Pro tier: $200/ay (unlimited + analytics)     │
│  └── Enterprise: Custom pricing                    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

#### Neden Bu Model?

1. **Transfer ücretsiz kalır** — ERC-7984 normu, Zaiffer ile uyumlu, agent dostu
2. **Wrap/unwrap fee korunur** — Mevcut, çalışıyor, bypass edilemez
3. **Escrow fee en yüksek gelir** — Büyük job'lardan %1, bypass edilemez (escrow lock)
4. **Facilitator SaaS** — Recurring revenue, compliance katma değer

#### Transfer Fee (%0.01-0.02) Tartışması

| Argüman | Yönü |
|---------|------|
| Hacimin büyük kısmı transfer'de | ✅ Ekle |
| Zaiffer transfer'i ücretsiz bırakıyor | ❌ Ekleme |
| ERC-7984 normu: transfer ücretsiz | ❌ Ekleme |
| Agent'lar alternatif token'a geçer | ❌ Ekleme |
| 1-2 bps fark edilmez | ✅ Ekle |
| Rekabetçi dezavantaj | ❌ Ekleme |

**Karar: Transfer fee EKLEME.** Zaiffer bile yapmıyor. ERC-7984 ekosisteminde norm ihlali olur. Escrow fee ile daha yüksek gelir elde edilebilir.

---

## 2. ERC Standartları Entegrasyonu

### 2.1 ERC-8004: Trustless Agents — Kimlik & Reputation

#### Genel Bakış

| Alan | Detay |
|------|-------|
| **Tam İsim** | ERC-8004: Trustless Agents |
| **Yazarlar** | Marco De Rossi, Davide Crapis, Jordan Ellis, Erik Reppel |
| **Durum** | Draft (13 Ağustos 2025) |
| **Requires** | EIP-155, EIP-712, EIP-721, EIP-1271 |
| **Katkıda bulunanlar** | Consensys, TensorBlock, Nethermind, Google, EF, Olas, Eigen Labs |

#### 3 Registry Mimarisi

```
┌──────────────────────────────────────────────────────────┐
│                     ERC-8004 Stack                       │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Identity Registry (ERC-721 NFT)                         │
│  ├── Her agent = 1 NFT                                   │
│  ├── agentURI → JSON (name, services, x402Support)       │
│  ├── agentWallet → ödeme adresi                          │
│  ├── Key-value metadata (on-chain)                       │
│  └── Transfer'de agentWallet otomatik sıfırlanır         │
│                                                          │
│  Reputation Registry                                     │
│  ├── int128 value + uint8 decimals (negatif destekli)    │
│  ├── tag1, tag2 (kategorizasyon)                         │
│  ├── endpoint (hangi servis kullanıldı)                  │
│  ├── feedbackURI + hash (off-chain detay)                │
│  ├── proofOfPayment (txHash, from, to, chainId)          │
│  ├── Herkes feedback verebilir (izin gereksiz)           │
│  ├── Geri alınabilir (submitter tarafından)              │
│  └── getSummary() → count + sum (aggregation)            │
│                                                          │
│  Validation Registry                                     │
│  ├── Agent → Validator kontratına request                │
│  ├── Validator → 0-100 response score                    │
│  ├── Validator tipleri: stake, zkML, TEE                 │
│  ├── Self-validation engelli                             │
│  └── getSummary() → count + average                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

#### Key Interfaces

```solidity
interface IIdentityRegistry is IERC721, IERC721Metadata {
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external returns (uint256 agentId);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline,
        bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address wallet);
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);
}

interface IReputationRegistry {
    function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals,
        string calldata tag1, string calldata tag2, string calldata endpoint,
        string calldata feedbackURI, bytes32 feedbackHash) external;
    function getSummary(uint256 agentId, address[] calldata clients,
        string calldata tag1, string calldata tag2)
        external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
}

interface IValidationRegistry {
    function validationRequest(address validator, uint256 agentId,
        string calldata requestURI, bytes32 requestHash) external;
    function validationResponse(bytes32 requestHash, uint8 response,
        string calldata responseURI, bytes32 responseHash, string calldata tag) external;
    function getSummary(uint256 agentId, address[] calldata validators,
        string calldata tag) external view returns (uint64 count, uint8 averageResponse);
}
```

#### Sepolia Deployed Adresleri (Reference Implementation)

| Kontrat | Adres |
|---------|-------|
| Identity Registry | `0xf66e7CBdAE1Cb710fee7732E4e1f173624e137A7` |
| Reputation Registry | `0x6E2a285294B5c74CB76d76AB77C1ef15c2A9E407` |
| Validation Registry | `0xC26171A3c4e1d958cEA196A5e84B7418C58DCA2C` |

Reference impl: `ChaosChain/trustless-agents-erc-ri` (74 test, 8.5/10 güvenlik)

#### FHE x402 Entegrasyonu

```
Agent Kayıt Flow:
1. Agent → IdentityRegistry.register(agentURI) → agentId (NFT)
   agentURI.json: { x402Support: true, services: [{name: "web", endpoint: "..."}] }

2. Agent → setAgentWallet(agentId, walletAddress) → x402 payment adresi

x402 Ödeme + Reputation Flow:
3. Client → Agent API (HTTP 402 → x402 payment → cUSDC transfer)
4. Client → ReputationRegistry.giveFeedback(agentId, score, "x402", "api-quality")
   feedbackURI: { proofOfPayment: { txHash, chainId } }

5. Yeni client → getSummary(agentId) → "Bu agent güvenilir mi?"
   → Score yüksek → premium pricing
   → Score düşük → reject veya discount
```

#### Encrypted Reputation (FHE + ERC-8004)

**Yaklaşım:** Reputation value'ları `euint128` olarak sakla (ERC-7984 ile compose)

```solidity
// Hypothetical: FHE-enhanced Reputation Registry
mapping(uint256 => mapping(address => euint128)) private encryptedScores;

function giveEncryptedFeedback(uint256 agentId, einput value, bytes calldata proof) external {
    euint128 _value = FHE.asEuint128(value, proof);
    encryptedScores[agentId][msg.sender] = _value;
}

// Threshold check WITHOUT revealing score:
function meetsThreshold(uint256 agentId, uint128 minScore) external view returns (ebool) {
    return FHE.ge(aggregateScore[agentId], FHE.asEuint128(minScore));
}
```

**Avantaj:** Agent rakipleri exact reputation score'unu göremez — sadece "threshold üstünde mi?" sorusuna encrypted cevap.

**Dezavantaj:** Gas maliyeti yüksek, Sybil resistance zorlaşır (public olmayan score'lar daha az denetlenebilir).

**Öneri:** Hibrit — reputation value public, ama ödeme miktarları (proofOfPayment'taki amount) encrypted kalır. Bu, "bu agent çok mu kazanıyor?" bilgisini gizlerken trust sinyallerini açık tutar.

---

### 2.2 ERC-8183: Agentic Commerce — Job Escrow

#### Genel Bakış

| Alan | Detay |
|------|-------|
| **Tam İsim** | ERC-8183: Agentic Commerce Protocol (ACP) |
| **Yazarlar** | Davide Crapis (EF dAI), Bryan Lim, Tay Weixiong, Chooi Zuhwa (Virtuals) |
| **Durum** | Draft (25 Şubat 2026, merge 4 Mart 2026) |
| **Requires** | EIP-20 |
| **Önem** | Virtuals + Ethereum Foundation ortak çalışması |

#### 3 Rol

| Rol | Yapabilir | Yapamaz |
|-----|-----------|---------|
| **Client** | createJob, setBudget, fund, reject (Open'da) | complete, submit |
| **Provider** | setBudget, submit | complete, reject (Submitted'da) |
| **Evaluator** | complete, reject (Submitted/Funded'da) | createJob, fund, submit |

#### Job Lifecycle

```
createJob() ──→ [Open]
                  │
          setBudget() + fund()
                  │
                  ▼
              [Funded] ──────────────→ reject() ──→ [Rejected] → refund
                  │
              submit()               claimRefund()
                  │                   (after expiry)
                  ▼                        │
            [Submitted]                    ▼
                  │                   [Expired] → refund
          ┌───────┴───────┐
     complete()      reject()
          │               │
          ▼               ▼
    [Completed]     [Rejected]
    → pay provider  → refund client
```

#### Key Interfaces

```solidity
// Hook interface (formally defined in spec)
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

// Core functions
function createJob(address provider, address evaluator, uint256 expiredAt,
    string calldata description, address hook) external returns (uint256 jobId);
function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function claimRefund(uint256 jobId) external;
```

#### Events

```solidity
event JobCreated(uint256 indexed jobId, address indexed client,
    address indexed provider, address evaluator, uint256 expiredAt);
event BudgetSet(uint256 indexed jobId, uint256 amount);
event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
```

#### FHE x402 Entegrasyonu — 3 Yaklaşım

**Yaklaşım 1: Wrap/Unwrap Boundary (Basit)**
```
Client: USDC → wrap → cUSDC → unwrap → USDC → fund(jobId, budget)
Problem: Escrow sırasında privacy yok
```

**Yaklaşım 2: Native FHE Escrow (Karmaşık)**
```
ACP kontratı ZamaEthereumConfig inherit eder
Budget: euint64 olarak saklanır
fund(): cUSDC.confidentialTransfer(acp, encryptedAmount)
complete(): cUSDC.confidentialTransfer(provider, encryptedAmount - fee)
Problem: Async decrypt gerekir, expectedBudget check FHE.eq gerektirir
```

**Yaklaşım 3: Hook-Based FHE (Önerilen) ✅**
```
Core ACP: Standart ERC-20 (USDC) ile çalışır — ERC-8183 uyumlu
IACPHook: afterAction(fund) → cUSDC side escrow
IACPHook: afterAction(complete) → cUSDC release to provider
Avantaj: Core ACP değişmez, privacy hook katmanında
```

#### Ana Gelir Fırsatı

ERC-8183 escrow completion'da platform fee:

```
Senaryo: Agent A, Agent B'ye $100'lık bir "veri analizi" job'ı veriyor
1. A → createJob(providerB, evaluatorC, expiry, "Analyze dataset X")
2. A → fund(jobId, 100 USDC)      ← cUSDC hook ile confidential escrow
3. B → submit(jobId, ipfsHash)     ← deliverable'ı teslim et
4. C → complete(jobId, "approved") ← evaluator onaylar
5. Platform fee: 100 * 1% = 1 USDC → treasury
6. B receives: 99 USDC (veya 99 cUSDC via hook)
```

**Neden bu ana gelir kaynağı olabilir?**
- Job'lar micropayment'lardan çok daha büyük ($10-$10,000 arası)
- Escrow = bypass edilemez (para kilitli, sadece complete/reject açar)
- %1 fee endüstri standardı (Fiverr %20, Upwork %10, ACP %1 = çok rekabetçi)

---

### 2.3 ERC-8126: Agent Registration & Verification

#### Genel Bakış

| Alan | Detay |
|------|-------|
| **Tam İsim** | ERC-8126: AI Agent Registration and Verification |
| **Yazar** | Leigh Cronian (@cybercentry) |
| **Durum** | Draft (15 Ocak 2025, onay 10 Şubat 2026) |
| **Requires** | EIP-155, EIP-191, EIP-712, ERC-3009 |
| **ENS** | cybercentry.base.eth |

#### 4 Verification Layer

| Layer | Kısaltma | Ne Kontrol Eder | Ne Zaman |
|-------|----------|-----------------|----------|
| **Ethereum Token Verification** | ETV | Kontrat varlığı, bilinen vulnerability pattern'ları | contractAddress varsa |
| **Staking Contract Verification** | SCV | Staking mekanizması, reentrancy, flash loan | stakingContract varsa |
| **Web Application Verification** | WAV | HTTPS, SSL, OWASP web güvenliği | Her zaman |
| **Wallet Verification** | WV | TX geçmişi, threat intelligence DB | Her zaman |

#### Risk Score Seviyeleri

| Seviye | Score | Anlamı |
|--------|-------|--------|
| Low Risk | 0-20 | Minimal endişe |
| Moderate | 21-40 | İnceleme önerilir |
| Elevated | 41-60 | Dikkatli olunmalı |
| High Risk | 61-80 | Ciddi endişeler |
| Critical | 81-100 | Etkileşimden kaçının |

#### Key Interface

```solidity
interface IERC8126 {
    event AgentRegistered(bytes32 indexed agentId, address indexed walletAddress,
        address indexed registrantAddress, string name);
    event AgentVerified(bytes32 indexed agentId, uint8 overallRiskScore,
        bytes32 etvProofId, bytes32 scvProofId, bytes32 wavProofId,
        bytes32 wvProofId, bytes32 summaryProofId);

    function registerAgent(string calldata name, string calldata description,
        address walletAddress, string calldata url, address contractAddress,
        address stakingContractAddress, uint256 platformId, uint256 chainId
    ) external returns (bytes32 agentId);

    function getAgentVerification(bytes32 agentId) external view returns (
        bool isVerified, uint8 overallRiskScore,
        uint8 etvScore, uint8 scvScore, uint8 wavScore, uint8 wvScore);

    function getAgentProofs(bytes32 agentId) external view returns (
        bytes32 etvProofId, string memory etvProofUrl,
        bytes32 scvProofId, string memory scvProofUrl,
        bytes32 wavProofId, string memory wavProofUrl,
        bytes32 wvProofId, string memory wvProofUrl,
        bytes32 summaryProofId, string memory summaryProofUrl);
}
```

#### ERC-8004 vs ERC-8126

| Aspect | ERC-8004 | ERC-8126 |
|--------|----------|----------|
| Odak | Identity + Reputation + Validation (genel) | Security verification (özel) |
| Registries | 3 generic registry | 4 özel verification layer |
| Risk scoring | Yok (validator'a bırakılmış) | 0-100 unified score, 5 tier |
| Privacy | Belirtilmemiş | ZKP (Groth16/PLONK) via PDV |
| Verification | Generic validator hook'ları | ETV, SCV, WAV, WV (spesifik) |
| Complementary? | **Evet** — ERC-8126 sonuçları ERC-8004 Validation Registry'ye post edilebilir |

#### FHE ile Confidential Risk Score

```solidity
// ERC-8126 risk score'unu FHE ile encrypt et:
mapping(bytes32 => euint8) private encryptedRiskScores;

function setEncryptedRiskScore(bytes32 agentId, uint8 score) internal {
    encryptedRiskScores[agentId] = FHE.asEuint8(score);
}

// Threshold kontrolü (score'u açmadan):
function isLowRisk(bytes32 agentId) external view returns (ebool) {
    return FHE.le(encryptedRiskScores[agentId], FHE.asEuint8(20));
}
```

**Kullanım:** "Bu agent'ın risk score'u 40'ın altında mı?" sorusuna score'u açıklamadan cevap vermek — pricing, access control, tiered service için.

#### Entegrasyon Önerisi

ERC-8126, ERC-8004'ün **complement**'i:
- ERC-8004: "Bu agent kim? Reputasyonu nasıl?" (genel trust)
- ERC-8126: "Bu agent güvenli mi? Kontratı vulnerable mı?" (güvenlik doğrulama)

**Bizim için:** ERC-8004 (identity + reputation) daha öncelikli. ERC-8126 roadmap'e eklenmeli ama submission deadline'a yetişmez.

---

### 2.4 Tüm Standartların Birlikte Çalışması

#### Tam Ödeme Akışı: x402 + ERC-7984 + ERC-8004 + ERC-8183

```
┌──────────────────────────────────────────────────────────────────┐
│                    FHE x402 Full Stack                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. IDENTITY (ERC-8004)                                         │
│     Agent kayıt → NFT minted → agentWallet set                  │
│     Registration JSON: { x402Support: true, services: [...] }   │
│                                                                  │
│  2. DISCOVERY                                                    │
│     Client → IdentityRegistry.tokenURI(agentId) → Agent bulundu │
│     Client → ReputationRegistry.getSummary(agentId) → Trust ✓   │
│                                                                  │
│  3. MICROPAYMENT (x402 + ERC-7984)                              │
│     Client → HTTP GET /api/data                                  │
│     Server → 402 Payment Required                                │
│         { price: "0.10", token: cUSDC, scheme: fhe-conf-v1 }    │
│     Client → cUSDC.confidentialTransfer(server, encrypted_0.10)  │
│     Client → verifier.payAndRecord(payer, server, nonce, 100000) │
│     Server → verify events → 200 OK + data                      │
│                                                                  │
│  4. JOB PAYMENT (ERC-8183 + cUSDC Hook)                        │
│     Client → ACP.createJob(provider, evaluator, expiry, desc)    │
│     Client → ACP.fund(jobId, 100_000000) → cUSDC hook escrow    │
│     Provider → (off-chain iş yap)                                │
│     Provider → ACP.submit(jobId, deliverableHash)                │
│     Evaluator → ACP.complete(jobId, "approved")                  │
│     → 99 USDC → provider, 1 USDC → treasury (platform fee %1)   │
│                                                                  │
│  5. REPUTATION UPDATE                                            │
│     Client → ReputationRegistry.giveFeedback(agentId, 95, 0,     │
│         "x402", "api-quality", endpoint, feedbackURI, hash)      │
│     feedbackURI: { proofOfPayment: { txHash, chainId } }        │
│                                                                  │
│  FEE COLLECTION POINTS:                                          │
│  ├── Wrap/Unwrap: %0.1 (Layer 1 — token-level)                 │
│  ├── Job Completion: %1 (Layer 2 — escrow-level)                │
│  └── Facilitator: SaaS (Layer 3 — off-chain)                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### Her Katmanda Fee Analizi

| Katman | Operasyon | Fee | Kim Ödüyor | Bypass Edilebilir mi? |
|--------|-----------|-----|------------|----------------------|
| ERC-7984 (Token) | Wrap USDC→cUSDC | %0.1 | Agent | ❌ (kontrat zorunlu) |
| ERC-7984 (Token) | Unwrap cUSDC→USDC | %0.1 | Agent | ❌ (kontrat zorunlu) |
| ERC-7984 (Token) | confidentialTransfer | Ücretsiz | — | — |
| x402 (Verifier) | payAndRecord | Ücretsiz | — | — |
| ERC-8183 (Escrow) | Job completion | %1 | Client (escrow'dan) | ❌ (escrow lock) |
| ERC-8004 (Identity) | Agent registration | Gas only | Agent | — |
| ERC-8004 (Reputation) | giveFeedback | Gas only | Client | — |
| Facilitator (SaaS) | Verification | Subscription | Server operator | ✅ (self-host) |

---

## 3. Rekabet Analizi

### 3.1 Doğrudan Rakipler (FHE + x402)

| Proje | Teknoloji | Chain | Durum | Fark |
|-------|-----------|-------|-------|------|
| **Mind Network x402z** | Zama FHE | Kendi ağı | Testnet (Q3 2026 mainnet) | Kendi ağını kuruyor, EVM üzerinde değil |
| **Fhenix402** | Fhenix CoFHE | Base Sepolia | PoC (1 günde yapılmış) | Çok erken, ERC-7984 değil FHERC20 |
| **Biz (FHE x402)** | Zama fhEVM | Ethereum Sepolia | V4.0, 226 test, deployed | Token-centric, ERC-7984, Virtuals+OpenClaw |

### 3.2 Privacy + x402 Rakipleri (ZK, FHE değil)

| Proje | Teknoloji | Chain | Durum |
|-------|-----------|-------|-------|
| **px402 (PRXVT)** | ZK Groth16 | Base + Polygon | Live (SDK published), $PRXVT token |
| **Biz (PrivAgent)** | ZK Groth16 + Poseidon | Base Sepolia | V4.4, 282 test |

### 3.3 Zama Ekosistem Fee/Payment Projeleri

| Proje | Açıklama | Fee Modeli |
|-------|----------|------------|
| **Zaiffer** | ERC-20 → ERC-7984 wrapper | Wrap/unwrap bps |
| **CAMM** | Confidential AMM | %1 swap fee → LP'ler |
| **Aruvi** | Privacy payment gateway | Bilinmiyor |
| **Siphon** | Privacy-focused DeFi | Bilinmiyor |
| **Pendex** | FHE dark pool | Bilinmiyor |

### 3.4 Benzersiz Konumlandırmamız

```
                    ┌─────────────────────────────┐
                    │    Sadece BİZ yapıyoruz:     │
                    │                             │
                    │  ERC-7984 + x402 + Agent     │
                    │  Framework Entegrasyonları    │
                    │  (Virtuals + OpenClaw)        │
                    │                             │
                    │  Token-centric (pool yok)    │
                    │  Doğrudan EVM deploy          │
                    │  226 test, 3 kontrat          │
                    └─────────────────────────────┘
```

| Avantaj | Açıklama |
|---------|----------|
| **Tek "ERC-7984 + x402" projesi** | Mind Network kendi ağını kuruyor, Fhenix FHERC20 kullanıyor |
| **Agent framework entegrasyonları** | Virtuals GAME (30 test) + OpenClaw (25 test) — rakiplerde yok |
| **Token-centric mimari** | Pool yok = daha basit, daha güvenli, daha az attack surface |
| **Doğrudan EVM deploy** | Herhangi bir Zama coprocessor chain'de çalışır |
| **Test coverage** | 226 test — ekosistemde en kapsamlı |

| Zayıflık | Açıklama |
|----------|----------|
| **Sadece Sepolia** | fhEVM henüz mainnet'te yok |
| **Gas maliyeti** | FHE ops pahalı (~$2-5/ödeme) |
| **fhevmjs WASM** | Browser agent'lar için ağır |
| **Tek geliştirici** | Mind Network'ün ekibi ve funding'i var |

### 3.5 x402 Ekosistem Genel Görünüm

- **200+** proje x402 kullanıyor
- **Coinbase + Cloudflare** x402 Foundation kurdu
- **Circle, Stripe, AWS** koalisyon üyeleri
- **15M+** işlem işlenmiş
- **25+** facilitator aktif
- **Hiçbiri** FHE kullanmıyor (Mind Network ve Fhenix hariç)

---

## 4. Öneri & Roadmap

### 4.1 Zama Submission Öncesi (15 Mart 2026'ya Kadar)

#### Yapılması Gerekenler (Öncelik Sırasıyla)

| # | Task | Neden | Süre |
|---|------|-------|------|
| 1 | **LIGHTPAPER.md güncelle** — V4.0 + fee model + ERC entegrasyonları | Jüri ilk bunu okur | 2-3 saat |
| 2 | **SECURITY.md güncelle** — V4.0+ bulgular | Güvenlik bilinci gösterir | 1-2 saat |
| 3 | **Bu raporu docs/'a ekle** | Araştırma derinliği gösterir | ✅ Zaten yapıldı |
| 4 | **README.md'ye ERC roadmap ekle** | Vizyonu gösterir | 30 dk |
| 5 | **5-dakika demo video kaydet** | Submission zorunluluğu (bootcamp için) | 1-2 saat |

#### Yapılmaması Gerekenler (Deadline'a Yetişmez)

| Task | Neden Ertelenmeli |
|------|-------------------|
| ERC-8183 implementasyonu | Spec henüz Draft, reference impl yok, 3-4 gün iş |
| ERC-8004 entegrasyonu | Sepolia registry var ama entegrasyon testi 2-3 gün |
| ERC-8126 entegrasyonu | Henüz deployed kontrat yok |
| Encrypted reputation | Araştırma aşamasında |
| Transfer fee | Karar: eklenmeyecek |

### 4.2 Post-Submission Roadmap

#### V5.0 — ERC Entegrasyonları (2-3 hafta)

```
Sprint 1 (1 hafta):
├── ERC-8004 Identity Registry entegrasyonu
│   ├── Agent registration helper (SDK)
│   ├── x402Support: true ayarla
│   └── agentWallet ↔ payment address mapping
├── ERC-8004 Reputation Registry entegrasyonu
│   ├── x402 payment sonrası otomatik feedback
│   └── proofOfPayment linking
└── Testler (Identity + Reputation)

Sprint 2 (1-2 hafta):
├── ERC-8183 ACP implementasyonu
│   ├── Core kontrat (createJob → complete lifecycle)
│   ├── IACPHook: cUSDC side escrow
│   ├── Platform fee: %1 on completion
│   └── SDK: createJob, fund, submit helpers
├── Facilitator SaaS tier system
│   ├── Free: 1,000 verify/month
│   ├── Pro: unlimited + analytics
│   └── Enterprise: custom
└── Testler (ACP + Hook + Fee)
```

#### V6.0 — Advanced (1-2 ay)

```
├── Encrypted reputation (FHE + ERC-8004)
│   ├── euint128 score storage
│   ├── Threshold-based access control
│   └── Privacy-preserving trust signals
├── ERC-8126 risk score integration
│   ├── Agent security verification
│   ├── Confidential risk scores (euint8)
│   └── Automated risk-based pricing
├── Multi-token factory
│   ├── cWETH, cDAI wrapper kontratları
│   └── Token-agnostic ACP escrow
└── Cross-chain (Zama coprocessor L2 geldiğinde)
    ├── Base deploy
    ├── Arbitrum deploy
    └── LayerZero messaging
```

### 4.3 Final Karar Özeti

| Karar | Seçim | Gerekçe |
|-------|-------|---------|
| **Transfer fee** | ❌ Ekleme | ERC-7984 normu, Zaiffer bile yapmıyor |
| **Wrap/unwrap fee** | ✅ Koru (%0.1) | Mevcut, çalışıyor, bypass edilemez |
| **Escrow fee** | ✅ Ekle (%1, V5.0'da) | En yüksek gelir potansiyeli, bypass edilemez |
| **Facilitator SaaS** | ✅ Ekle (V5.0'da) | Recurring revenue, düşük implementasyon maliyeti |
| **ERC-8004** | ✅ Entegre et (V5.0'da) | Agent identity + reputation = ekosistem uyumu |
| **ERC-8183** | ✅ Entegre et (V5.0'da) | Job escrow = ana gelir kaynağı |
| **ERC-8126** | 📋 Roadmap (V6.0) | Henüz erken, impl yok |
| **Encrypted reputation** | 📋 Roadmap (V6.0) | Araştırma + gas analizi gerekli |

---

## Kaynaklar

### ERC Standartları
- [ERC-7984: Confidential Fungible Token Interface](https://eips.ethereum.org/EIPS/eip-7984)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) — [Discussion](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098)
- [ERC-8183: Agentic Commerce](https://eips.ethereum.org/EIPS/eip-8183) — [Discussion](https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902)
- [ERC-8126: AI Agent Registration](https://eips.ethereum.org/EIPS/eip-8126) — [Discussion](https://ethereum-magicians.org/t/erc-8126-ai-agent-registration-and-verification/27445)

### Zaiffer
- [OpenZeppelin Zaiffer Audit](https://www.openzeppelin.com/news/zaiffer-token-audit)
- [Zaiffer Website](https://www.zaiffer.org/)
- [Zaiffer Whitepaper](https://zaiffer.gitbook.io/wiki/)

### CAMM
- [CAMM GitHub](https://github.com/6ygb/CAMM) (BSD-3-Clause-Clear)
- [TradeCore GitHub](https://github.com/ob04z9ejhn/TradeCore) (alternatif AMM)

### x402 Ekosistem
- [x402.org](https://www.x402.org/)
- [Coinbase x402 GitHub](https://github.com/coinbase/x402)
- [x402 Ecosystem](https://www.x402.org/ecosystem)
- [Coinbase & Cloudflare x402 Foundation](https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation)

### Rakipler
- [Mind Network x402z](https://x402z.mindnetwork.xyz/)
- [Fhenix402](https://www.fhenix.io/blog/fhenix402)
- [px402 / PRXVT](https://github.com/PRXVT/sdk)

### ERC-8004 Reference Implementation
- [ChaosChain/trustless-agents-erc-ri](https://github.com/ChaosChain/trustless-agents-erc-ri) (74 test)
- [qntx/erc8004 Rust SDK](https://github.com/qntx/erc8004)
- [OnChainMee/x402-erc8004-agent](https://github.com/OnChainMee/x402-erc8004-agent)

### Zama Ecosystem
- [Zama Developer Program](https://www.zama.org/programs/developer-program)
- [Zama Protocol Litepaper](https://docs.zama.org/protocol/zama-protocol-litepaper)
- [OpenZeppelin Confidential Contracts](https://github.com/OpenZeppelin/openzeppelin-confidential-contracts)

---

*Bu rapor FHE x402 projesinin fee model kararları ve ERC standart entegrasyonları için kapsamlı araştırma içermektedir. 6 paralel araştırma ajanı ile derlenmiştir.*
