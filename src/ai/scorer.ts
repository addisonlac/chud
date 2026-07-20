import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getAnthropicClient } from "./anthropicClient.js";
import type { ScoringPayload, ScoringResponse } from "../types/index.js";

const log = childLogger("scorer");

const SCORE_TOOL = {
  name: "score_trade",
  description: "Score a proposed SOL memecoin trade based on the supplied market, sentiment, and whale data.",
  input_schema: {
    type: "object" as const,
    properties: {
      confidence: {
        type: "number",
        description: "Confidence the trade will be profitable, from 0 to 1.",
      },
      direction: { type: "string", enum: ["long", "avoid"] },
      reasoning: { type: "string", description: "Concise rationale, 2-4 sentences." },
      riskFlags: {
        type: "array",
        items: { type: "string" },
        description: "Specific red flags noticed (e.g. 'low liquidity', 'whale selling', 'no distinct catalyst').",
      },
    },
    required: ["confidence", "direction", "reasoning", "riskFlags"],
  },
};

const SYSTEM_PROMPT = `You are a risk-averse quantitative trading analyst for a Solana memecoin fund.
You are given ONE merged payload: token metadata, a token security snapshot (mint/freeze
authority status, holder concentration), candle data across 5m/1h/1d timeframes, crypto news
sentiment, and recent whale-wallet activity for the token, plus the current portfolio state.
The token has already passed a hard rug-check gate (revoked authorities, holder concentration,
liquidity floor), but weigh the security snapshot anyway — a token can clear the hard
thresholds and still look concentrated or thin relative to its peers. Score the trade
opportunity honestly — most brand-new pump.fun tokens are NOT good trades. Be skeptical of
thin liquidity, no whale interest, and manufactured hype. A confidence above 0.72 will trigger
a REAL automated buy, so do not inflate scores — your calibration is tracked against realized
outcomes over time. Always respond by calling the score_trade tool.`;

/**
 * Strategy rule #6-7: merges all pipeline data into one payload and asks
 * Claude Opus to score the trade. The caller (risk manager / orchestrator)
 * is responsible for gating execution on confidence > threshold — this
 * function only returns the model's assessment.
 */
export async function scoreTrade(payload: ScoringPayload): Promise<ScoringResponse> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: env.SCORING_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: "score_trade" },
    messages: [
      {
        role: "user",
        content: `Merged trade payload:\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Scoring model did not return a tool_use block");
  }

  const input = toolUse.input as ScoringResponse;
  const confidence = clamp(input.confidence, 0, 1);

  log.info(
    { mint: payload.token.mint, symbol: payload.token.symbol, confidence, direction: input.direction },
    "trade scored",
  );

  return {
    confidence,
    direction: input.direction,
    reasoning: input.reasoning,
    riskFlags: input.riskFlags ?? [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
