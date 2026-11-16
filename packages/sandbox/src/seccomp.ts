import { SandboxPolicyError } from './policy-error.ts';

export type SocketFilterArchitecture = 'x64' | 'arm64';

export type SocketFilterKind = 'no-unix-sockets' | 'named-unix-sockets';

type CallNumbers = { architecture: number; socket: number; socketpair: number; connect: number; bind: number; foreignCallsFrom: number | undefined };

const CALL_NUMBERS: Readonly<Record<SocketFilterArchitecture, CallNumbers>> = {
  x64: { architecture: 0xc000003e, socket: 41, socketpair: 53, connect: 42, bind: 49, foreignCallsFrom: 0x40000000 },
  arm64: { architecture: 0xc00000b7, socket: 198, socketpair: 199, connect: 203, bind: 200, foreignCallsFrom: undefined },
};

const IO_URING_CALLS: readonly number[] = [425, 426, 427];

const LOAD = 0x20;
const JUMP_IF_EQUAL = 0x15;
const JUMP_IF_AT_LEAST = 0x35;
const AND = 0x54;
const RETURN = 0x06;

const NUMBER_OFFSET = 0;
const ARCHITECTURE_OFFSET = 4;
const FIRST_ARGUMENT_OFFSET = 16;
const SECOND_ARGUMENT_OFFSET = 24;

const ALLOW = 0x7fff0000;
const ASK_THE_GUARD = 0x7fc00000;
const ERRNO = 0x00050000;
const NOT_PERMITTED = ERRNO | 1;
const NO_SUCH_CALL = ERRNO | 38;

const UNIX_FAMILY = 1;
const STREAM_KIND = 1;
const SEQUENCED_PACKET_KIND = 5;
const KIND_MASK = 0xf;

const INSTRUCTION_SIZE = 8;
const LONGEST_JUMP = 0xff;

type Label = 'calls' | 'dispatch' | 'unavailable' | 'guard' | 'socket' | 'pair' | 'refuse' | 'allow';

type Target = Label | 'next';

type Step = { at?: Label; code: number; value: number; whenTrue?: Target; whenFalse?: Target };

const labelled = (at: Label, step: Step): Step => ({ ...step, at });

const load = (offset: number): Step => ({ code: LOAD, value: offset });

const answer = (value: number): Step => ({ code: RETURN, value });

const jump = (code: number, value: number, whenTrue: Target, whenFalse: Target = 'next'): Step => ({ code, value, whenTrue, whenFalse });

const whenCall = (number: number, target: Label): Step => jump(JUMP_IF_EQUAL, number, target);

const stepsOf = (numbers: CallNumbers, kind: SocketFilterKind): Step[] => {
  const named = kind === 'named-unix-sockets';
  return [
    load(ARCHITECTURE_OFFSET),
    jump(JUMP_IF_EQUAL, numbers.architecture, 'calls'),
    answer(NOT_PERMITTED),
    labelled('calls', load(NUMBER_OFFSET)),
    ...(numbers.foreignCallsFrom === undefined ? [] : [jump(JUMP_IF_AT_LEAST, numbers.foreignCallsFrom, 'next', 'dispatch'), answer(NO_SUCH_CALL)]),
    labelled('dispatch', whenCall(numbers.socket, named ? 'pair' : 'socket')),
    whenCall(numbers.socketpair, 'pair'),
    ...IO_URING_CALLS.map((number) => whenCall(number, 'unavailable')),
    ...(named ? [whenCall(numbers.connect, 'guard'), whenCall(numbers.bind, 'guard')] : []),
    answer(ALLOW),
    labelled('unavailable', answer(NO_SUCH_CALL)),
    ...(named ? [labelled('guard', answer(ASK_THE_GUARD))] : [labelled('socket', load(FIRST_ARGUMENT_OFFSET)), jump(JUMP_IF_EQUAL, UNIX_FAMILY, 'refuse', 'allow')]),
    labelled('pair', load(FIRST_ARGUMENT_OFFSET)),
    jump(JUMP_IF_EQUAL, UNIX_FAMILY, 'next', 'allow'),
    load(SECOND_ARGUMENT_OFFSET),
    { code: AND, value: KIND_MASK },
    jump(JUMP_IF_EQUAL, STREAM_KIND, 'allow'),
    jump(JUMP_IF_EQUAL, SEQUENCED_PACKET_KIND, 'allow'),
    labelled('refuse', answer(NOT_PERMITTED)),
    labelled('allow', answer(ALLOW)),
  ];
};

const distanceTo = (steps: readonly Step[], from: number, target: Target | undefined): number => {
  if (target === undefined || target === 'next') return 0;
  const at = steps.findIndex((step) => step.at === target);
  const distance = at - from - 1;
  if (at < 0 || distance < 0 || distance > LONGEST_JUMP) throw new Error(`the socket filter has no forward jump to ${target} from instruction ${from}`);
  return distance;
};

export const socketFilter = (architecture: SocketFilterArchitecture, kind: SocketFilterKind): Uint8Array => {
  const steps = stepsOf(CALL_NUMBERS[architecture], kind);
  const bytes = new Uint8Array(steps.length * INSTRUCTION_SIZE);
  const view = new DataView(bytes.buffer);
  steps.forEach((step, index) => {
    const offset = index * INSTRUCTION_SIZE;
    view.setUint16(offset, step.code, true);
    view.setUint8(offset + 2, distanceTo(steps, index, step.whenTrue));
    view.setUint8(offset + 3, distanceTo(steps, index, step.whenFalse));
    view.setUint32(offset + 4, step.value, true);
  });
  return bytes;
};

export const socketFilterArchitectureOf = (architecture: string): SocketFilterArchitecture => {
  if (architecture === 'x64' || architecture === 'arm64') return architecture;
  throw new SandboxPolicyError('socket_filter_unsupported', `the Linux sandbox has no socket filter for the processor architecture ${architecture}`);
};
