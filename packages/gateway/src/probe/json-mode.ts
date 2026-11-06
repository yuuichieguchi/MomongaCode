import { readJsonReply } from '@momonga/foundation';
import type { AdapterRequest, JsonMode, JsonModeProbeState } from '@momonga/protocol';

export type JsonModeAnswer = { kind: 'complete'; text: string } | { kind: 'unsupported' } | { kind: 'failure' };

export const JSON_MODE_PROBE_PROMPT = 'Reply in JSON: one object whose key "ok" is true.';

export const JSON_MODE_PROBE_REQUEST: AdapterRequest = {
  model: 'probe',
  input: [{ type: 'message', role: 'user', content: JSON_MODE_PROBE_PROMPT }],
  text: { format: { type: 'json_object' } },
};

export const jsonModeStateOf = (answer: JsonModeAnswer): JsonModeProbeState => {
  if (answer.kind === 'unsupported') return 'refused';
  if (answer.kind === 'failure') return 'unmeasured';
  return 'value' in readJsonReply(null, { text: answer.text, path: 'enforced' }) ? 'accepted' : 'refused';
};

export const measureJsonMode = async (ask: () => Promise<JsonModeAnswer>, signal: AbortSignal | undefined): Promise<JsonModeProbeState> => {
  try {
    return jsonModeStateOf(await ask());
  } catch {
    signal?.throwIfAborted();
    return 'unmeasured';
  }
};

export const jsonModeCapabilityOf = (state: JsonModeProbeState | undefined): { jsonMode?: JsonMode } => {
  if (state === 'accepted') return { jsonMode: 'json_object' };
  if (state === 'refused') return { jsonMode: 'none' };
  return {};
};
