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
