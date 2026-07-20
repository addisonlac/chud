import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { PortfolioSnapshot } from "../types/index.js";

const log = childLogger("portfolio");

const PAPER_STARTING_SOL_BALANCE = Number(process.env.PAPER_STARTING_SOL_BALANCE ?? 10);

/**
 * Tracks the SOL balance driving position sizing and the reserve check. In
 * paper mode this is a purely in-memory virtual balance seeded by
 * PAPER_STARTING_SOL_BALANCE; in live mode `setSolBalance` is called from
 * the on-chain balance fetched via the wallet module.
 */
export class Portfolio {
  private solBalance: number;

  constructor(startingSolBalance: number = PAPER_STARTING_SOL_BALANCE) {
    this.solBalance = startingSolBalance;
  }

  setSolBalance(balance: number): void {
    this.solBalance = balance;
  }

  getSolBalance(): number {
    return this.solBalance;
  }

  applyBuy(costSol: number): void {
    this.solBalance -= costSol;
  }

  applySell(proceedsSol: number): void {
    this.solBalance += proceedsSol;
  }

  getSnapshot(openPositionsValueUsd: number, solPriceUsd: number, openPositionCount: number): PortfolioSnapshot {
    const solValueUsd = this.solBalance * solPriceUsd;
    const totalValueUsd = solValueUsd + openPositionsValueUsd;
    const spendableSol = Math.max(0, this.solBalance - env.MIN_SOL_RESERVE);

    return {
      solBalance: this.solBalance,
      totalValueUsd,
      openPositionCount,
      reserveSol: env.MIN_SOL_RESERVE,
      availableForTradingUsd: spendableSol * solPriceUsd,
    };
  }

  logState(solPriceUsd: number): void {
    log.info({ solBalance: this.solBalance, solValueUsd: this.solBalance * solPriceUsd }, "portfolio state");
  }
}
