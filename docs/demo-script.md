# MetaNetwork EQI — End-to-End MVP Demo Script

Версія: 2026-06-17  
Мета: перевірити повний ланцюжок MetaRegistry — від Genesis до cross-network transfer — з інваріант-перевіркою після кожного кроку.

---

## 0. Передумови

### 0.1 Що потрібно

| Вимога | Значення |
|---|---|
| Node.js | ≥ 20 |
| `backend/.env` | заповнений (IT приватні ключі, RPC URLs) — локально, не в репо |
| Робочий RPC | усі 4 мережі мають відповідати (verify: `GET /health/gas`) |
| Баланс IT-гаманців (gas) | ≥ 0.005 ETH/BNB/ARB, ≥ 0.01 POL на кожному IT-EOA |
| MetaMask | для Scenario 4 (DApp) |
| Адреси тестувальників | заздалегідь зареєстровані через `POST /genesis` або `POST /registry/register` |

### 0.2 Запуск бекенду

```bash
cd backend
node src/server.js
# → MetaRegistry backend running on port 3000
```

### 0.3 Позначення

```
BASE = http://localhost:3000
TESTER1 = <адреса тестового гаманця №1>   # заміни реальною адресою
TESTER2 = <адреса тестового гаманця №2>   # заміни реальною адресою
```

### 0.4 Обов'язкова форма invariant-check

Після **кожного** кроку нижче виконай цей curl і перевір числа:

```bash
curl -s "$BASE/transparency" | python3 -m json.tool
# або: curl -s "$BASE/transparency" | jq .snapshot.global_state
```

Числа, які ніколи не повинні змінюватись:
- `TOTAL_MINTED` = **400 000**
- `A_ACTIVE` = **100 000** (порушення на +1 → негайний STOP)
- `TOTAL_FROZEN` = **300 000** (може змінюватись лише між source-freeze і target-unfreeze того ж envelope, після завершення — знову 300 000)
- `invariant_status` = **"ok"** (будь-що інше = зупинись, розслідуй)
- `system_status` = **"ACTIVE"** (STOPPED = критична помилка)

---

## Scenario 1 — Genesis і початковий стан

### Крок 1.1: Ініціалізація MetaRegistry

```bash
curl -s -X POST "$BASE/genesis" \
  -H "Content-Type: application/json" \
  -d '{
    "networks": [
      { "network_id": "A", "it_address": "0xDB9180f50AFB6eAcB671DD173B86bC5437844ed2" },
      { "network_id": "B", "it_address": "0xF17eEbb229E8F767bBCA6C39E19f527165b9cdE1" },
      { "network_id": "C", "it_address": "0x894d8842305d6E0c83903c6Da77cC281BEF73760" },
      { "network_id": "D", "it_address": "0xF3250962637144FFEd4d3e2165dc76D19c43bC1c" }
    ]
  }'
```

**Очікуваний результат:**
```json
{ "ok": true, "event_id": "EVT-...", "state_after": { ... } }
```

### Крок 1.2: Invariant-check після Genesis

```bash
curl -s "$BASE/transparency" | jq '{
  global: .snapshot.global_state,
  net_A:  .snapshot.per_network.A,
  net_B:  .snapshot.per_network.B,
  net_C:  .snapshot.per_network.C,
  net_D:  .snapshot.per_network.D
}'
```

**Очікувані числа:**

| Параметр | Значення |
|---|---|
| `TOTAL_MINTED` | **400 000** |
| `A_ACTIVE` | **100 000** |
| `TOTAL_FROZEN` | **300 000** |
| `invariant_status` | **"ok"** |
| `system_status` | **"ACTIVE"** |

**Per-network (однаково для A, B, C, D):**

| Поле | Значення |
|---|---|
| `IT_ACTIVE` | **25 000** |
| `IT_FROZEN` | **75 000** |
| `wallet_active_total` | **0** |
| `UNAVAILABLE` | **0** |
| `network_total` | **100 000** |

Формула-перевірка на кожну мережу:
`0 + 25 000 + 75 000 + 0 = 100 000` ✓

---

## Scenario 2 — Treasury Distribution (видача tEQUI тестувальникам)

> Виконується адміністратором. Вимагає робочого RPC і газу на IT-EOA.  
> Кожен виклик генерує реальну on-chain ERC-20 транзакцію з IT-EOA → адреса тестувальника.

### Крок 2.1: Видача TESTER1 у мережі A — 5 000 tEQUI

```bash
curl -s -X POST "$BASE/treasury/distribute" \
  -H "Content-Type: application/json" \
  -d '{
    "network_id": "A",
    "address":    "'"$TESTER1"'",
    "amount":     5000
  }'
```

**Очікуваний результат:**
```json
{
  "ok":        true,
  "tx_hash":   "0x...",
  "event_id":  "EVT-...",
  "state_after": { ... }
}
```

### Invariant-check 2.1 — після видачі TESTER1 у мережі A

**Очікувані числа:**

| Мережа | `wallet_active_total` | `IT_ACTIVE` | `IT_FROZEN` | `UNAVAILABLE` | `network_total` |
|---|---|---|---|---|---|
| **A** | **5 000** | **20 000** | 75 000 | 0 | 100 000 |
| B | 0 | 25 000 | 75 000 | 0 | 100 000 |
| C | 0 | 25 000 | 75 000 | 0 | 100 000 |
| D | 0 | 25 000 | 75 000 | 0 | 100 000 |

Глобальні:

| Параметр | Значення |
|---|---|
| `A_ACTIVE` | **(5 000 + 20 000) + (0 + 25 000) + (0 + 25 000) + (0 + 25 000) = 100 000** ✓ |
| `TOTAL_FROZEN` | 75 000 × 4 = **300 000** ✓ |

Формула-перевірка мережа A: `5 000 + 20 000 + 75 000 + 0 = 100 000` ✓

---

### Крок 2.2: Видача TESTER2 у мережі B — 5 000 tEQUI

```bash
curl -s -X POST "$BASE/treasury/distribute" \
  -H "Content-Type: application/json" \
  -d '{
    "network_id": "B",
    "address":    "'"$TESTER2"'",
    "amount":     5000
  }'
```

### Invariant-check 2.2 — після видачі TESTER2 у мережі B

| Мережа | `wallet_active_total` | `IT_ACTIVE` | `IT_FROZEN` | `network_total` |
|---|---|---|---|---|
| **A** | 5 000 | 20 000 | 75 000 | 100 000 |
| **B** | **5 000** | **20 000** | 75 000 | 100 000 |
| C | 0 | 25 000 | 75 000 | 100 000 |
| D | 0 | 25 000 | 75 000 | 100 000 |

| Параметр | Значення |
|---|---|
| `A_ACTIVE` | **(5 000+20 000)+(5 000+20 000)+(0+25 000)+(0+25 000) = 100 000** ✓ |
| `TOTAL_FROZEN` | **300 000** ✓ |

---

### Крок 2.3: Перевірка межі 60/40 (негативний тест)

> Правило: max wallet_active на один гаманець/мережу ≤ 60 000. IT_ACTIVE не може впасти нижче 40 000 на мережу.
> Цей виклик **має бути відхилений**.

```bash
curl -s -X POST "$BASE/treasury/distribute" \
  -H "Content-Type: application/json" \
  -d '{
    "network_id": "A",
    "address":    "'"$TESTER1"'",
    "amount":     61000
  }'
```

**Очікуваний результат (HTTP 400):**
```json
{
  "ok":     false,
  "reason": "..."   # містить "MAX_WALLET_ACTIVE" або "MIN_IT_ACTIVE"
}
```

### Invariant-check 2.3 — стан не повинен змінитись

Після відхилення числа ідентичні результату після кроку 2.2 (жодних змін).

---

## Scenario 3 — Cross-Network Transfer через MetaRegistry API

> **THROUGH_METAREGISTRY** — адмін викликає `POST /transfer` напряму.  
> Це повна MetaRegistry операція: source freeze → target unfreeze.  
> В MVP executor не викликається автоматично з цього ендпоінту (on-chain exit tx видається окремо через Executor).

### Стан перед кроком 3.1

```
Network A: wallet_active_total = 5 000 (TESTER1 має 5 000)
Network B: wallet_active_total = 5 000 (TESTER2 має 5 000)
IT_FROZEN[A] = 75 000, IT_FROZEN[B] = 75 000
```

### Крок 3.1: TESTER1 (A) → TESTER2 (B), 1 000 tEQUI

```bash
curl -s -X POST "$BASE/transfer" \
  -H "Content-Type: application/json" \
  -d '{
    "source_mode":    "AUTOMATIC",
    "amount":         1000,
    "sender":         "'"$TESTER1"'",
    "recipient":      "'"$TESTER2"'",
    "target_network": "B"
  }'
```

**Очікуваний результат:**
```json
{
  "ok":        true,
  "event_id":  "EVT-...",
  "state_after": { ... }
}
```

### Invariant-check 3.1 — після cross-network transfer

**Як змінюється стан (механіка):**
1. Source freeze (мережа A): `wallet_active[A] -= 1 000`, `IT_FROZEN[A] += 1 000`
2. Target unfreeze (мережа B): `IT_FROZEN[B] -= 1 000`, `wallet_active[B] += 1 000`

**Очікувані числа:**

| Мережа | `wallet_active_total` | `IT_ACTIVE` | `IT_FROZEN` | `UNAVAILABLE` | `network_total` |
|---|---|---|---|---|---|
| **A** | **4 000** | 20 000 | **76 000** | 0 | 100 000 |
| **B** | **6 000** | 20 000 | **74 000** | 0 | 100 000 |
| C | 0 | 25 000 | 75 000 | 0 | 100 000 |
| D | 0 | 25 000 | 75 000 | 0 | 100 000 |

| Параметр | Значення |
|---|---|
| `A_ACTIVE` | **(4 000+20 000)+(6 000+20 000)+(0+25 000)+(0+25 000) = 100 000** ✓ |
| `TOTAL_FROZEN` | **76 000 + 74 000 + 75 000 + 75 000 = 300 000** ✓ |
| `TOTAL_MINTED` | **400 000** ✓ |

Формула-перевірка мережа A: `4 000 + 20 000 + 76 000 + 0 = 100 000` ✓  
Формула-перевірка мережа B: `6 000 + 20 000 + 74 000 + 0 = 100 000` ✓

---

### Крок 3.2: Same-network transfer TESTER2 → TESTER1 у мережі B, 2 000 tEQUI

```bash
curl -s -X POST "$BASE/transfer" \
  -H "Content-Type: application/json" \
  -d '{
    "source_mode":    "AUTOMATIC",
    "amount":         2000,
    "sender":         "'"$TESTER2"'",
    "recipient":      "'"$TESTER1"'",
    "target_network": "B"
  }'
```

**Очікуваний результат після кроку 3.2:**

| Мережа | `wallet_active_total` | `IT_ACTIVE` | `IT_FROZEN` | `network_total` |
|---|---|---|---|---|
| A | 4 000 | 20 000 | 76 000 | 100 000 |
| **B** | **6 000** *(4000 TESTER2 + 2000 TESTER1 у B)* | 20 000 | **74 000** | 100 000 |
| C | 0 | 25 000 | 75 000 | 100 000 |
| D | 0 | 25 000 | 75 000 | 100 000 |

> Same-network: IT_FROZEN не змінюється (freeze і unfreeze в одній мережі = IT_FROZEN+2000, потім -2000 = net 0).

| Параметр | Значення |
|---|---|
| `A_ACTIVE` | **100 000** ✓ |
| `TOTAL_FROZEN` | **300 000** ✓ |

---

### Крок 3.3: Негативний тест — недостатній баланс

```bash
curl -s -X POST "$BASE/transfer" \
  -H "Content-Type: application/json" \
  -d '{
    "source_mode":    "AUTOMATIC",
    "amount":         99999,
    "sender":         "'"$TESTER1"'",
    "recipient":      "'"$TESTER2"'",
    "target_network": "C"
  }'
```

**Очікуваний результат (HTTP 400):**
```json
{ "ok": false, "reason": "..." }
```

Числа після відмови — **незмінні** від результату кроку 3.2.

---

## Scenario 4 — DApp-Driven Entry TX (DIRECT_HOST_NETWORK_VIA_DAPP)

> **Статус: частково реалізовано.** Вимагає MetaMask, RPC та газу IT-EOA.  
> **Відомий gap**: Observer навмисно пропускає тransfer-події де to_address = IT-EOA (`processor.js:113`).  
> DApp надсилає entry-транзакцію і чекає events?tx_hash= — але цих подій поки немає автоматично.  
> Повний E2E DApp-flow буде готовий після реалізації entry-detection (окремий крок поза MVP-scope).

### Що працює зараз

1. Відкрити `http://localhost:3000/dapp/` у браузері.
2. Connect MetaMask (Sepolia/BSC Testnet/Amoy/Arbitrum Sepolia).
3. DApp показує баланс tEQUI через ethers.js RPC (не MetaMask UI).
4. `GET /registry/check-address` — перевіряє чи адреса зареєстрована.
5. Відправити entry-транзакцію (Tester → IT-EOA) — MetaMask показує очікування підтвердження.

### Що не спрацює поки що

- Polling `GET /events?tx_hash=` після entry-транзакції не знайде подій (Observer пропускає tester→IT).
- Автоматичний exit-tx (IT → Tester у цільовій мережі) не запускається.

### Workaround для E2E перевірки зараз

1. Відправити entry-транзакцію через MetaMask (зафіксувати tx_hash).
2. Вручну викликати `POST /transfer` через curl (адміністративний шлях, Scenario 3).
3. Вручну викликати Executor для exit-tx (або підтвердити через `GET /events`).

---

## Scenario 5 — Health Checks

### Крок 5.1: Gas monitor

```bash
curl -s "$BASE/health/gas" | jq .
```

**Очікуваний результат (усі мережі OK):**
```json
{
  "ok": true,
  "networks": {
    "A": { "status": "OK", "balance_eth": "0.12", "threshold_eth": "0.005" },
    "B": { "status": "OK", "balance_bnb": "0.08", "threshold_bnb": "0.005" },
    "C": { "status": "OK", "balance_pol": "0.25", "threshold_pol": "0.01"  },
    "D": { "status": "OK", "balance_eth": "0.05", "threshold_eth": "0.005" }
  }
}
```

**WARNING** (баланс нижче порогу) — потрібно поповнити IT-EOA перед exit-транзакціями.

### Крок 5.2: Backend health

```bash
curl -s "$BASE/health"
# → { "status": "ok", "ts": 1234567890 }
```

### Крок 5.3: Observer status

```bash
curl -s "$BASE/observer/status" | jq .
```

**Очікуваний результат:**
```json
{
  "running":     true,
  "checkpoints": {
    "A": { "last_block": 123456 },
    "B": { "last_block": 234567 },
    "C": { "last_block": 345678 },
    "D": { "last_block": 456789 }
  }
}
```

Якщо `checkpoints` порожні або `running: false` — Observer не запустився або RPC недоступний.

---

## Фінальний invariant-check (після всіх сценаріїв)

```bash
curl -s "$BASE/transparency" | jq '{
  global:    .snapshot.global_state,
  summary:   .snapshot.token_state_summary,
  per_net:   .snapshot.per_network
}'
```

**Незмінні гарантії на будь-якому етапі:**

| Інваріант | Значення |
|---|---|
| `global_state.TOTAL_MINTED` | **400 000** |
| `global_state.A_ACTIVE` | **100 000** |
| `global_state.TOTAL_FROZEN` | **300 000** (відхилення лише в transitional-стані між source-freeze і target-unfreeze одного envelope) |
| `global_state.invariant_status` | **"ok"** |
| `global_state.system_status` | **"ACTIVE"** (STOPPED = критична помилка, не відновлюється автоматично) |
| Σ `network_total` по всіх мережах | **400 000** |
| `per_network.X.network_total` на кожну мережу | **100 000** |

---

## Відомі обмеження і наступні кроки

| Пункт | Статус | Пояснення |
|---|---|---|
| RPC-доступ | Тільки локально | GCP Cloud Run розгорне публічний backend пізніше |
| GCP KMS | Заплановано | `executor/networks.js:getSigner()` готова для заміни на `ethers-gcp-kms-signer` |
| `transparency.html` API_URL | Placeholder | Встановити після деплою Cloud Run |
| DApp entry-detection | Gap | Observer пропускає tester→IT. Потребує нового обробника або endpoint для верифікації entry-tx hash |
| Executor on-chain exit tx | Ручний виклик | Немає автоматичного тригера після `POST /transfer` — потребує інтеграції з Executor |
| Tester wallet registration | `POST /genesis` | Поточний `/genesis` приймає список гаманців; реєстрація нових гаманців після genesis — TBD |
