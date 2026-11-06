import { createHash } from 'node:crypto';

export const TOOL_OUTPUT_TAG = 'tool_output';

const BOUNDARY_FIRST_LENGTH = 8;
const BOUNDARY_STEP = 2;

export type ToolOutputEnvelope = { content: string; callId: string; tool: string };

export const boundaryOf = (content: string): string => {
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  for (let length = BOUNDARY_FIRST_LENGTH; length <= digest.length; length += BOUNDARY_STEP) {
    const boundary = digest.slice(0, length);
    if (!content.includes(boundary)) return boundary;
  }
  throw new Error('a tool output contains its own full sha256, so no boundary can be derived from it');
};

export const envelopeOf = ({ content, callId, tool }: ToolOutputEnvelope): string => {
  const boundary = boundaryOf(content);
  return `<${TOOL_OUTPUT_TAG} call="${callId}" tool="${tool}" boundary="${boundary}">\n${content}\n</${TOOL_OUTPUT_TAG} boundary="${boundary}">`;
};
