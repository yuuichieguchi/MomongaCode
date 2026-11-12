import type { AnyTool } from '../types.ts';
import { bashToolFor } from './bash.ts';
import type { BuiltinToolOffer } from './bash.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { bashOutputTool, killBashTool } from './jobs.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import { readOutputTool } from './read-output.ts';
import { updatePlanTool } from './update-plan.ts';
import { writeTool } from './write.ts';

export { buildSandboxPolicy } from './sandbox-policy.ts';
export type { SandboxPolicyOptions } from './sandbox-policy.ts';

export type { BuiltinToolOffer, OfferedBash } from './bash.ts';

export const createBuiltinTools = (offer: BuiltinToolOffer): AnyTool[] => [readTool, writeTool, editTool, globTool, grepTool, bashToolFor(offer), bashOutputTool, killBashTool, readOutputTool, updatePlanTool];
