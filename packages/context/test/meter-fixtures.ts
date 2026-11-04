import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import type { CountTokensRequest, CountTokensResult, ErrorShape, FunctionTool, InputItem } from '@momonga/protocol';
import { createTokenMeter } from '@momonga/context';
import type { TokenCounter, TokenMeter } from '@momonga/context';
import { MODEL, capabilitiesFor } from './helpers.ts';
import type { CapabilityOverride } from '@momonga/protocol';

export const piece = (name: string, tokens: number): InputItem => ({ type: 'message', role: 'user', content: `${name}#${tokens}` });

export const imagePiece = (name: string, tokens: number): InputItem => ({ type: 'message', role: 'user', content: `image:${name}#${tokens}` });

export const toolOf = (name: string, tokens: number): FunctionTool =>
  ({ type: 'function', name, description: `#${tokens}`, parameters: { type: 'object' } }) as unknown as FunctionTool;

const weightOf = (text: string): number => Number(text.slice(text.lastIndexOf('#') + 1));

const textOf = (item: InputItem): string => {
  const content = (item as { content?: unknown }).content;
  if (typeof content !== 'string') throw new Error('meter fixtures count only string message pieces');
  return content;
};

export const isImagePiece = (item: InputItem): boolean => textOf(item).startsWith('image:');

export type PieceCounterOptions = {
  method: CountTokensResult['method'];
  shape: ErrorShape;
  extra?: (input: readonly InputItem[]) => number;
};

export type PieceCounter = TokenCounter & { calls: CountTokensRequest[] };

export const pieceCounter = ({ method, shape, extra }: PieceCounterOptions): PieceCounter => {
  const calls: CountTokensRequest[] = [];
  return {
    calls,
    count: async (request) => {
      calls.push(request);
      const input = typeof request.input === 'string' ? [] : request.input;
      const tokens =
        input.reduce((sum, item) => sum + weightOf(textOf(item)), 0) +
        (request.tools ?? []).reduce((sum, tool) => sum + weightOf(tool.description ?? '#0'), 0) +
        (extra?.(input) ?? 0);
      const withImage = input.some(isImagePiece);
      const replyShape = withImage ? ESTIMATED_ERROR_SHAPE : shape;
      return { input_tokens: tokens, method: withImage ? 'estimated' : method, error_bound: errorBoundOfShape(replyShape, tokens), error_shape: replyShape };
    },
  };
};

export const meterOf = (counter: TokenCounter, contextWindow: number, override: CapabilityOverride = {}): TokenMeter =>
  createTokenMeter({ counter, model: MODEL, capabilities: capabilitiesFor(contextWindow, override) });

export const EXACT: PieceCounterOptions = { method: 'exact', shape: { ratio: 0, minimum: 0 } };

export const ESTIMATED: PieceCounterOptions = { method: 'estimated', shape: ESTIMATED_ERROR_SHAPE };
