const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const textOfWire = (wire: Record<string, unknown>): string => {
  const parts: string[] = [];
  const messages = wire['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (typeof message['content'] === 'string') parts.push(message['content']);
      if (message['tool_calls'] !== undefined) parts.push(JSON.stringify(message['tool_calls']));
    }
  }
  if (wire['tools'] !== undefined) parts.push(JSON.stringify(wire['tools']));
  if (wire['response_format'] !== undefined) parts.push(JSON.stringify(wire['response_format']));
  return parts.filter((part) => part !== '').join('\n');
};
