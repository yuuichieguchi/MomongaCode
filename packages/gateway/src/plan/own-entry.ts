export const ownEntry = <T>(record: Readonly<Record<string, T>>, name: string): T | undefined => (Object.hasOwn(record, name) ? record[name] : undefined);
