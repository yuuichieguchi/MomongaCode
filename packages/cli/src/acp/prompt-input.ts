import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { escapeXmlAttribute, escapeXmlText } from '@momonga/protocol';
import { SkillInvocationError, skillInvocationOf } from '../run/skill-invocation.ts';

export type PromptInput = { readonly input: string; readonly skill?: string };

const textOf = (block: ContentBlock): string => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    case 'resource': {
      const uri = escapeXmlAttribute(block.resource.uri);
      if ('text' in block.resource) return `<resource uri="${uri}">\n${escapeXmlText(block.resource.text)}\n</resource>`;
      const mimeType = block.resource.mimeType === undefined || block.resource.mimeType === null ? '' : ` mimeType="${escapeXmlAttribute(block.resource.mimeType)}"`;
      return `<resource uri="${uri}"${mimeType} binary="true" bytes="${Buffer.byteLength(block.resource.blob, 'base64')}" />`;
    }
    case 'image':
    case 'audio':
      throw RequestError.invalidParams({ type: block.type }, `${block.type} content is not supported by this agent`);
  }
};

export const promptInputOf = (blocks: readonly ContentBlock[], skillNames: readonly string[]): PromptInput => {
  const input = blocks.map(textOf).join('\n');
  if (input.trim() === '') throw RequestError.invalidParams(undefined, 'the prompt has no text');
  try {
    return skillInvocationOf(input, skillNames);
  } catch (error) {
    if (error instanceof SkillInvocationError) throw RequestError.invalidParams(undefined, error.message);
    throw error;
  }
};
