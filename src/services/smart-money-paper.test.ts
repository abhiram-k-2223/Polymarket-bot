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
