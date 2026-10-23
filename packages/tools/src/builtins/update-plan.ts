import { defineTool } from '../types.ts';
import type { PlanEntry } from '../types.ts';

type UpdatePlanInput = { entries: PlanEntry[] };

export const updatePlanTool = defineTool<UpdatePlanInput>({
  name: 'UpdatePlan',
  description:
    'Records the current task plan. Send the complete list of entries every time; each entry has content, a status (pending, in_progress, completed) and a priority (high, medium, low).',
  kind: 'think',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 500 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['content', 'status', 'priority'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
  timeoutMs: 5_000,
  title: () => 'Update plan',
  subject: () => ({ kind: 'none', tool: 'UpdatePlan' }),
  execute: async (input) => ({ status: 'completed', output: `Plan updated (${input.entries.length} entries)`, plan: input.entries }),
});
