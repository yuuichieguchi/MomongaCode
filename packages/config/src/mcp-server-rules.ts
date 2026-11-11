export type McpServerScope = 'user' | 'project' | 'session';

export type McpServerUrlProblem = { code: 'unparseable' | 'scheme' | 'credentials_in_url'; message: string };

export const MCP_EXPANSION_PATTERN = /\$\{([^}]*)\}/;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const mcpServerNameProblem = (name: string): string | undefined =>
  !SERVER_NAME.test(name) || name.includes('__') || name.startsWith('_') || name.endsWith('_') ? `invalid MCP server name ${JSON.stringify(name)}; use letters, digits, "-" and single "_" only` : undefined;

const allowedSchemes = (scope: McpServerScope): readonly string[] => (scope === 'project' ? ['https:'] : ['https:', 'http:']);

const schemeName = (protocol: string): string => protocol.replace(':', '');

export const mcpServerUrlProblemOf = (url: URL, scope: McpServerScope): (McpServerUrlProblem & { code: 'scheme' | 'credentials_in_url' }) | undefined => {
  if (!allowedSchemes(scope).includes(url.protocol)) {
    return { code: 'scheme', message: `${scope}-scope MCP server URLs must use ${allowedSchemes(scope).map(schemeName).join(' or ')}; got ${schemeName(url.protocol)}` };
  }
  if (url.username !== '' || url.password !== '') return { code: 'credentials_in_url', message: 'MCP server URLs must not embed credentials; use headers or OAuth' };
  return undefined;
};

export const mcpServerUrlProblem = (text: string, scope: McpServerScope): McpServerUrlProblem | undefined => {
  if (!URL.canParse(text)) return { code: 'unparseable', message: 'the MCP server URL is not a valid URL' };
  return mcpServerUrlProblemOf(new URL(text), scope);
};
