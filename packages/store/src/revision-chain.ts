export type ChainLookup<T> = {
  byId(id: string): T | undefined;
  successorsOf(id: string): T[];
};

export const revisionChain = <T extends { id: string; supersedes: readonly string[] }>(start: T, lookup: ChainLookup<T>, createdAt: (member: T) => number): T[] => {
  const members = new Map<string, T>([[start.id, start]]);
  const pending = [start];
  for (let member = pending.pop(); member !== undefined; member = pending.pop()) {
    const neighbours = [...member.supersedes.map((id) => lookup.byId(id)), ...lookup.successorsOf(member.id)];
    for (const neighbour of neighbours) {
      if (neighbour === undefined || members.has(neighbour.id)) continue;
      members.set(neighbour.id, neighbour);
      pending.push(neighbour);
    }
  }
  const depths = new Map<string, number>();
  const depthOf = (member: T): number => {
    const known = depths.get(member.id);
    if (known !== undefined) return known;
    const predecessors = member.supersedes.flatMap((id) => members.get(id) ?? []);
    const depth = predecessors.length === 0 ? 0 : 1 + Math.max(...predecessors.map(depthOf));
    depths.set(member.id, depth);
    return depth;
  };
  return [...members.values()].sort((left, right) => depthOf(left) - depthOf(right) || createdAt(left) - createdAt(right) || (left.id < right.id ? -1 : 1));
};
