import type { IssueReference } from '@momonga/protocol';

export const ISSUE_PIN = 'issue';

export type IssueRead = { reference: IssueReference; content: string };

export type IssuePort = { locate(url: string): IssueReference; read(reference: IssueReference, signal: AbortSignal): Promise<string> };
