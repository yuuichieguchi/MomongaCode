export type Commit = () => void;

export type Prepare = () => Commit;

export const wireAll = (parts: readonly Prepare[], markWired: () => void): void => {
  const commits = parts.map((prepare) => prepare());
  for (const commit of commits) commit();
  markWired();
};
