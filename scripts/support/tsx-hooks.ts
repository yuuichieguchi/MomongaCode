import fs from 'node:fs/promises';
import { transform } from 'esbuild';

type LoadContext = { readonly format?: string | null | undefined };
type LoadResult = { readonly format?: string | null | undefined; readonly source?: string | ArrayBuffer | Uint8Array | undefined; readonly shortCircuit?: boolean };
type NextLoad = (url: string, context?: LoadContext) => LoadResult | Promise<LoadResult>;

export const load = async (url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> => {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
  const result = await transform(await fs.readFile(new URL(url), 'utf8'), { loader: 'tsx', format: 'esm', jsx: 'automatic', sourcefile: url });
  return { format: 'module', source: result.code, shortCircuit: true };
};
