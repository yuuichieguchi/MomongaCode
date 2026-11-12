const POSIX_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGTSTP', 'SIGSTOP', 'SIGCONT', 'SIGWINCH', 'SIGUSR2']);

const WINDOWS_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGHUP', 'SIGBREAK', 'SIGWINCH']);

export const signalsOf = (platform: NodeJS.Platform): readonly NodeJS.Signals[] => (platform === 'win32' ? WINDOWS_SIGNALS : POSIX_SIGNALS);
