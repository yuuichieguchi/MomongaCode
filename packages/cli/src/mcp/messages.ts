export const mcpLoginCommand = (server: string): string => `momonga mcp login ${server}`;

export const mcpAuthorizationNotice = (server: string): string => `MCP server ${server} needs authorization; run: ${mcpLoginCommand(server)}`;
