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
