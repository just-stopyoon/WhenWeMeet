import { useCallback, useEffect, useRef, useState } from 'react';
import { meetingApi } from '../lib/meeting-api';
import type { Room } from '../lib/meeting';
import type {
  MeetingRequest,
  MeetingResponse,
  MeetingSnapshot,
} from '../lib/meeting-contract';

// Keep callbacks stable so input renders do not restart the initial request
// or polling timer. onRefresh may change with the current view and room.
type MeetingSyncOptions = {
  onInitialLoad: (snapshot: MeetingSnapshot, inviteCode: string | null) => void;
  onRefresh: (snapshot: MeetingSnapshot) => void;
  onInitialError: (message: string) => void;
  onPollError: (message: string) => void;
  onSaveStart: () => void;
  onSaveError: (message: string) => void;
};

export function useMeetingSync({
  onInitialLoad,
  onRefresh,
  onInitialError,
  onPollError,
  onSaveStart,
  onSaveError,
}: MeetingSyncOptions) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);

  const replaceSession = useCallback((snapshot: MeetingSnapshot) => {
    setUser(snapshot.user);
    setRooms(snapshot.rooms);
  }, []);
  const clearSession = useCallback(() => {
    setRooms([]);
    setUser('');
  }, []);

  const refresh = useCallback(async () => {
    const stamp = generation.current;
    const snapshot = await meetingApi();
    if (pending.current || generation.current !== stamp) return;
    replaceSession(snapshot);
    onRefresh(snapshot);
  }, [onRefresh, replaceSession]);

  useEffect(() => {
    let stopped = false;
    const invite = new URLSearchParams(window.location.search).get('join');
    meetingApi()
      .then((snapshot) => {
        if (stopped) return;
        replaceSession(snapshot);
        onInitialLoad(snapshot, invite);
      })
      .catch((error) => onInitialError(error.message))
      .finally(() => setReady(true));
    return () => {
      stopped = true;
    };
  }, [onInitialLoad, onInitialError, replaceSession]);

  useEffect(() => {
    if (!ready || !user) return;
    const timer = setInterval(() => {
      if (!pending.current && document.visibilityState === 'visible')
        refresh().catch(() =>
          onPollError('연결이 끊겼어요. 다시 연결되면 자동으로 갱신해요.'),
        );
    }, 4000);
    return () => clearInterval(timer);
  }, [ready, user, refresh, onPollError]);

  async function send<R extends MeetingRequest>(
    payload: R,
  ): Promise<MeetingResponse<R> | null> {
    if (pending.current) return null;
    pending.current = true;
    generation.current++;
    setBusy(true);
    onSaveStart();
    try {
      const data = await meetingApi(payload);
      if ('room' in data) {
        const updated = data.room;
        if (updated)
          setRooms((prev) => [
            ...prev.filter((room) => room.id !== updated.id),
            updated,
          ]);
        else if ('roomId' in payload)
          setRooms((prev) => prev.filter((room) => room.id !== payload.roomId));
      }
      return data;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '저장하지 못했어요.';
      onSaveError(message);
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return { ready, user, rooms, busy, send, replaceSession, clearSession };
}
