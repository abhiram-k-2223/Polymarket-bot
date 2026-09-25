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

describe('paper fill quality (final-review Fix 2)', () => {
  it('market order threads slippageBps and partial=false on a full fill', async () => {
    const svc = paperService();
    (svc as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await svc.createMarketOrder({
      tokenId: 'tok', side: 'BUY', amount: 10,
      paperQuote: { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.5, size: 100 }] },
    } as never);
    expect(r.success).toBe(true);
    expect(typeof r.slippageBps).toBe('number');
    expect(Number.isNaN(r.slippageBps)).toBe(false);
    expect(r.partial).toBe(false);
  });
  it('thin book marks partial=true with slippage threading through', async () => {
    const svc = paperService();
    (svc as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await svc.createMarketOrder({
      tokenId: 'tok', side: 'BUY', amount: 100,
      paperQuote: { bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.5, size: 5 }] },
    } as never);
    expect(r.success).toBe(true);
    expect(r.partial).toBe(true);
    expect(typeof r.slippageBps).toBe('number');
  });
  it('limit order threads fill quality too', async () => {
    const svc = paperService();
    (svc as unknown as { ensureInitialized: () => Promise<never> }).ensureInitialized = async () => {
      throw new Error('LIVE_CALL_ATTEMPTED');
    };
    const r = await svc.createLimitOrder({
      tokenId: 'tok', side: 'BUY', price: 0.5, size: 20,
      paperQuote: { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.5, size: 100 }] },
    } as never);
    expect(r.success).toBe(true);
    expect(typeof r.slippageBps).toBe('number');
    expect(r.partial).toBe(false);
  });
  it('ledger records partial rate from marked partial fills', async () => {
    const { PaperAccount } = await import('./paper-account.js');
    const acct = new PaperAccount(50);
    acct.recordFill({ marketKey: 'm', avgPrice: 0.5, filledSize: 5, filledValueUsd: 2.5, feeUsd: 0, slippageBps: 0 });
    acct.markPartial();
    acct.recordClose(0.1, 'm', 2.5);
    expect(acct.getSnapshot().partialRate).toBeCloseTo(1, 10);
  });
});
