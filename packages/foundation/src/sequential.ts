import type { Awaitable } from './path-resolution.ts';

export const someAsync = async <T>(items: Iterable<T>, test: (item: T) => Awaitable<boolean>): Promise<boolean> => {
  for (const item of items) if (await test(item)) return true;
  return false;
};

export const everyAsync = async <T>(items: Iterable<T>, test: (item: T) => Awaitable<boolean>): Promise<boolean> => {
  for (const item of items) if (!(await test(item))) return false;
  return true;
};

export const findAsync = async <T>(items: Iterable<T>, test: (item: T) => Awaitable<boolean>): Promise<T | undefined> => {
  for (const item of items) if (await test(item)) return item;
  return undefined;
};

export const filterAsync = async <T>(items: Iterable<T>, test: (item: T) => Awaitable<boolean>): Promise<T[]> => {
  const kept: T[] = [];
  for (const item of items) if (await test(item)) kept.push(item);
  return kept;
};

export const mapAsync = async <T, R>(items: Iterable<T>, convert: (item: T) => Awaitable<R>): Promise<R[]> => {
  const converted: R[] = [];
  for (const item of items) converted.push(await convert(item));
  return converted;
};
