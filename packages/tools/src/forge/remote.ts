import { ToolExecutionError } from '../types.ts';

export type RemoteLocation = { host: string; repo: string };

const SCP_FORM = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/;

const repoOf = (pathname: string): string => pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');

export const parseRemoteUrl = (url: string): RemoteLocation => {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.host === '') throw new ToolExecutionError(`the remote URL ${trimmed} names no host`);
    return { host: parsed.host, repo: repoOf(decodeURIComponent(parsed.pathname)) };
  }
  const scp = SCP_FORM.exec(trimmed);
  if (scp !== null) return { host: scp[1] as string, repo: repoOf(scp[2] as string) };
  throw new ToolExecutionError(`the remote URL ${trimmed} is a local path, not a hosted repository`);
};

export type HostedRemote = { hostname: string; repo: string };

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_SCHEME = 'file:';

const hostnameOf = (host: string): string => new URL(`https://${host}`).hostname;

export const hostedRemoteOf = (url: string): HostedRemote | undefined => {
  const trimmed = url.trim();
  if (URL_FORM.test(trimmed)) {
    const parsed = new URL(trimmed);
    return parsed.protocol === LOCAL_SCHEME || parsed.hostname === '' ? undefined : { hostname: hostnameOf(parsed.host), repo: repoOf(decodeURIComponent(parsed.pathname)) };
  }
  const scp = SCP_FORM.exec(trimmed);
  return scp === null ? undefined : { hostname: hostnameOf(scp[1] as string), repo: repoOf(scp[2] as string) };
};

export const splitRepository = (repo: string): { owner: string; name: string } => {
  const index = repo.lastIndexOf('/');
  if (index <= 0 || index === repo.length - 1) throw new ToolExecutionError(`the repository path ${repo} needs an owner and a name`);
  return { owner: repo.slice(0, index), name: repo.slice(index + 1) };
};
