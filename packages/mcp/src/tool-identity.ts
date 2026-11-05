export const mcpToolIdentity = (server: string, remoteToolName: string): string => `mcp\u0000${server}\u0000${remoteToolName}`;
