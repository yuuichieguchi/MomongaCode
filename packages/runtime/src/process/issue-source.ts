import { parseIssueUrl, readIssue } from '@momonga/tools';
import type { ForgeAccess } from '@momonga/tools';
import type { IssuePort } from '../service/issues.ts';
import type { UserSnapshot } from './settings-port.ts';

export type IssueSourceOptions = {
  userSnapshot(signal: AbortSignal): Promise<UserSnapshot>;
  forgeOf(snapshot: UserSnapshot): ForgeAccess;
};

export const createIssueSource = ({ userSnapshot, forgeOf }: IssueSourceOptions): IssuePort => ({
  locate: (url) => {
    const location = parseIssueUrl(url);
    return { url: location.url, repository: location.repository, number: location.number };
  },
  read: async (reference, signal) => {
    const snapshot = await userSnapshot(signal);
    return readIssue(parseIssueUrl(reference.url), { forge: forgeOf(snapshot), signal, boundMs: snapshot.settings.tools.operations.timeoutMs });
  },
});
