const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const textOfWire = (wire: Record<string, unknown>): string => {
  const parts: string[] = [];
  const messages = wire['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const content = message['content'];
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const part of content) if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') parts.push(part['text']);
      }
      if (message['tool_calls'] !== undefined) parts.push(JSON.stringify(message['tool_calls']));
    }
  }
  const system = wire['system'];
  if (typeof system === 'string') parts.push(system);
  else if (Array.isArray(system)) {
    for (const block of system) if (isRecord(block) && typeof block['text'] === 'string') parts.push(block['text']);
  }
  if (wire['tools'] !== undefined) parts.push(JSON.stringify(wire['tools']));
  if (wire['response_format'] !== undefined) parts.push(JSON.stringify(wire['response_format']));
  return parts.filter((part) => part !== '').join('\n');
};
