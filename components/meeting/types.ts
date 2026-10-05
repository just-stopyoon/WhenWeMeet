import type { Room } from '../../lib/meeting';

export type View = 'home' | 'login' | 'create' | 'join' | 'room';
export type Sheet =
  | null
  | 'members'
  | 'invite'
  | 'settings'
  | 'link'
  | 'addRegion'
  | 'attendees';
export type OpenSheet = (sheet: Sheet, trigger?: HTMLButtonElement) => void;
export type LinkCategory = Room['links'][number]['category'];
