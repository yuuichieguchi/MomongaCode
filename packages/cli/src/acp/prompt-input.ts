import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { parseSlash } from '../tui/slash.ts';

export type PromptInput = { readonly input: string; readonly skill?: string };

const textOf = (block: ContentBlock): string => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    case 'resource': {
      if ('text' in block.resource) return `<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`;
      const mimeType = block.resource.mimeType === undefined || block.resource.mimeType === null ? '' : ` mimeType="${block.resource.mimeType}"`;
      return `<resource uri="${block.resource.uri}"${mimeType} binary="true" bytes="${Buffer.byteLength(block.resource.blob, 'base64')}" />`;
    }
    case 'image':
    case 'audio':
      throw RequestError.invalidParams({ type: block.type }, `${block.type} content is not supported by this agent`);
  }
};

export const promptInputOf = (blocks: readonly ContentBlock[], skillNames: readonly string[]): PromptInput => {
  const input = blocks.map(textOf).join('\n');
  if (input.trim() === '') throw RequestError.invalidParams(undefined, 'the prompt has no text');
  const slash = parseSlash(input);
  if (slash !== undefined && skillNames.includes(slash.name)) return { input, skill: slash.name };
  return { input };
};
