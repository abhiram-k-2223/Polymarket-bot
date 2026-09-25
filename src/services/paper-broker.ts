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
