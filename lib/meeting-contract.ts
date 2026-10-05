import type { Room } from './meeting';

// Contracts for requests produced by this app. HTTP input still needs the
// server's runtime checks; these types do not validate received JSON.
export type MeetingRequest =
  | { type: 'login'; name: string; pin: string }
  | { type: 'logout' }
  | {
      type: 'create';
      title: string;
      start: string;
      end: string;
      size: number;
      mode: Room['mode'];
    }
  | { type: 'join'; code: string }
  | { type: 'schedule'; roomId: string; slots: readonly string[] }
  | { type: 'date'; roomId: string; slot: string; manual?: boolean }
  | {
      type: 'confirm';
      roomId: string;
      value: boolean;
      regionRevision?: number | null;
    }
  | {
      type: 'vote';
      roomId: string;
      choices: readonly string[];
      round: number;
      regionRevision?: number | null;
    }
  | { type: 'reopenDate'; roomId: string }
  | { type: 'region'; roomId: string; name: string }
  | { type: 'runoff'; roomId: string }
  | { type: 'random'; roomId: string }
  | { type: 'transfer'; roomId: string; member: string }
  | { type: 'remove'; roomId: string; member: string }
  | { type: 'close'; roomId: string }
  | {
      type: 'addLink';
      roomId: string;
      url: string;
      name: string;
      category: Room['links'][number]['category'];
    }
  | { type: 'deleteLink'; roomId: string; id: string };

export type RoomRequest = Exclude<MeetingRequest, { type: 'login' | 'logout' }>;
export type MeetingSnapshot = { user: string; rooms: Room[] };
export type MeetingError = { error: string };

// Responses keep their existing wire shapes; only requests have a discriminator.
// A successful self-removal returns { room: null }, not a failed request.
export type MeetingResponse<R extends MeetingRequest = MeetingRequest> =
  R extends { type: 'login' }
    ? MeetingSnapshot
    : R extends { type: 'logout' }
      ? Record<string, never>
      : R extends { type: 'remove' }
        ? { room: Room | null }
        : { room: Room };
