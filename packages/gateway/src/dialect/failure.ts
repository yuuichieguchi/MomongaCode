import { UnsupportedInputError } from '../core/unsupported-input.ts';

export const RENDER_FAILURE_REASONS = ['loop', 'reject', 'polarity', 'dependency', 'written-key', 'unsatisfiable', 'ref-sibling', 'inverse-ambiguous', 'construct'] as const;

export type RenderFailureReason = (typeof RENDER_FAILURE_REASONS)[number];

export class SchemaRenderError extends UnsupportedInputError {
  readonly reason: RenderFailureReason;
  readonly tool: string | undefined;
  readonly path: string;

  constructor(reason: RenderFailureReason, tool: string | undefined, path: string, detail: string) {
    const subject = tool === undefined ? 'the schema' : `the parameters of tool "${tool}"`;
    const where = path === '' ? 'at its root' : `at ${path}`;
    super('unsupported_tool_schema', `${subject} cannot be rendered for the target (${reason}) ${where}: ${detail}`, tool === undefined ? null : `tools.${tool}.parameters`);
    this.name = 'SchemaRenderError';
    this.reason = reason;
    this.tool = tool;
    this.path = path;
  }
}
