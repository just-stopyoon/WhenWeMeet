import type { Room } from '../lib/meeting';
import type {
  MeetingError,
  MeetingRequest,
  MeetingResponse,
  MeetingSnapshot,
  RoomRequest,
} from '../lib/meeting-contract';

// Compile-only checks: an accidentally widened contract must fail typecheck.
// These do not suppress compiler errors or replace malformed-input HTTP tests.
type Assignable<Source, Target> = [Source] extends [Target] ? true : false;
type Not<Value extends boolean> = Value extends true ? false : true;
type Assert<Value extends true> = Value;
type RequestOf<Type extends MeetingRequest['type']> = Extract<
  MeetingRequest,
  { type: Type }
>;

export type RequestContractChecks = [
  Assert<
    Assignable<
      { type: 'schedule'; roomId: string; slots: readonly ['2026-10-05|점심'] },
      MeetingRequest
    >
  >,
  Assert<
    Assignable<
      {
        type: 'vote';
        roomId: string;
        choices: readonly ['연남'];
        round: number;
      },
      MeetingRequest
    >
  >,
  Assert<
    Assignable<{ type: 'confirm'; roomId: string; value: true }, MeetingRequest>
  >,
  Assert<
    Assignable<
      { type: 'confirm'; roomId: string; value: false; regionRevision: null },
      MeetingRequest
    >
  >,
  Assert<
    Assignable<{ type: 'date'; roomId: string; slot: string }, MeetingRequest>
  >,
  Assert<Not<Assignable<{ type: 'unsupported' }, MeetingRequest>>>,
  Assert<Not<Assignable<{ type: 'close' }, MeetingRequest>>>,
  Assert<
    Not<
      Assignable<
        { type: 'confirm'; roomId: string; value: 'true' },
        MeetingRequest
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        { type: 'vote'; roomId: string; choices: readonly string[] },
        MeetingRequest
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        { type: 'schedule'; roomId: string; slots: string },
        MeetingRequest
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        { type: 'date'; roomId: string; slot: string; manual: 'true' },
        MeetingRequest
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        {
          type: 'addLink';
          roomId: string;
          url: string;
          name: string;
          category: 'other';
        },
        MeetingRequest
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        { type: 'addLink'; roomId: string; url: string; category: 'food' },
        MeetingRequest
      >
    >
  >,
  Assert<Assignable<RequestOf<'create'>, RoomRequest>>,
  Assert<Assignable<RequestOf<'join'>, RoomRequest>>,
  Assert<Not<Assignable<RequestOf<'login'>, RoomRequest>>>,
  Assert<Not<Assignable<RequestOf<'logout'>, RoomRequest>>>,
];

export type ResponseContractChecks = [
  Assert<Assignable<MeetingResponse<RequestOf<'login'>>, MeetingSnapshot>>,
  Assert<
    Assignable<MeetingResponse<RequestOf<'logout'>>, Record<string, never>>
  >,
  Assert<Assignable<{ room: null }, MeetingResponse<RequestOf<'remove'>>>>,
  Assert<Not<Assignable<{ room: null }, MeetingResponse<RequestOf<'create'>>>>>,
  Assert<Not<Assignable<{ room: null }, MeetingResponse<RequestOf<'join'>>>>>,
  Assert<Not<Assignable<{ room: null }, MeetingResponse<RequestOf<'vote'>>>>>,
  Assert<Not<Assignable<'room', keyof MeetingResponse<RequestOf<'login'>>>>>,
  Assert<Not<Assignable<{ room: Room }, MeetingResponse<RequestOf<'logout'>>>>>,
  Assert<Not<Assignable<MeetingError, MeetingResponse>>>,
  Assert<Not<Assignable<null, MeetingResponse>>>,
];
