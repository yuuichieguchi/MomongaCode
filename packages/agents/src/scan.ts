import path from 'node:path';
import { homeLayout } from '@momonga/foundation';
import { attemptRead, describeUnreadable, parseSkillFile } from '@momonga/skills';
import type { SkillFileSystem } from '@momonga/skills';
import { AGENT_DIRECTORY_SEGMENTS, AGENT_FILE_SUFFIX, AGENT_NAME_MAX_LENGTH, INHERIT_MODEL, SUPPORTED_FIELDS } from './constants.ts';
import type { Mandate } from '@momonga/protocol';
import type { AgentDefinition, AgentScope } from './types.ts';

export type AgentScanRequest = { home: string; projectRoot: string; trusted: boolean };

export type AgentScanResult = { agents: AgentDefinition[]; warnings: string[] };

const byName = (left: { name: string }, right: { name: string }): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const toolsOf = (value: unknown, location: string, warnings: string[]): string[] | undefined | 'invalid' => {
  if (value === undefined || value === null) return undefined;
  const entries = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : undefined;
  if (entries === undefined || !entries.every((entry): entry is string => typeof entry === 'string')) {
    warnings.push(`Agent at ${location} was skipped: tools must be a comma-separated string or a list of strings`);
    return 'invalid';
  }
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
};

const nonEmptyStringsOf = (value: unknown): string[] | 'invalid' => {
  if (!Array.isArray(value)) return 'invalid';
  const entries = value.map((entry: unknown) => (typeof entry === 'boolean' ? String(entry) : entry));
  return entries.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') ? entries.map((entry) => entry.trim()) : 'invalid';
};

const mandateOf = (fields: Readonly<Record<string, unknown>>, location: string, warnings: string[]): Mandate | undefined | 'invalid' => {
  const { conditions, requirements, inherit } = fields;
  if (conditions === undefined && requirements === undefined && inherit === undefined) return undefined;
  const commands = conditions === undefined ? undefined : nonEmptyStringsOf(conditions);
  const texts = requirements === undefined ? undefined : nonEmptyStringsOf(requirements);
  if (commands === 'invalid' || texts === 'invalid' || (inherit !== undefined && typeof inherit !== 'boolean')) {
    warnings.push(`Agent at ${location} was skipped: conditions and requirements must be lists of non-empty strings and inherit must be true or false`);
    return 'invalid';
  }
  return {
    completion: {
      ...(commands === undefined ? {} : { conditions: commands.map((command) => ({ command, when: 'always' as const })) }),
      ...(texts === undefined ? {} : { requirements: texts }),
      ...(inherit === undefined ? {} : { inherit }),
    },
  };
};

const agentOf = async (file: string, scope: AgentScope, fileSystem: SkillFileSystem, warnings: string[]): Promise<AgentDefinition | undefined> => {
  const reading = await attemptRead(() => fileSystem.readText(file));
  if (reading.kind === 'unreadable') {
    warnings.push(`Agent at ${file} was skipped: ${describeUnreadable(reading.error)}`);
    return undefined;
  }
  const text = reading.value;
  if (text === undefined) {
    warnings.push(`Agent at ${file} was skipped: the file disappeared while scanning`);
    return undefined;
  }
  const parsed = parseSkillFile(text);
  if (parsed.kind === 'invalid') {
    warnings.push(`Agent at ${file} was skipped: ${parsed.reason}`);
    return undefined;
  }
  const { name, description, tools, model } = parsed.fields;
  if (typeof name !== 'string' || name.trim() === '') {
    warnings.push(`Agent at ${file} was skipped: the name is missing or empty`);
    return undefined;
  }
  const trimmedName = name.trim();
  if (trimmedName.length > AGENT_NAME_MAX_LENGTH || trimmedName.includes(':')) {
    warnings.push(`Agent at ${file} was skipped: the name must be at most ${AGENT_NAME_MAX_LENGTH} characters and must not contain ":"`);
    return undefined;
  }
  if (typeof description !== 'string' || description.trim() === '') {
    warnings.push(`Agent at ${file} was skipped: the description is missing or empty`);
    return undefined;
  }
  if (parsed.body === '') {
    warnings.push(`Agent at ${file} was skipped: the file has no instructions after the frontmatter`);
    return undefined;
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    warnings.push(`Agent at ${file} was skipped: model must be a non-empty string`);
    return undefined;
  }
  const toolList = toolsOf(tools, file, warnings);
  if (toolList === 'invalid') return undefined;
  const mandate = mandateOf(parsed.fields, file, warnings);
  if (mandate === 'invalid') return undefined;
  for (const field of Object.keys(parsed.fields)) {
    if (!SUPPORTED_FIELDS.has(field)) warnings.push(`Agent ${JSON.stringify(trimmedName)} at ${file} uses the field ${JSON.stringify(field)}, which is not supported and was ignored`);
  }
  const trimmedModel = typeof model === 'string' ? model.trim() : undefined;
  return {
    name: trimmedName,
    description: description.trim(),
    prompt: parsed.body,
    ...(toolList === undefined ? {} : { tools: toolList }),
    ...(trimmedModel === undefined || trimmedModel === INHERIT_MODEL ? {} : { model: trimmedModel }),
    ...(mandate === undefined ? {} : { mandate }),
    scope,
    location: file,
  };
};

export const scanAgents = async ({ home, projectRoot, trusted }: AgentScanRequest, fileSystem: SkillFileSystem): Promise<AgentScanResult> => {
  const warnings: string[] = [];
  const chosen = new Map<string, AgentDefinition>();
  const locations: { scope: AgentScope; directory: string }[] = [
    { scope: 'project', directory: path.join(projectRoot, AGENT_DIRECTORY_SEGMENTS) },
    { scope: 'user', directory: homeLayout(home).agents },
  ];
  for (const { scope, directory } of locations) {
    const listing = await attemptRead(() => fileSystem.listDirectory(directory));
    if (listing.kind === 'unreadable') {
      warnings.push(`Agents in ${directory} were skipped: ${describeUnreadable(listing.error)}`);
      continue;
    }
    const entries = listing.value;
    if (entries === undefined) continue;
    if (scope === 'project' && !trusted) {
      warnings.push(`Project agents in ${directory} were skipped because the folder is not trusted`);
      continue;
    }
    const files = entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith(AGENT_FILE_SUFFIX)).map((entry) => entry.name).sort();
    for (const fileName of files) {
      const agent = await agentOf(path.join(directory, fileName), scope, fileSystem, warnings);
      if (agent === undefined) continue;
      const existing = chosen.get(agent.name);
      if (existing === undefined) chosen.set(agent.name, agent);
      else warnings.push(`Agent ${JSON.stringify(agent.name)} at ${agent.location} was ignored because ${existing.location} takes precedence`);
    }
  }
  return { agents: [...chosen.values()].sort(byName), warnings };
};
