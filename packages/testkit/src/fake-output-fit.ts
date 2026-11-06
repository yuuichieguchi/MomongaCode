export const UNBOUNDED_OUTPUT_FIT = {
  fits: async (): Promise<boolean> => true,
  fit: async (text: string): Promise<string> => text,
};
