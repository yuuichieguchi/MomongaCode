export interface ProcessInspector {
  startTimeOf(pid: number): Promise<number | undefined>;
  holdersOf(marker: string): Promise<number[]>;
  groupsOf(pids: readonly number[], candidateGroups: readonly number[]): Promise<Map<number, number>>;
}

export const isErrno = (error: unknown, ...codes: string[]): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && codes.includes(code);
};
