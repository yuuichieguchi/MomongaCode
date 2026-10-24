export type OmitUndefined<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export const omitUndefined = <T extends object>(object: T): OmitUndefined<T> =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as OmitUndefined<T>;
