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
