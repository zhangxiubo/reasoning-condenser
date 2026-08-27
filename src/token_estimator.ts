import type { AnthropicMessagesResponse, NormalizedTurn } from "./types.ts";

export interface TokenEstimator {
  estimate(text: string): number;
  estimateTurn(turn: NormalizedTurn): number;
  estimateResponse(response: AnthropicMessagesResponse): number;
}

export class CharacterTokenEstimator implements TokenEstimator {
  readonly characters_per_token: number;

  constructor(characters_per_token: number) {
    this.characters_per_token = characters_per_token;
  }

  estimate(text: string): number {
    return text.length === 0 ? 0 : Math.max(1, Math.ceil([...text].length / this.characters_per_token));
  }

  estimateTurn(turn: NormalizedTurn): number {
    const tool_text = turn.tool_calls.map((call) => `${call.name}\n${JSON.stringify(call.input)}`).join("\n");
    return this.estimate([turn.reasoning, turn.text, tool_text].filter(Boolean).join("\n"));
  }

  estimateResponse(response: AnthropicMessagesResponse): number {
    return this.estimate(JSON.stringify(response.content));
  }
}
