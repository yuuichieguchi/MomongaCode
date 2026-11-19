import type { SearchRecord } from './search.ts';

export type IndexResponse = { ok: boolean; status: number; json(): Promise<unknown> };

export type FetchIndex = (url: string) => Promise<IndexResponse>;

const isRecord = (value: unknown): value is SearchRecord =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'url') === 'string' && typeof Reflect.get(value, 'title') === 'string' && typeof Reflect.get(value, 'text') === 'string';

const fetchRecords = async (fetchIndex: FetchIndex, url: string): Promise<SearchRecord[]> => {
  const response = await fetchIndex(url);
  if (!response.ok) throw new Error(`the search index ${url} answered ${response.status}`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error(`the search index ${url} is not a list of records`);
  return parsed;
};

export const indexLoader = (fetchIndex: FetchIndex, url: string): (() => Promise<SearchRecord[]>) => {
  let loading: Promise<SearchRecord[]> | undefined;
  return () => {
    loading ??= fetchRecords(fetchIndex, url).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
};
