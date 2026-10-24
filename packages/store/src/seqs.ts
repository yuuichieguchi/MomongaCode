export const hasConsistentSeqs = (history: readonly unknown[], nextItemSeq: unknown, summary: unknown): boolean => {
  const seqs = history.map((entry) => (entry as { seq: number }).seq);
  if (!seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number))) return false;
  if (!Number.isInteger(nextItemSeq) || (nextItemSeq as number) < 1) return false;
  if (seqs.length > 0 && (nextItemSeq as number) <= (seqs[seqs.length - 1] as number)) return false;
  if (summary !== undefined && seqs.length > 0 && (summary as { replacedThroughSeq: number }).replacedThroughSeq >= (seqs[0] as number)) return false;
  return true;
};
