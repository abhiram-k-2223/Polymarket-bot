# Paper-Trading Execution Mode — Design Spec

Date: 2026-09-25
Status: draft (pending user review)
Source: SESSION_HANDOFF.md sections 7, 8, 9

## 1. Intent and success criteria

Outcome: a true paper-execution mode that simulates fills from live
orderbook quotes without ever submitting real orders, so a 7–14 day
deployment produces credible strategy evidence instead of zero trades.

What the requester said:
- Section 7 root cause: `DRY_RUN=true` disables execution by design
  (`bot-config.ts` ~595 smart-money, ~637 arb, ~676 dipArb, ~716 onchain,
  ~761 swap, ~898 direct; `dip-arb-service.ts` 1662–1675 manual-signal
  return; `arbitrage-service.ts` 1375–1383 `autoExecute` gate).
- Section 8 secondary issues: Chainlink heartbeat stuck at
  `$Waiting (Never)`; WS disconnect/reconnect codes 1006/1001/1012;
  CLOB API key derivation failure for throwaway wallet (harmless in
  dry-run); Smart Money 0 qualifying wallets under strict filters;
  Arb scans with no opportunities above threshold.
- Section 9 goal: items 1–9 (separate paper flag, sim fills for all
  strategies, realistic fill modeling, simulated accounting, hard
  no-live-orders guarantee, tests, Chainlink fix/isolate, WS health,
  7–14 day eval on trades / net expectancy / max drawdown /
  fill quality / volatile behavior).

Assumptions (confirmed 2026-09-25):
- `PAPER_TRADING` and `DRY_RUN` are independent flags; live only when
  `DRY_RUN=false AND PAPER_TRADING=false`.
- Scope is all 9 items now (not phased).
- Fill fidelity is orderbook depth + fees + slippage + minimums +
  partial fills (not mid-price shortcut).

Success criteria:
- With `DRY_RUN=true PAPER_TRADING=true`, DipArb / arbitrage /
  Smart Money / direct-trading paths emit simulated `execution` events
  and update PnL/exposure/fees/drawdown/streaks.
- Static + runtime guarantee: paper mode never calls
  `createAndPostOrder` / `createAndPostMarketOrder` or on-chain
  split/merge/redeem/swap with real signers.
- Chainlink outage no longer blocks orderbook DipArb rotation;
  feed source and staleness are visible.
- WS stalls / disconnect bursts are detected, counted, resubscribed,
  and surfaced in logs + status + dashboard.
- Unit + integration tests cover sim math, accounting, guarantee,
  Chainlink fallback, and WS health.

Non-goals:
- No live trading, no `DRY_RUN=false` with real capital.
- No new strategies, no tuning of profit thresholds or wallet filters
  beyond what paper evidence demands later.
- No PM2 auto-restart on WS failure (alert + resubscribe only).

## 2. Architecture (Approach A: central PaperBroker)

Rejected alternatives:
- B (per-strategy sim branches): duplicates fill math 4×, guarantee is
  by convention rather than a choke point.
- C (reuse `src/backtest/replay.ts` as live engine): historical-bar
  oriented, not live-book/latency/partial-fill aware; adaptation cost
  >= new broker with worse fit.

Selected: a central simulation boundary at the order-submission choke
point plus a paper account ledger.

Components:

1. `src/services/paper-broker.ts` (new)
   - `PaperBrokerConfig`: `feeRateBps`, `estimatedGasCostUsd`,
     `maxDepthLevels`, `slippagePct`, `simulatedLatencyMs`,
     `minOrderValueUsd` (1.0), `minOrderSizeShares` (5),
     `minTradeValueUsd` (dipArb 1.5 buffer).
   - `simulateMarketFill({ side, amountUsd, bids, asks, ... })`:
     walks depth up to `maxDepthLevels`, computes VWAP, applies taker
     fee + gas, enforces minimums, models partial fills (fills what
     depth allows, reports remainder/unfilled), applies artificial
     latency before resolving.
   - `simulateLimitFill({ side, price, size, bids, asks, ... })`:
     same depth walk but only matches resting liquidity at or better
     than limit; remainder marked unfilled (no live resting).
   - Returns `OrderResult`-compatible shape plus
     `{ simulated: true, avgPrice, filledSize, filledValueUsd, feeUsd,
       slippageBps, partial: boolean }` so existing `execution`
     handlers work unchanged.
   - Pure fill math (no I/O, no logging) for unit testing.

2. `src/services/paper-account.ts` (new)
   - Ledger: `realizedPnl`, `feesPaid`, `grossPnl`, `tradeCount`,
     `wins/losses`, `consecutiveWins/Losses`, `peakCapital`,
     `currentDrawdown`, `totalExposureUsd`, `perMarketExposureUsd`,
     `fillQuality` (requested vs VWAP slippage per fill).
   - Methods: `recordFill(fill, marketKey)`, `recordClose(pnl)`,
     `getSnapshot()`. Bot layer bridges this into existing
     `recordTrade()` / `canTrade()` / dashboard `state-emitter`
     so risk layers 1–6 keep working on simulated state.

3. `TradingService` paper routing (modified)
   - New `paperMode: boolean` + injected broker. First lines of
     `createLimitOrder` / `createMarketOrder`:
     `if (this.paperMode) return this.paperBroker.simulate*(...)`.
     No CLOB client initialization required in paper; live client path
     untouched. Unit test uses a throwing CLOB mock to prove no live
     call is reachable.

4. `bot-config.ts` mode wiring (modified)
   - `CONFIG.paperTrading = process.env.PAPER_TRADING === 'true'`.
   - `isLive = !CONFIG.dryRun && !CONFIG.paperTrading`.
   - `setupArbitrage`: `autoExecute: (!CONFIG.dryRun || CONFIG.paperTrading)
     && CONFIG.arbitrage.autoExecute`; pass `paperMode` + broker into
     `ArbitrageService` (or its `TradingService`).
   - `setupDipArb`: `autoExecute: !CONFIG.dryRun || CONFIG.paperTrading`;
     same broker injection via `sdk.dipArb`.
   - `setupSmartMoney`: start `startAutoCopyTrading` when
     `!CONFIG.dryRun || CONFIG.paperTrading`; in paper, copy fills go
     through broker (live re-quotes + spread/premium guards retained,
     order submission simulated).
   - `setupDirectTrading`: run trend loop in paper via sim (currently
     returns early on `dryRun`).
   - `setupOnchain` / `setupSwap`: remain disabled in paper (no real
     split/merge/redeem/swap). DipArb `redeem` settle path in paper is
     accounted as simulated close, never an on-chain tx.
   - `displayStatus`: show `PAPER` mode distinctly from `DRY RUN` /
     `LIVE`; include simulated PnL, fees, drawdown, fill quality,
     feed/WS health.

5. Strategy service changes (minimal)
   - `ArbitrageService`, `DipArbService`, `SmartMoneyService`: accept
     optional paper broker / paperMode flag; keep `autoExecute`,
     `preExecutionGuard` (riskGuard), cooldown, and event shapes
     unchanged. No per-strategy fill-math duplication.

## 3. Data flow

Live WS orderbook / trade feed → strategy signal (`opportunity`,
`signal`, copy-trade trigger) → `riskGuard` (`canOpenPosition`,
layers 1–6, exposure caps) → paper check:
- paper: `PaperBroker.simulate*` from current book snapshot →
  `paper-account.recordFill` → existing `execution` emit →
  `recordTrade` + dashboard update.
- live (both flags false): unchanged current path.

Risk guards run BEFORE simulation so blocked trades never create
simulated fills (preserves exposure-cap and loss-streak semantics).

## 4. Chainlink fix / isolate (item 7)

Problem: `DipArbService.start` subscribes to
`crypto_prices_chainlink` with symbol `${underlying}/USD`; heartbeat
(`dip-arb-service.ts` 425–431) reports `$Waiting (Never)` when no
matching `cryptoChainlinkPrice` arrives. `handleChainlinkPriceUpdate`
(1146) drops non-matching symbols. Rounds fall back to
`priceToBeat = 0`, degrading underlying-price features.

Fix:
- Subscribe to both `crypto_prices_chainlink` (`ETH/USD`) and
  fallback `crypto_prices` (`ETH`) plus Binance kline last-close.
- Accept fallback updates in `handleChainlinkPriceUpdate` (or a new
  `handleFallbackPriceUpdate`); tag round/price events with
  `priceSource: 'chainlink' | 'fallback' | 'none'` and
  `priceStale: boolean`.
- Orderbook dip detection and rotation never block on missing
  underlying price; underlying-change features marked degraded.
- Heartbeat logs source + age (`source: chainlink|fallback|waiting`,
  `age: Ns`); emit `feedDegraded` when no update for N minutes
  (default 5) for dashboard/log alerting.
- Unit test: chainlink absent + fallback present → rounds proceed
  with `priceSource: 'fallback'`; both absent → `priceSource: 'none'`,
  rotation continues, degraded flag set.

## 5. WS health checks and alerts (item 8)

Problem: frequent `1006/1001/1012` disconnect/reconnect; current
`RealtimeServiceV2` resubscribes via `subscriptionMessages` (904–907)
on reconnect but has no per-topic stall detection or health surface.

Fix (in `RealtimeServiceV2` + bot layer):
- Track per-subscription `lastMessageAt`, `messageCount`,
  `lastDisconnectCode`, `disconnectCounts: Record<code, number>`,
  `resubscribeCount`.
- `getHealth(): { subscriptions: [...], connected, lastStatusChange,
  disconnectBurst: boolean }`; emit `health` / `degraded` events.
- `handleStatusChange` (916) records codes and timestamps; on
  `CONNECTED`, verify resubscription count matches
  `subscriptionMessages.size`, log any missing topics.
- Bot polls `getHealth()` every 30–60s (`refreshExposure` cadence):
  silent active subscription > threshold (e.g. 3× expected interval)
  or disconnect burst → `WARN` log + `sendSubscription` retry +
  `wsReconnects` counter in `displayStatus` + dashboard `/health`.
- No PM2 restart; alert + resubscribe only.
- Unit test with fake timers: stalled topic → `degraded:true`;
  disconnect burst → counters increment; reconnect → resubscribe
  attempted.

## 6. Accounting and risk integration (item 4)

- Simulated fills update `paper-account` AND existing bot `state`
  (`dailyPnL`, `monthlyPnL`, `totalPnL`, streaks, `arbProfit`,
  `totalExposureUsd` / `perMarketExposureUsd`) via `recordTrade` /
  `trackExposure` / `releaseExposure` so `canTrade`,
  `shouldPauseForLossStreak`, `checkExposure`, drawdown, and monthly /
  total loss limits behave identically in paper and live.
- Fees and gas are costs in PnL (net expectancy after fees/slippage
  is the eval metric, not gross edge).
- Dust handling: sized value below `minOrderUsd` / Polymarket
  minimums → skip trade with reason (reuse `calculatePositionSize`
  floor semantics); partial fills reduce exposure by filled amount
  only; unfilled remainder logged with slippage/liquidity reason.
- Dashboard `state-emitter` / `session-history` include
  `simulated: true` marker, fees, slippage, price source, WS health
  so paper vs live is never ambiguous.

## 7. Testing (item 6)

- `src/services/paper-broker.test.ts`: VWAP across levels, fee/gas
  deduction, minimum enforcement, partial-fill math, limit-price
  matching, latency hook, `simulated:true` shape.
- `src/services/paper-account.test.ts`: realized PnL net of fees,
  peak/drawdown, win/loss streaks, exposure add/release, fill-quality
  stats.
- `src/services/paper-guarantee.test.ts`: paper-mode
  `TradingService` with throwing CLOB mock; assert zero live calls
  across market/limit/cancel paths; assert on-chain service not
  constructed in paper.
- `src/services/chainlink-fallback.test.ts` + `realtime-health.test.ts`
  as described in sections 4–5.
- `src/__tests__/integration/paper-mode.integration.test.ts`:
  `PAPER_TRADING=true DRY_RUN=true`; Arb + DipArb + SmartMoney emit
  simulated executions; no network order submission (mocked CLOB).
- Acceptance: `pnpm test` (vitest) green; `tsc --noEmit` clean.

## 8. Rollout and eval (item 9)

- Env: `CAPITAL_USD=50 PAPER_TRADING=true DRY_RUN=true` (VM `.env`,
  `600` perms; no secrets in docs/commits).
- Deploy existing branch + paper changes; PM2 `polymarket-paper`;
  keep e2-micro / 30GB free-tier constraints.
- Run 7–14 days; collect from dashboard/session-history:
  simulated trade count, net expectancy after fees/slippage,
  max drawdown, fill/execution quality (slippage, partial rate),
  behavior in volatile periods, feed/WS degradation windows.
- Do NOT set `DRY_RUN=false` with real capital until paper evidence
  passes review. Section 8 items 3–5 (throwaway wallet CLOB keys,
  strict Smart Money filters yielding 0 wallets, arb threshold with
  0 opps) remain expected in paper until a funded/registered wallet
  and threshold review — they do not block paper sim.

## 9. Safety constraints

- Preserve hard guarantee: paper never calls live order submission
  or real on-chain transactions (enforced by choke-point routing +
  tests, not by convention).
- No private keys or RPC URLs in docs, issues, commits, or chat.
- No `.env` commits. GCP Always Free limits unless explicitly
  approved otherwise.

## 10. File touch list (expected)

- New: `src/services/paper-broker.ts`,
  `src/services/paper-broker.test.ts`,
  `src/services/paper-account.ts`,
  `src/services/paper-account.test.ts`,
  `src/services/paper-guarantee.test.ts`,
  `src/services/chainlink-fallback.test.ts`,
  `src/services/realtime-health.test.ts`,
  `src/__tests__/integration/paper-mode.integration.test.ts`,
  `docs/superpowers/specs/2026-09-25-paper-trading-design.md` (this file).
- Modified: `bot-config.ts`, `bot-with-dashboard.ts` (if it duplicates
  mode wiring), `.env.example` (`PAPER_TRADING` docs),
  `src/services/trading-service.ts`,
  `src/services/arbitrage-service.ts`,
  `src/services/dip-arb-service.ts`,
  `src/services/smart-money-service.ts`,
  `src/services/realtime-service-v2.ts`,
  dashboard health/status surface (`src/dashboard/*` as needed).

## Spec self-review

- Placeholder scan: no TBD/TODO; thresholds that need runtime tuning
  (WS silence threshold, feed-degraded timeout, simulated latency
  range) are named with defaults in sections 4–5 and section 2 config.
- Consistency: single-broker guarantee matches test plan; risk layers
  run pre-simulation in both data-flow and accounting sections;
  on-chain stays disabled in paper in both sections 2 and 8.
- Scope: single implementation plan; live-trading enablement and
  strategy retuning explicitly out of scope.
- Ambiguity: mode truth table explicit (`isLive = !dryRun &&
  !paperTrading`); sim return shape explicit; degraded (not blocked)
  behavior explicit for missing Chainlink.
