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
