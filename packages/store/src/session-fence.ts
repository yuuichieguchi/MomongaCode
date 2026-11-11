import type { DatabaseSync } from 'node:sqlite';

export const runFenceReader = (db: DatabaseSync): ((runId: string) => string) => {
  const select = db.prepare('SELECT s.fence_nonce AS fence FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = :runId');
  return (runId) => {
    const row = select.get({ runId });
    if (row === undefined) throw new Error(`run ${runId} has no session row`);
    const { fence } = row;
    if (typeof fence !== 'string') throw new Error(`the session of run ${runId} holds no fence nonce`);
    return fence;
  };
};
