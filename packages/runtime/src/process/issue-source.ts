import { parseIssueUrl, readIssue } from '@momonga/tools';
import type { ForgeAccess } from '@momonga/tools';
import type { IssuePort } from '../service/issues.ts';
import type { UserSnapshot } from './settings-port.ts';

export type IssueSourceOptions = {
  userSnapshot(signal: AbortSignal): Promise<UserSnapshot>;
  forgeOf(snapshot: UserSnapshot): ForgeAccess;
};

export const createIssueSource = ({ userSnapshot, forgeOf }: IssueSourceOptions): IssuePort => ({
  read: async (url, signal) => {
    const snapshot = await userSnapshot(signal);
    const location = parseIssueUrl(url);
    const content = await readIssue(location, { forge: forgeOf(snapshot), signal, boundMs: snapshot.settings.tools.operations.timeoutMs });
    return { reference: { url: location.url, repository: location.repository, number: location.number }, content };
  },
});
