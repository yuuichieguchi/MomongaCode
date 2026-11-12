import type { IssueReference } from '@momonga/protocol';

export const ISSUE_PIN = 'issue';

export type IssueRead = { reference: IssueReference; content: string };

export type IssuePort = { read(url: string, signal: AbortSignal): Promise<IssueRead> };
