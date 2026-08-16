// ---------------------------------------------------------------------------
// SessionGuard — the discipline layer that sits between the engine's signals
// and actually taking a trade.
//
// The raw engine recognises valid setups, but on a 1-minute chart it will
// happily re-fire the same idea five times in ten minutes and get chopped to
// death when a session grinds against the bias. That overtrading — not bad
// setup recognition — is what bleeds an intraday strategy. This guard enforces
// the rules a disciplined prop trader follows:
//
//   • a confidence floor (skip marginal reads),
//   • a hard cap on trades per session,
//   • a cooldown after a loss (don't revenge-enter the next bar),
//   • a consecutive-loss lockout (two losses in a row → done for the day).
//
// It is stateful and resets each new trading day. The backtest drives it; a
// live runner should hold one instance per symbol and drive it the same way.
// ---------------------------------------------------------------------------

export interface GuardConfig {
  minConfidence: number; // ignore signals below this confidence
  maxTradesPerSession: number; // hard cap on entries per RTH day
  maxConsecutiveLosses: number; // after this many losses in a row, stop for the day
  cooldownBarsAfterLoss: number; // wait this many bars after a loss before re-entering
  timezone: string; // timezone whose calendar day defines a "session"
}

export function defaultGuardConfig(): GuardConfig {
  return {
    minConfidence: 0.7,
    maxTradesPerSession: 3,
    maxConsecutiveLosses: 2,
    cooldownBarsAfterLoss: 15,
    timezone: "America/New_York",
  };
}

/** Wall-clock calendar date (YYYY-MM-DD) in a timezone, for bucketing sessions. */
function sessionDay(unixSeconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(unixSeconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface GuardDecision {
  ok: boolean;
  reason: string;
}

export class SessionGuard {
  private day = "";
  private trades = 0;
  private consecutiveLosses = 0;
  private lockedOut = false;
  private lastLossBar = -Infinity;

  constructor(private readonly cfg: GuardConfig = defaultGuardConfig()) {}

  private roll(time: number) {
    const d = sessionDay(time, this.cfg.timezone);
    if (d !== this.day) {
      this.day = d;
      this.trades = 0;
      this.consecutiveLosses = 0;
      this.lockedOut = false;
      this.lastLossBar = -Infinity;
    }
  }

  /** May we take this signal, at this bar? Rolls the session first. */
  canEnter(time: number, barIndex: number, confidence: number): GuardDecision {
    this.roll(time);
    if (confidence < this.cfg.minConfidence) return { ok: false, reason: `confidence ${(confidence * 100).toFixed(0)}% < floor ${(this.cfg.minConfidence * 100).toFixed(0)}%` };
    if (this.lockedOut) return { ok: false, reason: `locked out — ${this.cfg.maxConsecutiveLosses} losses in a row this session` };
    if (this.trades >= this.cfg.maxTradesPerSession) return { ok: false, reason: `session trade cap (${this.cfg.maxTradesPerSession}) reached` };
    if (barIndex - this.lastLossBar < this.cfg.cooldownBarsAfterLoss) return { ok: false, reason: `cooling down after a loss (${this.cfg.cooldownBarsAfterLoss} bars)` };
    return { ok: true, reason: "clear" };
  }

  /** Record a completed trade's result so the guard can update its state. */
  record(time: number, barIndex: number, realizedR: number) {
    this.roll(time);
    this.trades += 1;
    if (realizedR < 0) {
      this.consecutiveLosses += 1;
      this.lastLossBar = barIndex;
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) this.lockedOut = true;
    } else {
      this.consecutiveLosses = 0;
    }
  }
}
