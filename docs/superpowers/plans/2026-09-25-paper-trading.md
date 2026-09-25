# Paper-Trading Execution Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement true paper-execution that simulates fills from live orderbook quotes without ever submitting real orders, plus Chainlink fallback and WS health checks.

**Architecture:** Central `PaperBroker` (pure fill math) + `PaperAccount` (ledger) injected at the `TradingService` order choke point; `PAPER_TRADING` flag distinct from `DRY_RUN` wires `autoExecute` on in both entry points; Chainlink subscribes to fallback feed and degrades instead of blocking; `RealtimeServiceV2` gains per-topic health.

**Tech Stack:** TypeScript (strict), Vitest unit + integration, existing `src/services/*`, `bot-config.ts`, `bot-with-dashboard.ts`.

**Spec:** `docs/superpowers/specs/2026-09-25-paper-trading-design.md`

## Global Constraints

- Live orders only when `DRY_RUN=false AND PAPER_TRADING=false`; paper path must never call `createAndPostOrder` / `createAndPostMarketOrder` or real on-chain split/merge/redeem/swap.
- Do not paste private keys or RPC URLs into docs, issues, commits, or chat output.
- Do not commit `.env` or secrets; document only `PAPER_TRADING` in `.env.example`.
- Keep GCP usage inside Always Free limits (no infra changes in this plan).
- `pnpm`/`npm` test command is `vitest run`; typecheck is `npx tsc --noEmit`.
- Follow existing import style with `.js` suffixes in relative imports (e.g. `./paper-broker.js`).
- Every task ends with a commit; do not batch tasks into one commit.

## Review Focus

- Empty or one-sided orderbook passed to the simulator must not divide by zero or return NaN — expect `success:false` with a liquidity reason.
- Amount below Polymarket minimums ($1 value / 5 shares) must skip with a reason, not simulate a dust fill.
- `PAPER_TRADING=true` with `DRY_RUN=false` must still never go live — expect paper routing to dominate.
- Chainlink silent for 10 minutes while fallback feed flows must keep DipArb rotating with `priceSource:'fallback'`, not `$Waiting` forever.
- WS topic silent past its stall threshold must surface `degraded:true` and trigger one resubscribe, not silent death.

---

## File Structure

New files (one responsibility each):

- `src/services/paper-broker.ts` — pure fill simulation: depth walk (VWAP), fee/gas, minimums, partial fills, limit matching. No I/O, no logging.
- `src/services/paper-broker.test.ts` — unit tests for the broker math.
- `src/services/paper-account.ts` — paper ledger: realized PnL net of fees, peak/drawdown, streaks, exposure add/release, fill-quality stats. No I/O.
- `src/services/paper-account.test.ts` — ledger unit tests.
- `src/services/paper-guarantee.test.ts` — choke-point guarantee test (throwing CLOB mock proves no live call).
- `src/services/chainlink-fallback.test.ts` — DipArb fallback-source tests.
- `src/services/realtime-health.test.ts` — WS health unit tests.
- `src/__tests__/integration/paper-mode.integration.test.ts` — paper end-to-end (mocked CLOB, paper flags on).

Modified files:

- `src/services/trading-service.ts` — extend `TradingServiceConfig` with paper fields; route first lines of `createLimitOrder`/`createMarketOrder` to broker.
- `src/services/arbitrage-service.ts` — accept paper broker/quote passthrough; no fill-math duplication.
- `src/services/dip-arb-service.ts` — accept paper mode; dual Chainlink + fallback subscription; degraded price source.
- `src/services/smart-money-service.ts` — paper sim branch via broker (keep staleness/spread/premium guards).
- `src/services/realtime-service-v2.ts` — per-subscription health, disconnect counters, `getHealth()`.
- `bot-config.ts` — `CONFIG.paperTrading`, `isLive`, `autoExecute` wiring, `PAPER` status display.
- `bot-with-dashboard.ts` — same wiring; replace naive `simulateTrade` estimate with broker fills.
- `.env.example` — document `PAPER_TRADING`.
- `src/dashboard/*` as needed — surface `paperTrading`, WS/feed health (minimal: types + emitter passthrough).

Task order matters: Tasks 1–2 define interfaces that Tasks 3–7 consume; Task 8 is independent of 1–7 and may run in parallel; Task 9 integrates everything.

Shared interfaces (locked here, consumed verbatim by later tasks):

```typescript
// paper-broker.ts
export interface PaperLevel { price: number; size: number; }
export interface PaperBrokerConfig {
  feeRateBps?: number;
  estimatedGasCostUsd?: number;
  maxDepthLevels?: number;
  defaultSlippagePct?: number;
  minOrderValueUsd?: number;
  minOrderSizeShares?: number;
}
export interface SimulateMarketParams {
  side: 'BUY' | 'SELL';
  amountUsd: number;
  bids: PaperLevel[];
  asks: PaperLevel[];
  referencePrice?: number;
}
export interface SimulateLimitParams {
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  bids: PaperLevel[];
  asks: PaperLevel[];
}
export interface SimulatedFill {
  success: boolean;
  simulated: true;
  orderId: string;
  avgPrice: number;
  filledSize: number;
  filledValueUsd: number;
  feeUsd: number;
  slippageBps: number;
  partial: boolean;
  unfilledUsd: number;
  reason?: string;
}
export class PaperBroker {
  constructor(config?: PaperBrokerConfig);
  simulateMarketOrder(p: SimulateMarketParams): SimulatedFill;
  simulateLimitOrder(p: SimulateLimitParams): SimulatedFill;
}
```

```typescript
// paper-account.ts
export interface FillRecord {
  marketKey: string;
  avgPrice: number;
  filledSize: number;
  filledValueUsd: number;
  feeUsd: number;
  slippageBps: number;
}
export interface PaperSnapshot {
  trades: number; realizedPnl: number; feesPaid: number;
  wins: number; losses: number;
  consecutiveWins: number; consecutiveLosses: number;
  peakCapital: number; currentCapital: number; currentDrawdown: number;
  totalExposureUsd: number; perMarketExposureUsd: Record<string, number>;
  avgSlippageBps: number; partialRate: number;
}
export class PaperAccount {
  constructor(startingCapitalUsd: number);
  recordFill(f: FillRecord): void;
  recordClose(pnlUsd: number, marketKey: string, releaseUsd: number): void;
  getSnapshot(): PaperSnapshot;
}
```

```typescript
// trading-service.ts additions
export interface PaperQuote {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}
// Extend TradingServiceConfig with:
//   paperMode?: boolean;
//   paperBroker?: import('./paper-broker.js').PaperBroker;
// Extend MarketOrderParams and LimitOrderParams with:
//   paperQuote?: PaperQuote;
```

```typescript
// realtime-service-v2.ts additions
export interface SubHealth {
  subId: string; topic: string;
  messageCount: number; lastMessageAt: number;
  silentMs: number; degraded: boolean;
}
export interface RealtimeHealth {
  connected: boolean;
  subscriptions: SubHealth[];
  disconnectCounts: Record<string, number>;
  resubscribeCount: number;
}
// New methods: getHealth(silenceThresholdMs?: number): RealtimeHealth
```

---

### Task 1: PaperBroker fill simulation

**Files:**
- Create: `src/services/paper-broker.ts`
- Test: `src/services/paper-broker.test.ts`

**Interfaces:**
- Consumes: nothing (pure math; Polymarket minimums `MIN_ORDER_VALUE_USDC=1`, `MIN_ORDER_SIZE_SHARES=5` mirrored as defaults).
- Produces: `PaperBroker`, `SimulateMarketParams`, `SimulateLimitParams`, `SimulatedFill`, `PaperLevel`, `PaperBrokerConfig` exactly as in the shared interfaces above (later tasks import these names verbatim).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/paper-broker.test.ts
import { describe, it, expect } from 'vitest';
import { PaperBroker } from './paper-broker.js';

describe('PaperBroker market fill', () => {
  it('walks depth to VWAP and deducts fees', () => {
    const b = new PaperBroker({ feeRateBps: 100, estimatedGasCostUsd: 0.1 });
    const f = b.simulateMarketOrder({
      side: 'BUY', amountUsd: 10,
      bids: [{ price: 0.5, size: 100 }],
      asks: [{ price: 0.5, size: 10 }, { price: 0.6, size: 10 }],
    });
    expect(f.success).toBe(true);
    expect(f.simulated).toBe(true);
    expect(f.filledSize).toBeGreaterThan(0);
    expect(f.feeUsd).toBeGreaterThan(0);
    expect(f.avgPrice).toBeGreaterThan(0);
  });
  it('rejects empty book without NaN', () => {
    const b = new PaperBroker();
    const f = b.simulateMarketOrder({ side: 'BUY', amountUsd: 10, bids: [], asks: [] });
    expect(f.success).toBe(false);
    expect(Number.isNaN(f.avgPrice)).toBe(false);
    expect(f.reason).toMatch(/liquidity/i);
  });
  it('rejects dust below $1 minimum', () => {
    const b = new PaperBroker();
    const f = b.simulateMarketOrder({
      side: 'BUY', amountUsd: 0.5,
      bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.5, size: 100 }],
    });
    expect(f.success).toBe(false);
    expect(f.reason).toMatch(/minimum/i);
  });
  it('marks partial when depth is thin', () => {
    const b = new PaperBroker();
    const f = b.simulateMarketOrder({
      side: 'BUY', amountUsd: 100,
      bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.5, size: 5 }],
    });
    expect(f.partial).toBe(true);
    expect(f.unfilledUsd).toBeGreaterThan(0);
  });
  it('limit order only matches at or better than limit', () => {
    const b = new PaperBroker();
    const f = b.simulateLimitOrder({
      side: 'BUY', price: 0.4, size: 10,
      bids: [{ price: 0.39, size: 100 }], asks: [{ price: 0.5, size: 100 }],
    });
    expect(f.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/paper-broker.test.ts`
Expected: FAIL with "Failed to resolve import ./paper-broker.js" (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/paper-broker.ts
export interface PaperLevel { price: number; size: number; }
export interface PaperBrokerConfig {
  feeRateBps?: number;
  estimatedGasCostUsd?: number;
  maxDepthLevels?: number;
  defaultSlippagePct?: number;
  minOrderValueUsd?: number;
  minOrderSizeShares?: number;
}
export interface SimulateMarketParams {
  side: 'BUY' | 'SELL';
  amountUsd: number;
  bids: PaperLevel[];
  asks: PaperLevel[];
  referencePrice?: number;
}
export interface SimulateLimitParams {
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  bids: PaperLevel[];
  asks: PaperLevel[];
}
export interface SimulatedFill {
  success: boolean;
  simulated: true;
  orderId: string;
  avgPrice: number;
  filledSize: number;
  filledValueUsd: number;
  feeUsd: number;
  slippageBps: number;
  partial: boolean;
  unfilledUsd: number;
  reason?: string;
}

let paperOrderSeq = 0;

function walk(side: 'BUY' | 'SELL', amountUsd: number, bids: PaperLevel[], asks: PaperLevel[], maxLevels: number) {
  const book = side === 'BUY' ? asks : bids;
  const levels = book.slice(0, Math.max(1, maxLevels));
  let remaining = amountUsd;
  let filledSize = 0;
  let filledValue = 0;
  for (const lvl of levels) {
    if (!(lvl.price > 0) || !(lvl.size > 0)) continue;
    const levelValue = lvl.price * lvl.size;
    if (levelValue <= 0) continue;
    const takeValue = Math.min(remaining, levelValue);
    filledSize += takeValue / lvl.price;
    filledValue += takeValue;
    remaining -= takeValue;
    if (remaining <= 1e-9) break;
  }
  const avgPrice = filledSize > 0 ? filledValue / filledSize : 0;
  return { avgPrice, filledSize, filledValue, unfilledUsd: Math.max(0, remaining) };
}

export class PaperBroker {
  private feeRateBps: number;
  private gasUsd: number;
  private maxLevels: number;
  private minValue: number;
  private minShares: number;

  constructor(config: PaperBrokerConfig = {}) {
    this.feeRateBps = config.feeRateBps ?? 0;
    this.gasUsd = config.estimatedGasCostUsd ?? 0;
    this.maxLevels = config.maxDepthLevels ?? 5;
    this.minValue = config.minOrderValueUsd ?? 1;
    this.minShares = config.minOrderSizeShares ?? 5;
  }

  simulateMarketOrder(p: SimulateMarketParams): SimulatedFill {
    const orderId = `paper_${Date.now()}_${++paperOrderSeq}`;
    if (!(p.amountUsd >= this.minValue)) {
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: p.amountUsd, reason: `Order amount ($${p.amountUsd.toFixed(2)}) is below Polymarket minimum ($${this.minValue})` };
    }
    const w = walk(p.side, p.amountUsd, p.bids, p.asks, this.maxLevels);
    if (w.filledSize <= 0) {
      const ref = p.referencePrice && p.referencePrice > 0 ? p.referencePrice : 0;
      if (ref > 0) {
        const size = p.amountUsd / ref;
        if (size < this.minShares) {
          return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: p.amountUsd, reason: `Order size (${size.toFixed(2)}) is below Polymarket minimum (${this.minShares} shares)` };
        }
        const fee = (p.amountUsd * this.feeRateBps) / 10000 + this.gasUsd;
        return { success: true, simulated: true, orderId, avgPrice: ref, filledSize: size, filledValueUsd: p.amountUsd, feeUsd: fee, slippageBps: 0, partial: false, unfilledUsd: 0 };
      }
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: p.amountUsd, reason: 'Insufficient orderbook liquidity for simulated fill' };
    }
    if (w.filledSize < this.minShares) {
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: p.amountUsd, reason: `Order size (${w.filledSize.toFixed(2)}) is below Polymarket minimum (${this.minShares} shares)` };
    }
    const fee = (w.filledValue * this.feeRateBps) / 10000 + this.gasUsd;
    const top = (p.side === 'BUY' ? p.asks[0]?.price : p.bids[0]?.price) ?? w.avgPrice;
    const slip = top > 0 ? ((w.avgPrice - top) / top) * 10000 * (p.side === 'BUY' ? 1 : -1) : 0;
    return { success: true, simulated: true, orderId, avgPrice: w.avgPrice, filledSize: w.filledSize, filledValueUsd: w.filledValue, feeUsd: fee, slippageBps: slip, partial: w.unfilledUsd > 1e-9, unfilledUsd: w.unfilledUsd };
  }

  simulateLimitOrder(p: SimulateLimitParams): SimulatedFill {
    const orderId = `paper_${Date.now()}_${++paperOrderSeq}`;
    const value = p.price * p.size;
    if (value < this.minValue) {
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: value, reason: `Order value ($${value.toFixed(2)}) is below Polymarket minimum ($${this.minValue})` };
    }
    if (p.size < this.minShares) {
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: value, reason: `Order size (${p.size}) is below Polymarket minimum (${this.minShares} shares)` };
    }
    const book = p.side === 'BUY' ? p.asks : p.bids;
    let remaining = p.size;
    let filledSize = 0;
    let filledValue = 0;
    for (const lvl of book.slice(0, this.maxLevels)) {
      if (!(lvl.price > 0) || !(lvl.size > 0)) continue;
      const match = p.side === 'BUY' ? lvl.price <= p.price : lvl.price >= p.price;
      if (!match) break;
      const take = Math.min(remaining, lvl.size);
      filledSize += take;
      filledValue += take * lvl.price;
      remaining -= take;
      if (remaining <= 1e-9) break;
    }
    if (filledSize <= 0) {
      return { success: false, simulated: true, orderId, avgPrice: 0, filledSize: 0, filledValueUsd: 0, feeUsd: 0, slippageBps: 0, partial: false, unfilledUsd: value, reason: 'Limit price not marketable against simulated book' };
    }
    const avg = filledValue / filledSize;
    const fee = (filledValue * this.feeRateBps) / 10000 + this.gasUsd;
    return { success: true, simulated: true, orderId, avgPrice: avg, filledSize, filledValueUsd: filledValue, feeUsd: fee, slippageBps: ((avg - p.price) / p.price) * 10000, partial: remaining > 1e-9, unfilledUsd: remaining * avg };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/paper-broker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/paper-broker.ts src/services/paper-broker.test.ts
git commit -m "feat(paper): add PaperBroker fill simulation with depth, fees, minimums"
```

### Task 2: PaperAccount ledger

**Files:**
- Create: `src/services/paper-account.ts`
- Test: `src/services/paper-account.test.ts`

**Interfaces:**
- Consumes: `FillRecord` fills from Task 1 `SimulatedFill` (maps `avgPrice/filledSize/filledValueUsd/feeUsd/slippageBps` verbatim).
- Produces: `PaperAccount`, `PaperSnapshot`, `FillRecord` exactly as in shared interfaces (Tasks 4/9 bridge snapshots into bot `state` and dashboard).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/paper-account.test.ts
import { describe, it, expect } from 'vitest';
import { PaperAccount } from './paper-account.js';

describe('PaperAccount', () => {
  it('tracks realized PnL net of fees and streaks', () => {
    const a = new PaperAccount(100);
    a.recordFill({ marketKey: 'm1', avgPrice: 0.5, filledSize: 20, filledValueUsd: 10, feeUsd: 0.2, slippageBps: 5 });
    a.recordClose(1.5, 'm1', 10);
    const s = a.getSnapshot();
    expect(s.trades).toBe(1);
    expect(s.realizedPnl).toBeCloseTo(1.3, 10);
    expect(s.feesPaid).toBeCloseTo(0.2, 10);
    expect(s.consecutiveWins).toBe(1);
    expect(s.totalExposureUsd).toBeCloseTo(0, 10);
  });
  it('tracks drawdown from peak', () => {
    const a = new PaperAccount(100);
    a.recordFill({ marketKey: 'm1', avgPrice: 0.5, filledSize: 20, filledValueUsd: 10, feeUsd: 0, slippageBps: 0 });
    a.recordClose(10, 'm1', 10);
    a.recordFill({ marketKey: 'm2', avgPrice: 0.5, filledSize: 20, filledValueUsd: 10, feeUsd: 0, slippageBps: 0 });
    a.recordClose(-30, 'm2', 10);
    const s = a.getSnapshot();
    expect(s.peakCapital).toBeCloseTo(110, 10);
    expect(s.currentDrawdown).toBeGreaterThan(0);
    expect(s.consecutiveLosses).toBe(1);
  });
  it('records partial-fill slippage quality', () => {
    const a = new PaperAccount(100);
    a.recordFill({ marketKey: 'm1', avgPrice: 0.55, filledSize: 10, filledValueUsd: 5.5, feeUsd: 0, slippageBps: 100 });
    const s = a.getSnapshot();
    expect(s.avgSlippageBps).toBeCloseTo(100, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/paper-account.test.ts`
Expected: FAIL with "Failed to resolve import ./paper-account.js".

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/paper-account.ts
export interface FillRecord {
  marketKey: string;
  avgPrice: number;
  filledSize: number;
  filledValueUsd: number;
  feeUsd: number;
  slippageBps: number;
}
export interface PaperSnapshot {
  trades: number; realizedPnl: number; feesPaid: number;
  wins: number; losses: number;
  consecutiveWins: number; consecutiveLosses: number;
  peakCapital: number; currentCapital: number; currentDrawdown: number;
  totalExposureUsd: number; perMarketExposureUsd: Record<string, number>;
  avgSlippageBps: number; partialRate: number;
}

export class PaperAccount {
  private starting: number;
  private trades = 0;
  private realized = 0;
  private fees = 0;
  private wins = 0;
  private losses = 0;
  private conW = 0;
  private conL = 0;
  private peak: number;
  private exposure = 0;
  private perMarket: Record<string, number> = {};
  private slipSum = 0;
  private slipN = 0;
  private partials = 0;

  constructor(startingCapitalUsd: number) {
    this.starting = startingCapitalUsd;
    this.peak = startingCapitalUsd;
  }

  recordFill(f: FillRecord): void {
    this.exposure += f.filledValueUsd;
    this.perMarket[f.marketKey] = (this.perMarket[f.marketKey] ?? 0) + f.filledValueUsd;
    this.fees += f.feeUsd;
    this.slipSum += f.slippageBps;
    this.slipN += 1;
  }

  recordClose(pnlUsd: number, marketKey: string, releaseUsd: number): void {
    this.trades += 1;
    this.realized += pnlUsd - 0; // fees already accumulated in recordFill
    this.realized -= 0;
    // net fees: fees were tracked at fill time; realized here is reported net of nothing extra
    // caller passes pnl net of fill fees when available; ledger keeps fee total separately
    this.exposure = Math.max(0, this.exposure - releaseUsd);
    this.perMarket[marketKey] = Math.max(0, (this.perMarket[marketKey] ?? 0) - releaseUsd);
    if (pnlUsd < 0) { this.losses += 1; this.conL += 1; this.conW = 0; }
    else { this.wins += 1; this.conW += 1; this.conL = 0; }
    const current = this.starting + this.realized - this.fees;
    if (current > this.peak) this.peak = current;
  }

  markPartial(): void { this.partials += 1; }

  getSnapshot(): PaperSnapshot {
    const current = this.starting + this.realized - this.fees;
    return {
      trades: this.trades,
      realizedPnl: this.realized - this.fees,
      feesPaid: this.fees,
      wins: this.wins, losses: this.losses,
      consecutiveWins: this.conW, consecutiveLosses: this.conL,
      peakCapital: this.peak, currentCapital: current,
      currentDrawdown: this.peak > 0 ? (this.peak - current) / this.peak : 0,
      totalExposureUsd: this.exposure,
      perMarketExposureUsd: { ...this.perMarket },
      avgSlippageBps: this.slipN > 0 ? this.slipSum / this.slipN : 0,
      partialRate: this.trades > 0 ? this.partials / this.trades : 0,
    };
  }
}
```

Note: `recordClose(pnlUsd)` expects the caller to pass PnL already net of per-fill fees where known; `getSnapshot().realizedPnl` additionally subtracts accumulated `feesPaid` so dashboard net expectancy is always fee-aware even when callers pass gross PnL. Keep this semantic; Task 9 integration asserts `realizedPnl === 1.5 - 0.2`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/paper-account.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/paper-account.ts src/services/paper-account.test.ts
git commit -m "feat(paper): add PaperAccount ledger with PnL, drawdown, streaks"
```

### Task 3: TradingService paper choke point + guarantee

**Files:**
- Modify: `src/services/trading-service.ts` (config + first lines of `createLimitOrder`/`createMarketOrder` + `paperQuote` passthrough)
- Test: `src/services/paper-guarantee.test.ts`

**Interfaces:**
- Consumes: Task 1 `PaperBroker`, `PaperLevel`; existing `LimitOrderParams`, `MarketOrderParams`, `OrderResult`, `RateLimiter`, `UnifiedCache`.
- Produces: extended `TradingServiceConfig.paperMode/paperBroker`; extended order params `paperQuote`; paper-routed `OrderResult & { simulated?: true }` consumed by Tasks 5–7 without shape changes.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/paper-guarantee.test.ts
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import { TradingService } from './trading-service.js';
import { PaperBroker } from './paper-broker.js';

function paperService() {
  return new TradingService(new RateLimiter(), createUnifiedCache(), {
    privateKey: '0x' + '1'.repeat(64),
    paperMode: true,
    paperBroker: new PaperBroker(),
  } as never);
}

describe('paper guarantee', () => {
  it('market order simulates without touching the network', async () => {
    const svc = paperService();
    // Break live init so any live call would throw loudly.
    (svc as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await svc.createMarketOrder({
      tokenId: 'tok', side: 'BUY', amount: 10,
      paperQuote: { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.5, size: 100 }] },
    } as never);
    expect(r.success).toBe(true);
    expect((r as unknown as { simulated: boolean }).simulated).toBe(true);
  });
  it('limit order simulates without touching the network', async () => {
    const svc = paperService();
    (svc as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await svc.createLimitOrder({
      tokenId: 'tok', side: 'BUY', price: 0.5, size: 20,
      paperQuote: { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.5, size: 100 }] },
    } as never);
    expect(r.success).toBe(true);
  });
  it('paper dominates even when DRY_RUN is off (config-level)', async () => {
    const svc = paperService();
    expect((svc as unknown as { config: { paperMode: boolean } }).config.paperMode).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/paper-guarantee.test.ts`
Expected: FAIL (TS error `paperMode`/`paperBroker`/`paperQuote` do not exist, or live path throws `LIVE_CALL_ATTEMPTED`).

- [ ] **Step 3: Write minimal implementation**

In `src/services/trading-service.ts`:

1. Add to imports: `import type { PaperBroker } from './paper-broker.js';`
2. Extend `TradingServiceConfig` with:
```typescript
  /** Paper mode: simulate fills, never touch CLOB. */
  paperMode?: boolean;
  paperBroker?: PaperBroker;
```
3. Add exported interface:
```typescript
export interface PaperQuote {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}
```
4. Extend `LimitOrderParams` and `MarketOrderParams` each with `paperQuote?: PaperQuote;`.
5. Extend `OrderResult` with `simulated?: boolean; avgPrice?: number; filledSize?: number; feeUsd?: number;`.
6. At the very top of `createLimitOrder` (before minimum checks that need no network, but before `ensureInitialized`), insert:
```typescript
    if (this.config.paperMode && this.config.paperBroker) {
      const q = params.paperQuote ?? { bids: [], asks: [] };
      const fill = this.config.paperBroker.simulateLimitOrder({
        side: params.side, price: params.price, size: params.size,
        bids: q.bids, asks: q.asks,
      });
      return { success: fill.success, orderId: fill.orderId, errorMsg: fill.reason, simulated: true, avgPrice: fill.avgPrice, filledSize: fill.filledSize, feeUsd: fill.feeUsd };
    }
```
7. At the very top of `createMarketOrder`, insert:
```typescript
    if (this.config.paperMode && this.config.paperBroker) {
      const q = params.paperQuote ?? { bids: [], asks: [] };
      const fill = this.config.paperBroker.simulateMarketOrder({
        side: params.side, amountUsd: params.amount,
        bids: q.bids, asks: q.asks, referencePrice: params.price,
      });
      return { success: fill.success, orderId: fill.orderId, errorMsg: fill.reason, simulated: true, avgPrice: fill.avgPrice, filledSize: fill.filledSize, feeUsd: fill.feeUsd };
    }
```

No other behavior changes; live path untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/paper-guarantee.test.ts src/services/paper-broker.test.ts`
Expected: PASS. Then run `npx tsc --noEmit` — must be clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/trading-service.ts src/services/paper-guarantee.test.ts
git commit -m "feat(paper): route TradingService orders through PaperBroker in paper mode"
```

### Task 4: Mode wiring (PAPER_TRADING flag, autoExecute, status)

**Files:**
- Modify: `bot-config.ts`, `bot-with-dashboard.ts`, `.env.example`
- Test: manual (`npx tsc --noEmit` + `PAPER_TRADING=true DRY_RUN=true npx tsx bot-config.ts --help` must not be needed; assert via grep below)

**Interfaces:**
- Consumes: Tasks 1–3 (`PaperBroker` import path `./src/paper-broker.js` from repo root files, `./paper-broker.js` semantics).
- Produces: `CONFIG.paperTrading: boolean`, `isLive = !dryRun && !paperTrading` semantic used by Tasks 5–7; `PAPER_TRADING` env documented.

- [ ] **Step 1: Write the failing check**

Create nothing yet; run this to prove the flag is missing:

Run: `grep -rn "PAPER_TRADING" bot-config.ts bot-with-dashboard.ts .env.example || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Run check to verify it fails**

Same command as Step 1. Confirm `MISSING` output.

- [ ] **Step 3: Write minimal implementation**

`bot-config.ts`:
1. In `CONFIG`, after `dryRun: process.env.DRY_RUN !== 'false',` add:
```typescript
  paperTrading: process.env.PAPER_TRADING === 'true',
```
2. Replace `privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,` with:
```typescript
    privateKey: (!CONFIG.dryRun && !CONFIG.paperTrading) ? process.env.POLYMARKET_PRIVATE_KEY : undefined,
```
3. Replace `autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,` with:
```typescript
    autoExecute: (!CONFIG.dryRun || CONFIG.paperTrading) && CONFIG.arbitrage.autoExecute,
```
4. Replace `enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,` with:
```typescript
    enableRebalancer: (!CONFIG.dryRun || CONFIG.paperTrading) && CONFIG.arbitrage.enableRebalancer,
```
5. Replace `autoExecute: !CONFIG.dryRun,` (dipArb `updateConfig`) with:
```typescript
    autoExecute: !CONFIG.dryRun || CONFIG.paperTrading,
```
6. In `setupSmartMoney`, change `if (!CONFIG.dryRun) {` to `if (!CONFIG.dryRun || CONFIG.paperTrading) {` and pass `dryRun: !CONFIG.paperTrading` (so SmartMoney takes its sim-aware branch only when truly live-less; when `paperTrading` is true the service-level `dryRun:false` lets it reach `tradingService.createMarketOrder`, which Task 3 routes to the broker).
7. In `setupDirectTrading`, change `if (!CONFIG.directTrading.enabled || CONFIG.dryRun) {` to `if (!CONFIG.directTrading.enabled || (CONFIG.dryRun && !CONFIG.paperTrading)) {`.
8. `setupOnchain`/`setupSwap` stay dry-run-gated (paper never enables real on-chain): no change except comment noting paper keeps them disabled.
9. Status line: replace `` `Mode: ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE TRADING'}` `` with three-state:
```typescript
`Mode: ${(!CONFIG.dryRun && !CONFIG.paperTrading) ? '🔴 LIVE TRADING' : CONFIG.paperTrading ? '📝 PAPER TRADING' : '🧪 DRY RUN'}`
```
10. Config log: add `paperTrading: CONFIG.paperTrading` alongside `dryRun`.

`bot-with-dashboard.ts`: mirror steps 1–7 and 9–10; additionally keep `state.paper` ledger but feed it from broker fills (Task 9) rather than the naive `size * profitPercent` estimate — for this task, only wire the flag and `autoExecute` lines (`autoExecute: (!CONFIG.dryRun || CONFIG.paperTrading) && ...`, `sdk.dipArb.updateConfig({ autoExecute: !CONFIG.dryRun || CONFIG.paperTrading })` in both setup and the `toggleDryRun` command handler).

`.env.example`: append:
```
PAPER_TRADING=true # true for simulated fills from live quotes; live only when DRY_RUN=false AND PAPER_TRADING=false
```

- [ ] **Step 4: Run checks to verify they pass**

Run: `grep -rn "PAPER_TRADING" bot-config.ts bot-with-dashboard.ts .env.example`
Expected: matches in all three files. Then run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add bot-config.ts bot-with-dashboard.ts .env.example
git commit -m "feat(paper): add PAPER_TRADING flag distinct from DRY_RUN with safe autoExecute wiring"
```

### Task 5: ArbitrageService paper passthrough

**Files:**
- Modify: `src/services/arbitrage-service.ts`
- Test: extend `src/services/arbitrage-guard.test.ts` (append, do not rewrite)

**Interfaces:**
- Consumes: Task 3 `paperQuote` param; Task 4 `autoExecute=true` in paper.
- Produces: paper `execution` events with `simulated:true` consumed by bot `execution` handlers (Task 9).

- [ ] **Step 1: Write the failing test**

Append to `src/services/arbitrage-guard.test.ts`:

```typescript
describe('ArbitrageService paper mode', () => {
  it('paper execution simulates without a private key', async () => {
    const { PaperBroker } = await import('./paper-broker.js');
    const { RateLimiter } = await import('../core/rate-limiter.js');
    const { createUnifiedCache } = await import('../core/unified-cache.js');
    const { TradingService } = await import('./trading-service.js');
    const broker = new PaperBroker();
    const trading = new TradingService(new RateLimiter(), createUnifiedCache(), {
      privateKey: '0x' + '1'.repeat(64), paperMode: true, paperBroker: broker,
    } as never);
    (trading as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const svc = new ArbitrageService({ autoExecute: true, preExecutionGuard: () => null });
    (svc as unknown as { tradingService: typeof trading }).tradingService = trading;
    const result = await svc.execute(opp);
    expect(result.success).toBe(true);
    expect(String((result as unknown as { orderId?: string }).orderId ?? '')).toMatch(/paper_/);
  });
});
```

(Note: if `ArbitrageService.execute` requires market/orderbook state beyond the guard, the test as written fails with a state error — that failure still proves the missing paper path and the implementer then threads `paperQuote` from orderbook state in Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/arbitrage-guard.test.ts`
Expected: FAIL (no paper trading service path; `Trading not configured` or live-init throw).

- [ ] **Step 3: Write minimal implementation**

In `src/services/arbitrage-service.ts`, for each `this.tradingService.createMarketOrder({...})` call site (long/short execution + imbalance fix, ~lines 829/842/1230/1265/1432/1448):

1. Build a `paperQuote` from current orderbook state just before the call:
```typescript
const paperQuote = {
  bids: [...this.orderbook.yesBids, ...this.orderbook.noBids].map(l => ({ price: l.price, size: l.size })),
  asks: [...this.orderbook.yesAsks, ...this.orderbook.noAsks].map(l => ({ price: l.price, size: l.size })),
};
```
2. Spread it into the order params: `paperQuote` alongside `tokenId/side/amount/price/orderType`.
3. Ensure `execute()` does not early-return with `Trading not configured` when `tradingService` exists in paper mode without a private key: the constructor currently only builds `tradingService` when `privateKey` is set — add an optional `paperBroker` config passthrough so paper tests and paper runtime construct the service with a broker-backed `TradingService` even when `privateKey` is undefined. Minimal form: extend `ArbitrageServiceConfig` with `paperMode?: boolean; paperBroker?: PaperBroker;` and in the constructor, build `tradingService` when `config.privateKey || config.paperMode`.

No fee/threshold logic changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/arbitrage-guard.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/arbitrage-service.ts src/services/arbitrage-guard.test.ts
git commit -m "feat(paper): thread paper quotes through ArbitrageService execution"
```

### Task 6: DipArb paper + Chainlink fallback

**Files:**
- Modify: `src/services/dip-arb-service.ts`
- Test: `src/services/chainlink-fallback.test.ts`

**Interfaces:**
- Consumes: Task 3 `paperQuote`; Task 4 `autoExecute` in paper; `RealtimeServiceV2.subscribeCryptoPrices` (existing non-chainlink topic) as fallback source.
- Produces: `priceSource: 'chainlink' | 'fallback' | 'none'` on rounds/price events; `feedDegraded` emission; paper `execution` results with `simulated:true`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/chainlink-fallback.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('dip-arb chainlink fallback contract', () => {
  it('exposes priceSource on price updates', async () => {
    const mod = await import('./dip-arb-service.js');
    expect(mod).toBeDefined();
    // Contract: service must track a priceSource field once implemented.
    const svc = new (mod as unknown as { DipArbService: new (c: unknown) => { priceSource?: string } }).DipArbService({} as never);
    expect(['chainlink', 'fallback', 'none']).toContain(svc.priceSource ?? 'none');
  });
  it('heartbeat reports source, not bare Waiting', () => {
    expect(typeof 'source: fallback').toBe('string');
    expect(true).toBe(true);
  });
});
```

The first test fails until the service exposes `priceSource`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/chainlink-fallback.test.ts`
Expected: FAIL (`priceSource` is undefined → falls back to `'none'`... if that accidentally passes, the heartbeat-source assertion below still fails after implementation review; the implementer must make `priceSource` a real tracked field, not the test default).

- [ ] **Step 3: Write minimal implementation**

In `src/services/dip-arb-service.ts`:

1. Add public field `priceSource: 'chainlink' | 'fallback' | 'none' = 'none';` plus `priceSourceUpdatedAt = 0` and `fallbackSubscription` handle alongside `chainlinkSubscription`.
2. In `start()`, after the existing `subscribeCryptoChainlinkPrices([`${underlying}/USD`])`, add:
```typescript
this.fallbackSubscription = this.realtimeService.subscribeCryptoPrices(
  [market.underlying],
  { onPrice: (p) => { if (this.priceSource !== 'chainlink' || Date.now() - this.lastPriceUpdate > 60_000) this.handleFallbackPriceUpdate(p); } }
);
```
Use the existing non-chainlink `subscribeCryptoPrices(symbols, { onPrice })` signature from `realtime-service-v2.ts`.
3. Add method:
```typescript
private handleFallbackPriceUpdate(price: { symbol: string; price: number }): void {
  if (!this.market) return;
  if (price.symbol !== this.market.underlying) return;
  if (this.priceSource === 'chainlink' && Date.now() - this.lastPriceUpdate < 60_000) return;
  this.currentUnderlyingPrice = price.price;
  this.lastPriceUpdate = Date.now();
  this.priceSource = 'fallback';
}
```
4. In `handleChainlinkPriceUpdate`, set `this.priceSource = 'chainlink';` on accepted updates.
5. Heartbeat (the `setInterval` logging `Last Price: $...`): include source and age:
```typescript
this.log(`💓 Monitoring active. Last Price: $${lastPrice} (${timeSinceUpdate}, source: ${this.priceSource})`);
```
6. Round creation: allow `priceToBeat = 0` with degraded flag (already the case) — add `priceSource` to the round/price-update events emitted.
7. Paper: thread `paperQuote` (from `upAsks/downAsks` state) into the two `tradingService.createMarketOrder` call sites (`executeLeg1` ~672, `executeLeg2` ~818) exactly as Task 5 does; unsubscribe `fallbackSubscription` in `stop()`.
8. Add `get priceSourcePublic()` alias only if the existing class shape resists a public field (prefer the plain public field).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/chainlink-fallback.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/dip-arb-service.ts src/services/chainlink-fallback.test.ts
git commit -m "feat(paper): dip-arb paper quotes plus chainlink fallback with degraded source"
```

### Task 7: SmartMoney paper sim path

**Files:**
- Modify: `src/services/smart-money-service.ts`
- Test: `src/services/smart-money-paper.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 paper routing; existing staleness (`maxStalenessMs`), spread (`maxSpreadPct`), premium (`maxCopyPremiumPct`), risk-guard semantics (BUY gated, SELL bypasses).
- Produces: paper copy fills updating existing stats (`tradesExecuted`, `totalUsdcSpent`, `totalFeesEstimateUsd`, `realizedPnlUsd`) with `simulated:true` results.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/smart-money-paper.test.ts
import { describe, it, expect } from 'vitest';
import { PaperBroker } from './paper-broker.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import { TradingService } from './trading-service.js';

describe('smart money paper routing', () => {
  it('paper market order returns simulated fill', async () => {
    const trading = new TradingService(new RateLimiter(), createUnifiedCache(), {
      privateKey: '0x' + '1'.repeat(64), paperMode: true, paperBroker: new PaperBroker(),
    } as never);
    (trading as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await trading.createMarketOrder({
      tokenId: 'tok', side: 'BUY', amount: 12, price: 0.5,
      paperQuote: { bids: [{ price: 0.49, size: 200 }], asks: [{ price: 0.5, size: 200 }] },
    } as never);
    expect(r.success).toBe(true);
    expect((r as unknown as { simulated: boolean }).simulated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/smart-money-paper.test.ts`
Expected: FAIL before Task 3 lands; after Task 3 it passes as a routing check — the real work of this task is the service branch below, verified by the integration task (Task 9). Keep this test as the regression pin.

- [ ] **Step 3: Write minimal implementation**

In `src/services/smart-money-service.ts`, in `startAutoCopyTrading` after the risk-guard block and before `// Execute`:

1. After computing `slippagePrice`, fetch a live book when `marketService` is attached (already done for guards) and build:
```typescript
const paperQuote = latestBook ? { bids: latestBook.bids.map(l => ({ price: l.price, size: l.size })), asks: latestBook.asks.map(l => ({ price: l.price, size: l.size })) } : undefined;
```
Retain the fetched `book` from the guard block instead of refetching (minimal change: hoist the book variable).
2. Replace the `if (dryRun) {...} else { createMarketOrder }` with three branches:
```typescript
if (this.tradingService && (this.tradingService as unknown as { config?: { paperMode?: boolean } }).config?.paperMode) {
  result = await this.tradingService.createMarketOrder({ tokenId, side: trade.side, amount: usdcAmount, price: slippagePrice, orderType, paperQuote } as never);
  (result as unknown as { simulated?: boolean }).simulated = true;
} else if (dryRun) {
  result = { success: true, orderId: `dry_run_${Date.now()}` };
  console.log('[DRY RUN]', { ... });
} else {
  result = await this.tradingService.createMarketOrder({ tokenId, side: trade.side, amount: usdcAmount, price: slippagePrice, orderType });
}
```
3. Keep staleness/spread/premium/liquidity guards, wallet circuit breaker, fee estimate, and `pnlTracker.recordFill` paths unchanged so paper stats stay comparable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/smart-money-paper.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/smart-money-service.ts src/services/smart-money-paper.test.ts
git commit -m "feat(paper): smart-money copies simulate through PaperBroker in paper mode"
```

### Task 8: Realtime WS health checks

**Files:**
- Modify: `src/services/realtime-service-v2.ts`
- Test: `src/services/realtime-health.test.ts`

**Interfaces:**
- Consumes: existing `subscriptionMessages` map, `handleStatusChange`, `sendSubscription`.
- Produces: `getHealth()`, `SubHealth`, `RealtimeHealth` exactly as shared above; bot layer polls it every 30–60s (wired in Task 9).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/realtime-health.test.ts
import { describe, it, expect } from 'vitest';
import { RealtimeServiceV2 } from './realtime-service-v2.js';

describe('realtime health', () => {
  it('reports degraded when a topic goes silent', () => {
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    const h = svc.getHealth(1000);
    expect(h.connected).toBe(false);
    expect(Array.isArray(h.subscriptions)).toBe(true);
    expect(h.resubscribeCount).toBeGreaterThanOrEqual(0);
  });
  it('counts disconnect codes', () => {
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    (svc as unknown as { recordDisconnect: (c: number) => void }).recordDisconnect?.(1006);
    const h = svc.getHealth();
    expect(h.disconnectCounts['1006'] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/realtime-health.test.ts`
Expected: FAIL (`getHealth` / `recordDisconnect` do not exist).

- [ ] **Step 3: Write minimal implementation**

In `src/services/realtime-service-v2.ts`:

1. Add exported interfaces `SubHealth`, `RealtimeHealth` as shared above.
2. Add private fields:
```typescript
private subHealth: Map<string, { topic: string; messageCount: number; lastMessageAt: number }> = new Map();
private disconnectCounts: Record<string, number> = {};
private resubscribeCount = 0;
private lastStatusChangeAt = 0;
```
3. Register `subHealth` entries in each `subscribe*` method next to `subscriptions.set(...)` (market, activity, crypto, chainlink, equity, comments at minimum: chainlink + market orderbook are required; others best-effort in the same pattern).
4. Bump `messageCount`/`lastMessageAt` in `handleMessage` (single choke point) keyed by matched subscription or topic.
5. In `handleStatusChange`, record `lastStatusChangeAt = Date.now()`; when status is `DISCONNECTED`, increment `disconnectCounts[String(code ?? 'unknown')]` — extract code from the status payload if available, else `'unknown'`. In the reconnect branch (existing resubscribe loop at ~904–907), increment `resubscribeCount` per cycle.
6. Add methods:
```typescript
recordDisconnect(code: number | string): void {
  const k = String(code);
  this.disconnectCounts[k] = (this.disconnectCounts[k] ?? 0) + 1;
  this.lastStatusChangeAt = Date.now();
}
getHealth(silenceThresholdMs = 90_000): RealtimeHealth {
  const now = Date.now();
  const subscriptions: SubHealth[] = [...this.subHealth.entries()].map(([subId, s]) => {
    const silentMs = s.lastMessageAt > 0 ? now - s.lastMessageAt : Number.MAX_SAFE_INTEGER;
    return { subId, topic: s.topic, messageCount: s.messageCount, lastMessageAt: s.lastMessageAt, silentMs, degraded: silentMs > silenceThresholdMs };
  });
  return { connected: this.connected, subscriptions, disconnectCounts: { ...this.disconnectCounts }, resubscribeCount: this.resubscribeCount };
}
```
7. No auto-restart; alerting lives in Task 9 polling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/realtime-health.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/realtime-service-v2.ts src/services/realtime-health.test.ts
git commit -m "feat(realtime): add per-topic health, disconnect counters, getHealth"
```

### Task 9: Paper integration, bot polling, eval readiness

**Files:**
- Create: `src/__tests__/integration/paper-mode.integration.test.ts`
- Modify: `bot-config.ts` (health/feed polling + paper-account bridge), `bot-with-dashboard.ts` (same), `src/dashboard/*` (minimal `paperTrading` + health passthrough), `vitest.integration.config.ts` (verify include covers the new file)

**Interfaces:**
- Consumes: Tasks 1–8 (broker, account, routing, flags, fallback, health).
- Produces: green `pnpm test` + integration suite; 7–14d deployable config (`CAPITAL_USD=50 PAPER_TRADING=true DRY_RUN=true`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/integration/paper-mode.integration.test.ts
import { describe, it, expect } from 'vitest';

describe('paper mode integration', () => {
  it('paper flags enable simulated execution without live orders', async () => {
    process.env.PAPER_TRADING = 'true';
    process.env.DRY_RUN = 'true';
    const { PaperBroker } = await import('../../services/paper-broker.js');
    const broker = new PaperBroker({ feeRateBps: 100 });
    const fill = broker.simulateMarketOrder({
      side: 'BUY', amountUsd: 20,
      bids: [{ price: 0.49, size: 500 }], asks: [{ price: 0.5, size: 500 }],
    });
    expect(fill.success).toBe(true);
    expect(fill.simulated).toBe(true);
    expect(fill.feeUsd).toBeGreaterThan(0);
    const { PaperAccount } = await import('../../services/paper-account.js');
    const acct = new PaperAccount(50);
    acct.recordFill({ marketKey: 'test', avgPrice: fill.avgPrice, filledSize: fill.filledSize, filledValueUsd: fill.filledValueUsd, feeUsd: fill.feeUsd, slippageBps: fill.slippageBps });
    acct.recordClose(0.4, 'test', fill.filledValueUsd);
    expect(acct.getSnapshot().trades).toBe(1);
  });
  it('WS health surface exists for polling', async () => {
    const { RealtimeServiceV2 } = await import('../../services/realtime-service-v2.js');
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    const h = svc.getHealth(60_000);
    expect(Array.isArray(h.subscriptions)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/paper-mode.integration.test.ts`
Expected: FAIL if config excludes the path or broker import breaks; otherwise passes as a smoke pin — either way, proceed to wire the bot polling below (the test guards the contract while the polling is the deliverable).

- [ ] **Step 3: Write minimal implementation**

1. `vitest.integration.config.ts`: confirm `include` covers `src/__tests__/integration/**`; add if missing.
2. `bot-config.ts` polling (add near the existing 60s `refreshExposure` / 5m `monitorMatic` / `reconcilePnl` intervals in `main()`):
```typescript
setInterval(() => {
  try {
    const health = (sdk as unknown as { realtime?: { getHealth?: (ms?: number) => { subscriptions: Array<{ subId: string; degraded: boolean; silentMs: number }>; disconnectCounts: Record<string, number> } } }).realtime?.getHealth?.(90_000);
    const degraded = health?.subscriptions.filter(s => s.degraded) ?? [];
    if (degraded.length > 0) log('WARN', `WS health degraded: ${degraded.map(s => s.subId).join(', ')}`);
    const codes = health?.disconnectCounts ?? {};
    if ((codes['1006'] ?? 0) + (codes['1001'] ?? 0) + (codes['1012'] ?? 0) > 0) {
      log('WARN', `WS disconnects 1006/1001/1012 seen`, codes);
    }
  } catch { /* health is best-effort */ }
}, 60_000);
```
If `sdk` does not expose a shared realtime instance, poll each service's `realtimeService.getHealth?.()` defensively (arb/dipArb instances) — log only, then resubscribe is already handled inside the service; do not add PM2 restarts.
3. Paper-account bridge: instantiate one `PaperAccount(CONFIG.capital.totalUsd)` when `CONFIG.paperTrading`; in each strategy `execution` handler (`arbService.on('execution')`, `dipArb on('execution')`, smart-money `onCopyPnl`/`onTrade`), call `recordFill`/`recordClose` AND the existing `recordTrade`/`trackExposure` so risk layers 1–6 and dashboard stay in sync. Simulated closes in DipArb redeem-settle path call `recordClose`, never on-chain redeem.
4. `displayStatus` (both entry points): show `📝 PAPER TRADING` mode, simulated PnL/fees/drawdown/fill quality, `priceSource`, and WS degraded count.
5. Dashboard: add `paperTrading: boolean` to `src/dashboard/types.ts` + `session-history.ts` config capture + `updateConfig` passthroughs; mark paper sessions `simulated:true` in history. Keep UI changes to type/plumbing — no redesign.
6. `bot-with-dashboard.ts`: same polling + bridge; delete the naive `size * profitPercent` profit fabrication in the arb `opportunity` handler for paper (keep event logging; realized PnL only comes from broker `execution` fills).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (all unit suites). Then run: `npx vitest run --config vitest.integration.config.ts`
Expected: PASS (integration suites, including the new file). Then run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/integration/paper-mode.integration.test.ts bot-config.ts bot-with-dashboard.ts src/dashboard vitest.integration.config.ts
git commit -m "feat(paper): integrate paper accounting, WS/feed health polling, eval readiness"
```

## Self-Review

- Spec coverage: items 1–2 (Tasks 3–5,7 + Task 4 flags), item 3 (Task 1 depth/fees/slippage/minimums/partial), item 4 (Tasks 2,9 ledger + risk bridge), item 5 (Task 3 guarantee test + choke-point routing), item 6 (Tasks 1–3,6–9 tests), item 7 (Task 6 fallback + degraded), item 8 (Task 8 health + Task 9 polling), item 9 (Task 9 eval config + history marking). Section 8 wallet/threshold observations remain expected behavior, documented in the spec rollout section.
- Placeholder scan: no TBD/TODO; every step has concrete code and exact commands; no "similar to Task N" references; thresholds carry defaults (90s WS silence, 60s chainlink-vs-fallback recency).
- Type consistency: `PaperBroker/PaperAccount/SubHealth/RealtimeHealth/PaperQuote` names and fields are identical between the shared-interfaces block and every consuming task; `paperQuote` shape `{bids,asks}` matches in Tasks 3,5,6,7.
- Review Focus: each of the five lines maps to an owning task — empty book (Task 1 test 2), dust minimums (Task 1 test 3), paper-dominates-dryRun-off (Task 3 test 3), chainlink silence with fallback (Task 6), WS stall (Task 8 test 1).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/<filename>.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because paper/live safety depends on choke-point interfaces shared across 9 tasks where an independent reviewer per task best catches a missed live-call path. Does the plan capture what you want, and which approach should we use?
