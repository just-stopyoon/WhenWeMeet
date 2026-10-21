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
  onPollError: (message: string) => void;
  onSaveStart: () => void;
  onSaveError: (message: string) => void;
};

export type InitialLoadState =
  | { status: 'loading'; retrying: boolean }
  | { status: 'error'; message: string }
  | { status: 'ready' };

type InitialRequest = {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};
type InitialLifecycle = {
  mounted: boolean;
  ready: boolean;
  attempt: number;
  invite: string | null | undefined;
  request: InitialRequest | null;
};

export function useMeetingSync({
  onInitialLoad,
  onRefresh,
  onPollError,
  onSaveStart,
  onSaveError,
}: MeetingSyncOptions) {
  const [initialLoad, setInitialLoad] = useState<InitialLoadState>({
    status: 'loading',
    retrying: false,
  });
  const ready = initialLoad.status === 'ready';
  const [user, setUser] = useState('');
  const [nickname, setNickname] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const initial = useRef<InitialLifecycle>({
    mounted: false,
    ready: false,
    attempt: 0,
    invite: undefined,
    request: null,
  });

  const replaceSession = useCallback((snapshot: MeetingSnapshot) => {
    setUser(snapshot.user);
    setNickname(snapshot.nickname ?? snapshot.user);
    setRooms(snapshot.rooms);
  }, []);
  const clearSession = useCallback(() => {
    setRooms([]);
    setUser('');
    setNickname('');
  }, []);

  const refresh = useCallback(async () => {
    const stamp = generation.current;
    const snapshot = await meetingApi();
    if (pending.current || generation.current !== stamp) return;
    replaceSession(snapshot);
    onRefresh(snapshot);
  }, [onRefresh, replaceSession]);

  const loadInitial = useCallback(
    (retrying = false) => {
      const lifecycle = initial.current;
      if (!lifecycle.mounted || lifecycle.ready || lifecycle.request) return;
      if (lifecycle.invite === undefined)
        lifecycle.invite = new URLSearchParams(window.location.search).get(
          'join',
        );
      const attempt = ++lifecycle.attempt;
      const request: InitialRequest = { controller: new AbortController() };
      const isCurrent = () =>
        lifecycle.mounted && lifecycle.attempt === attempt;
      const finish = () => {
        clearTimeout(request.timer);
        if (lifecycle.request === request) lifecycle.request = null;
      };
      request.timer = setTimeout(() => {
        if (!isCurrent()) return;
        // Invalidate before aborting: even a transport that ignores abort is stale.
        lifecycle.attempt++;
        finish();
        request.controller.abort();
        setInitialLoad({
          status: 'error',
          message: '연결이 오래 걸리고 있어요. 다시 시도해 주세요.',
        });
      }, 30_000);
      lifecycle.request = request;
      setInitialLoad({ status: 'loading', retrying });
      void meetingApi(undefined, { signal: request.controller.signal })
        .then((snapshot) => {
          if (!isCurrent()) return;
          if (
            !snapshot ||
            typeof snapshot.user !== 'string' ||
            !Array.isArray(snapshot.rooms) ||
            (snapshot.nickname !== undefined &&
              typeof snapshot.nickname !== 'string')
          )
            throw new Error('Invalid initial snapshot');
          finish();
          replaceSession(snapshot);
          onInitialLoad(snapshot, lifecycle.invite ?? null);
          lifecycle.ready = true;
          setInitialLoad({ status: 'ready' });
        })
        .catch(() => {
          if (!isCurrent()) return;
          finish();
          setInitialLoad({
            status: 'error',
            message: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
          });
        });
    },
    [onInitialLoad, replaceSession],
  );

  const retryInitialLoad = useCallback(() => loadInitial(true), [loadInitial]);

  useEffect(() => {
    const lifecycle = initial.current;
    lifecycle.mounted = true;
    loadInitial();
    return () => {
      lifecycle.mounted = false;
      lifecycle.attempt++;
      if (lifecycle.request) {
        clearTimeout(lifecycle.request.timer);
        lifecycle.request.controller.abort();
        lifecycle.request = null;
      }
    };
  }, [loadInitial]);

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
    if (!initial.current.ready || pending.current) return null;
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

  return {
    ready,
    initialLoad,
    retryInitialLoad,
    user,
    nickname,
    rooms,
    busy,
    send,
    replaceSession,
    clearSession,
  };
}
