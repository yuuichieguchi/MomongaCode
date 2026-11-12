export const NAME_SUFFIX_BYTES = 6;

export interface Random {
  float(): number;
  bytes(length: number): Uint8Array;
  hex(byteLength: number): string;
  uuid(): string;
}
