import type { PumpFunToken } from "../types/index.js";

/**
 * Common surface both token scanners (PumpPortal WebSocket, pump.fun HTTP)
 * expose, so the orchestrator can use either interchangeably.
 */
export interface TokenScanner {
  start(): void;
  stop(): void;
  on(event: "newToken", listener: (token: PumpFunToken) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}
