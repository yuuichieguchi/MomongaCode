import { describe, expect, it } from 'vitest';
import { SandboxPolicyError, socketFilter, socketFilterArchitectureOf } from '@momonga/sandbox';

const LOAD = 0x20;
const JUMP_IF_EQUAL = 0x15;
const JUMP_IF_AT_LEAST = 0x35;
const AND = 0x54;
const RETURN = 0x06;

const NUMBER = 0;
const ARCHITECTURE = 4;
const FIRST_ARGUMENT = 16;
const SECOND_ARGUMENT = 24;

const ALLOW = 0x7fff0000;
const ASK_THE_GUARD = 0x7fc00000;
const NOT_PERMITTED = 0x00050001;
const NO_SUCH_CALL = 0x00050026;

const UNIX_FAMILY = 1;
const STREAM = 1;
const SEQUENCED_PACKET = 5;
const KIND_MASK = 0xf;

type Instruction = readonly [code: number, jumpTrue: number, jumpFalse: number, value: number];

const decoded = (bytes: Uint8Array): Instruction[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const instructions: Instruction[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    instructions.push([view.getUint16(offset, true), view.getUint8(offset + 2), view.getUint8(offset + 3), view.getUint32(offset + 4, true)]);
  }
  return instructions;
};

const X64 = { architecture: 0xc000003e, socket: 41, connect: 42, bind: 49, socketpair: 53 };
const ARM64 = { architecture: 0xc00000b7, socket: 198, socketpair: 199, bind: 200, connect: 203 };
const IO_URING = [425, 426, 427] as const;

describe('the socket filter of the Linux sandbox', () => {
  it('for x64 with no named socket refuses a Unix socket, a datagram Unix pair, io_uring and the x32 calls, and allows the rest', () => {
    expect(decoded(socketFilter('x64', 'no-unix-sockets'))).toEqual([
      [LOAD, 0, 0, ARCHITECTURE],
      [JUMP_IF_EQUAL, 1, 0, X64.architecture],
      [RETURN, 0, 0, NOT_PERMITTED],
      [LOAD, 0, 0, NUMBER],
      [JUMP_IF_AT_LEAST, 0, 1, 0x40000000],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [JUMP_IF_EQUAL, 6, 0, X64.socket],
      [JUMP_IF_EQUAL, 7, 0, X64.socketpair],
      [JUMP_IF_EQUAL, 3, 0, IO_URING[0]],
      [JUMP_IF_EQUAL, 2, 0, IO_URING[1]],
      [JUMP_IF_EQUAL, 1, 0, IO_URING[2]],
      [RETURN, 0, 0, ALLOW],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 6, 7, UNIX_FAMILY],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 0, 5, UNIX_FAMILY],
      [LOAD, 0, 0, SECOND_ARGUMENT],
      [AND, 0, 0, KIND_MASK],
      [JUMP_IF_EQUAL, 2, 0, STREAM],
      [JUMP_IF_EQUAL, 1, 0, SEQUENCED_PACKET],
      [RETURN, 0, 0, NOT_PERMITTED],
      [RETURN, 0, 0, ALLOW],
    ]);
  });

  it('for x64 with a named socket allows a stream or sequenced-packet Unix socket and hands connect and bind to the guard', () => {
    expect(decoded(socketFilter('x64', 'named-unix-sockets'))).toEqual([
      [LOAD, 0, 0, ARCHITECTURE],
      [JUMP_IF_EQUAL, 1, 0, X64.architecture],
      [RETURN, 0, 0, NOT_PERMITTED],
      [LOAD, 0, 0, NUMBER],
      [JUMP_IF_AT_LEAST, 0, 1, 0x40000000],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [JUMP_IF_EQUAL, 9, 0, X64.socket],
      [JUMP_IF_EQUAL, 8, 0, X64.socketpair],
      [JUMP_IF_EQUAL, 5, 0, IO_URING[0]],
      [JUMP_IF_EQUAL, 4, 0, IO_URING[1]],
      [JUMP_IF_EQUAL, 3, 0, IO_URING[2]],
      [JUMP_IF_EQUAL, 3, 0, X64.connect],
      [JUMP_IF_EQUAL, 2, 0, X64.bind],
      [RETURN, 0, 0, ALLOW],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [RETURN, 0, 0, ASK_THE_GUARD],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 0, 5, UNIX_FAMILY],
      [LOAD, 0, 0, SECOND_ARGUMENT],
      [AND, 0, 0, KIND_MASK],
      [JUMP_IF_EQUAL, 2, 0, STREAM],
      [JUMP_IF_EQUAL, 1, 0, SEQUENCED_PACKET],
      [RETURN, 0, 0, NOT_PERMITTED],
      [RETURN, 0, 0, ALLOW],
    ]);
  });

  it('for arm64 with no named socket is the same program with the arm64 numbers and no x32 check', () => {
    expect(decoded(socketFilter('arm64', 'no-unix-sockets'))).toEqual([
      [LOAD, 0, 0, ARCHITECTURE],
      [JUMP_IF_EQUAL, 1, 0, ARM64.architecture],
      [RETURN, 0, 0, NOT_PERMITTED],
      [LOAD, 0, 0, NUMBER],
      [JUMP_IF_EQUAL, 6, 0, ARM64.socket],
      [JUMP_IF_EQUAL, 7, 0, ARM64.socketpair],
      [JUMP_IF_EQUAL, 3, 0, IO_URING[0]],
      [JUMP_IF_EQUAL, 2, 0, IO_URING[1]],
      [JUMP_IF_EQUAL, 1, 0, IO_URING[2]],
      [RETURN, 0, 0, ALLOW],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 6, 7, UNIX_FAMILY],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 0, 5, UNIX_FAMILY],
      [LOAD, 0, 0, SECOND_ARGUMENT],
      [AND, 0, 0, KIND_MASK],
      [JUMP_IF_EQUAL, 2, 0, STREAM],
      [JUMP_IF_EQUAL, 1, 0, SEQUENCED_PACKET],
      [RETURN, 0, 0, NOT_PERMITTED],
      [RETURN, 0, 0, ALLOW],
    ]);
  });

  it('for arm64 with a named socket hands connect and bind to the guard', () => {
    expect(decoded(socketFilter('arm64', 'named-unix-sockets'))).toEqual([
      [LOAD, 0, 0, ARCHITECTURE],
      [JUMP_IF_EQUAL, 1, 0, ARM64.architecture],
      [RETURN, 0, 0, NOT_PERMITTED],
      [LOAD, 0, 0, NUMBER],
      [JUMP_IF_EQUAL, 9, 0, ARM64.socket],
      [JUMP_IF_EQUAL, 8, 0, ARM64.socketpair],
      [JUMP_IF_EQUAL, 5, 0, IO_URING[0]],
      [JUMP_IF_EQUAL, 4, 0, IO_URING[1]],
      [JUMP_IF_EQUAL, 3, 0, IO_URING[2]],
      [JUMP_IF_EQUAL, 3, 0, ARM64.connect],
      [JUMP_IF_EQUAL, 2, 0, ARM64.bind],
      [RETURN, 0, 0, ALLOW],
      [RETURN, 0, 0, NO_SUCH_CALL],
      [RETURN, 0, 0, ASK_THE_GUARD],
      [LOAD, 0, 0, FIRST_ARGUMENT],
      [JUMP_IF_EQUAL, 0, 5, UNIX_FAMILY],
      [LOAD, 0, 0, SECOND_ARGUMENT],
      [AND, 0, 0, KIND_MASK],
      [JUMP_IF_EQUAL, 2, 0, STREAM],
      [JUMP_IF_EQUAL, 1, 0, SEQUENCED_PACKET],
      [RETURN, 0, 0, NOT_PERMITTED],
      [RETURN, 0, 0, ALLOW],
    ]);
  });

  it('every jump of every program lands inside the program, and every path ends in a return', () => {
    for (const architecture of ['x64', 'arm64'] as const) {
      for (const kind of ['no-unix-sockets', 'named-unix-sockets'] as const) {
        const program = decoded(socketFilter(architecture, kind));
        program.forEach(([code, jumpTrue, jumpFalse], index) => {
          if (code !== JUMP_IF_EQUAL && code !== JUMP_IF_AT_LEAST) return;
          expect(index + 1 + jumpTrue).toBeLessThan(program.length);
          expect(index + 1 + jumpFalse).toBeLessThan(program.length);
        });
        expect(program[program.length - 1]?.[0]).toBe(RETURN);
      }
    }
  });

  it('names the two architectures the product is released for, and refuses another with the reason', () => {
    expect(socketFilterArchitectureOf('x64')).toBe('x64');
    expect(socketFilterArchitectureOf('arm64')).toBe('arm64');
    expect(() => socketFilterArchitectureOf('riscv64')).toThrow(SandboxPolicyError);
    expect(() => socketFilterArchitectureOf('riscv64')).toThrow('the Linux sandbox has no socket filter for the processor architecture riscv64');
  });

  it('answers a call made under a foreign architecture with a refusal the caller sees, and never kills the process', () => {
    for (const architecture of ['x64', 'arm64'] as const) {
      for (const kind of ['no-unix-sockets', 'named-unix-sockets'] as const) {
        const program = decoded(socketFilter(architecture, kind));
        expect(program.slice(0, 3)).toEqual([
          [LOAD, 0, 0, ARCHITECTURE],
          [JUMP_IF_EQUAL, 1, 0, architecture === 'x64' ? X64.architecture : ARM64.architecture],
          [RETURN, 0, 0, NOT_PERMITTED],
        ]);
        expect(program.some(([code, , , value]) => code === RETURN && value === 0x80000000)).toBe(false);
      }
    }
  });
});
