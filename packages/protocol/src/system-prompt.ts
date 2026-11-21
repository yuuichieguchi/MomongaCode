import type { Capabilities } from './capabilities.ts';
import type { ReasoningEffort } from './capabilities.ts';
import type { OutputStyle } from './output-style.ts';

export const COMPACT_CONTEXT_WINDOW_THRESHOLD = 32_768;

export type SystemPromptContext = {
  cwd: string;
  platform: string;
  fence: string;
  tools?: 'none';
  activeTools?: readonly string[];
  capabilities?: Pick<Capabilities, 'parallelToolCalls' | 'contextWindow'>;
  effort?: ReasoningEffort;
  concise?: boolean;
  outputStyle?: OutputStyle;
};

export type SystemPromptSections = {
  stable: string;
  toolsAndAdaptation: string;
  environment: string;
};
