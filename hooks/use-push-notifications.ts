import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { meetingApi } from '../lib/meeting-api';
import type { MeetingRequest, MeetingResponse } from '../lib/meeting-contract';
import { base64UrlDecode, base64UrlEncode } from '../lib/push-subscription';

// The notification state of this device (issue #14 T5). The first matching
// row of the state table wins, so the states never overlap.
export type PushState =
  | 'unknown' // signed out or first load
  | 'nokey' // the last signed-in response had no pushPublicKey
  | 'unsupported'
  | 'denied'
  | 'preparing' // service worker ready / subscription lookup not finished
  | 'on'
  | 'off';

type PushSubscribe = Extract<MeetingRequest, { type: 'pushSubscribe' }>;
type PushUnsubscribe = Extract<MeetingRequest, { type: 'pushUnsubscribe' }>;
type Save = <R extends PushSubscribe | PushUnsubscribe>(
  payload: R,
) => Promise<MeetingResponse<R> | null>;

type Device =
  | { ready: false }
  | {
      ready: true;
      registration: ServiceWorkerRegistration;
      subscription: PushSubscription | null;
    };

// A key the server may hand out: base64url of a 65-byte uncompressed point.
function validKey(key: string | null | undefined): key is string {
  if (typeof key !== 'string') return false;
  const bytes = base64UrlDecode(key);
  return !!bytes && bytes.length === 65 && bytes[0] === 4;
}

// The server key this subscription was made with, when the browser says.
function subscriptionKey(subscription: PushSubscription) {
  const key = subscription.options?.applicationServerKey;
  return key ? base64UrlEncode(new Uint8Array(key)) : null;
}

function subscriptionBody(
  subscription: PushSubscription,
): PushSubscribe['subscription'] | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint: subscription.endpoint, keys: { p256dh, auth } };
}

const pushApis = () =>
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;
const noSubscribe = () => () => {};
// Permission changes outside React (the subscribe() prompt, device
// settings); every render and every tab return reads it again.
const onVisibility = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};
const readPermission = () =>
  'Notification' in window ? Notification.permission : undefined;

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms),
    ),
  ]);
}

export function usePushNotifications({
  ready,
  user,
  publicKey,
  session,
  save,
}: {
  ready: boolean;
  user: string;
  publicKey: string | undefined;
  // Changes on every sign-in and sign-out; registrations belong to one.
  session: number;
  save: Save;
}) {
  // null while rendering on the server (no window there).
  const supported = useSyncExternalStore(noSubscribe, pushApis, () => null);
  const permission = useSyncExternalStore(
    onVisibility,
    readPermission,
    () => undefined,
  );
  const [device, setDevice] = useState<Device>({ ready: false });
  // `${session}|${endpoint}` the server accepted in this session.
  const [registered, setRegistered] = useState('');
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const sessionRef = useRef(session);
  // Re-sync pairs already tried; cleared when the tab comes back.
  const attempted = useRef(new Set<string>());
  // Bumped when the tab comes back so the re-sync effect runs again even
  // when the lookup returns the same subscription object.
  const [visits, setVisits] = useState(0);
  const lookup = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const check = useCallback(() => {
    if (!pushApis()) return;
    const id = ++lookup.current;
    navigator.serviceWorker.ready
      .then((registration) =>
        registration.pushManager.getSubscription().then((subscription) => {
          if (id === lookup.current)
            setDevice({ ready: true, registration, subscription });
        }),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    check();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      attempted.current.clear();
      setVisits((value) => value + 1);
      check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);

  // A new key or a new session decides again.
  useEffect(() => {
    if (ready && user) check();
  }, [ready, user, publicKey, session, check]);

  const subscription = device.ready ? device.subscription : null;
  const pair = subscription ? `${session}|${subscription.endpoint}` : '';
  const ownKey = subscription ? subscriptionKey(subscription) : null;
  const keyMatches = ownKey === null || ownKey === publicKey;

  let state: PushState;
  if (!ready || !user) state = 'unknown';
  else if (!publicKey) state = 'nokey';
  else if (supported === false) state = 'unsupported';
  else if (permission === 'denied') state = 'denied';
  else if (supported === null || !device.ready) state = 'preparing';
  else if (subscription && keyMatches && registered === pair) state = 'on';
  else state = 'off';

  // Re-sync: one pushSubscribe per session and endpoint, outside `send`.
  useEffect(() => {
    if (!ready || !user || !validKey(publicKey) || !subscription) return;
    if (permission === 'denied' || workingRef.current) return;
    if (validKey(ownKey) && ownKey !== publicKey) {
      // Only two real, different keys drop the device subscription.
      void subscription
        .unsubscribe()
        .catch(() => false)
        .then(() =>
          setDevice((current) =>
            current.ready && current.subscription === subscription
              ? { ...current, subscription: null }
              : current,
          ),
        );
      return;
    }
    if (registered === pair || attempted.current.has(pair)) return;
    const body = subscriptionBody(subscription);
    if (!body) return;
    attempted.current.add(pair);
    const started = session;
    meetingApi({ type: 'pushSubscribe', subscription: body })
      .then(() => {
        if (sessionRef.current === started) setRegistered(pair);
      })
      .catch(() => {});
  }, [
    ready,
    user,
    publicKey,
    subscription,
    ownKey,
    permission,
    registered,
    pair,
    session,
    visits,
  ]);

  function finish() {
    workingRef.current = false;
    setWorking(false);
  }

  // Called straight from the click handler: subscribe() must be the first
  // async step so iOS still sees the user gesture.
  function enable() {
    if (state !== 'off' || workingRef.current || !device.ready) return;
    const key = publicKey ? base64UrlDecode(publicKey) : null;
    if (!key) return;
    workingRef.current = true;
    setWorking(true);
    const { registration } = device;
    const started = session;
    let subscribing: Promise<PushSubscription>;
    try {
      subscribing = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    } catch (error) {
      subscribing = Promise.reject(error);
    }
    subscribing
      .then(
        async (created) => {
          const body = subscriptionBody(created);
          const saved = body
            ? await save({ type: 'pushSubscribe', subscription: body })
            : null;
          if (!saved || sessionRef.current !== started) {
            await created.unsubscribe().catch(() => false);
            setDevice({ ready: true, registration, subscription: null });
            return;
          }
          setDevice({ ready: true, registration, subscription: created });
          setRegistered(`${started}|${created.endpoint}`);
        },
        // A refusal shows on the next render: permission is read live.
        () => {},
      )
      .finally(finish);
  }

  async function disable() {
    if (state !== 'on' || workingRef.current || !subscription) return;
    workingRef.current = true;
    setWorking(true);
    try {
      await subscription.unsubscribe().catch(() => false);
      setDevice((current) =>
        current.ready ? { ...current, subscription: null } : current,
      );
      setRegistered('');
      await save({ type: 'pushUnsubscribe', endpoint: subscription.endpoint });
    } finally {
      finish();
    }
  }

  // Before logout, whatever the state: try to drop this device's
  // subscription. Failures and a lookup that never ends do not block logout.
  async function releaseDevice() {
    try {
      if ('serviceWorker' in navigator) {
        await withTimeout(
          navigator.serviceWorker.getRegistration().then(async (found) => {
            const current = await found?.pushManager?.getSubscription();
            if (current) await current.unsubscribe();
          }),
          3000,
        );
      }
    } catch {
      // Logout goes on; the server drops this session's rows anyway.
    }
    setDevice((current) =>
      current.ready ? { ...current, subscription: null } : current,
    );
    setRegistered('');
  }

  return { state, working, enable, disable, releaseDevice };
}
