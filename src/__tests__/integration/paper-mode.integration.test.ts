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
    // recordClose takes GROSS PnL; the snapshot nets accumulated fill fees.
    expect(acct.getSnapshot().realizedPnl).toBeCloseTo(0.4 - fill.feeUsd, 10);
  });
  it('WS health surface exists for polling', async () => {
    const { RealtimeServiceV2 } = await import('../../services/realtime-service-v2.js');
    const svc = new RealtimeServiceV2({ autoReconnect: false });
    const h = svc.getHealth(60_000);
    expect(Array.isArray(h.subscriptions)).toBe(true);
  });
});
