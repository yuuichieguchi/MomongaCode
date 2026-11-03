export const STREAM_IDLE_HEADER = 'momonga-stream-idle-ms';
export const RUN_ID_HEADER = 'momonga-run-id';
export const ROLE_HEADER = 'momonga-role';
export const HEADER_ROLES = ['reflection', 'analysis', 'classifier'] as const;
export type HeaderRole = (typeof HEADER_ROLES)[number];
export const COMPACTION_RESULT_EVENT = 'compaction';
