export const RUNS_MACOS_ARM64_ARTIFACTS = process.platform === 'darwin' && process.arch === 'arm64';

export const HAS_POSIX_SHELL = process.platform !== 'win32';
