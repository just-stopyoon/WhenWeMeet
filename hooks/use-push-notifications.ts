import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { meetingApi } from '../lib/meeting-api';
import type { MeetingRequest, MeetingResponse } from '../lib/meeting-contract';
import {
  base64UrlDecode,
  base64UrlEncode,
  importReceiverKey,
} from '../lib/push-subscription';

// The notification state of this device (issue #14 T5). The first matching
// row of the state table wins, so the states never overlap.
export type PushState =
  | 'unknown' // signed out or first load
  | 'nokey' // the last signed-in response had no usable pushPublicKey
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
      // The verified server key the subscription was made with, or null
      // when the browser does not say (or says something invalid).
      key: string | null;
    };

type ServerKey = {
  raw: string;
  // base64url of the verified 65 bytes; null when not a P-256 point.
  canonical: string | null;
  bytes: Uint8Array<ArrayBuffer> | null;
};

export const pushOffFailed = '알림을 끄지 못했어요. 다시 시도해 주세요.';

// Byte-level check: 65 bytes, uncompressed (0x04), a point on P-256. The
// returned spelling is canonical, so equal bytes compare equal.
async function verifiedKey(bytes: Uint8Array<ArrayBuffer> | null) {
  if (!bytes || bytes.length !== 65 || bytes[0] !== 4) return null;
  try {
    await importReceiverKey(bytes);
    return base64UrlEncode(bytes);
  } catch {
    return null;
  }
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

// Ownership (.utmp/ticket-14-T5/ownership.md): every async step remembers
// the epoch it started in and applies its next device call, server call or
// state change only while that epoch is still current. The epoch moves on
// any change of the signed-in account (this tab, another tab seen by a poll,
// signing out), on every sign-in/sign-out here, at logout start and at the
// logout deadline. Registrations, in-flight and failed re-syncs are keyed
// by `epoch|endpoint`.
export function usePushNotifications({
  ready,
  user,
  publicKey,
  session,
  save,
  onError,
}: {
  ready: boolean;
  user: string;
  publicKey: string | undefined;
  // Changes on every sign-in and sign-out in this tab.
  session: number;
  save: Save;
  onError: (message: string) => void;
}) {
  // null while rendering on the server (no window there).
  const supported = useSyncExternalStore(noSubscribe, pushApis, () => null);
  const permission = useSyncExternalStore(
    onVisibility,
    readPermission,
    () => undefined,
  );
  const [device, setDevice] = useState<Device>({ ready: false });
  const [server, setServer] = useState<ServerKey | null>(null);
  const [registered, setRegistered] = useState<{
    epoch: number;
    endpoint: string;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [deviceOps, setDeviceOps] = useState(0);
  // Re-renders after ref-only bookkeeping (in-flight, failed, lookups).
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((value) => value + 1), []);

  const [epoch, setEpoch] = useState(0);
  const identity = `${user}\n${session}`;
  const [seenIdentity, setSeenIdentity] = useState(identity);
  if (seenIdentity !== identity) {
    setSeenIdentity(identity);
    setEpoch((value) => value + 1);
  }
  const epochRef = useRef(epoch);
  useLayoutEffect(() => {
    epochRef.current = epoch;
  }, [epoch]);

  const workingRef = useRef(false);
  const releasing = useRef(false);
  const inflight = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const mismatchTried = useRef(new Set<string>());
  // Keys proven by our own subscribe() call (the browser may not report it).
  const knownKeys = useRef(new Map<string, string>());
  const lookupId = useRef(0);
  const pendingLookups = useRef(0);

  // Reads the device's real subscription. Resolves with it (undefined when
  // the lookup failed).
  const lookup = useCallback(async () => {
    if (!pushApis()) return undefined;
    const id = ++lookupId.current;
    pendingLookups.current++;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      let key: string | null = null;
      if (subscription) {
        const own = subscription.options?.applicationServerKey;
        key =
          (own ? await verifiedKey(new Uint8Array(own)) : null) ??
          knownKeys.current.get(subscription.endpoint) ??
          null;
      }
      if (id === lookupId.current)
        setDevice({ ready: true, registration, subscription, key });
      return subscription;
    } catch {
      return undefined;
    } finally {
      pendingLookups.current--;
      setTick((value) => value + 1);
    }
  }, []);

  // A native unsubscribe, counted so the state shows "preparing" until it
  // ends; then the real subscription decides. True when it is gone.
  async function removeFromDevice(subscription: PushSubscription) {
    setDeviceOps((value) => value + 1);
    try {
      await subscription.unsubscribe().catch(() => false);
      const found = await lookup();
      return found !== undefined && found?.endpoint !== subscription.endpoint;
    } finally {
      setDeviceOps((value) => value - 1);
    }
  }

  useEffect(() => {
    void lookup();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Retry only failed pairs, and only after the fresh lookup.
      void lookup().then(() => {
        failed.current.clear();
        bump();
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [lookup, bump]);

  // A new account, session or key decides again.
  useEffect(() => {
    if (ready && user) void lookup();
  }, [ready, user, publicKey, session, lookup]);

  useEffect(() => {
    if (!publicKey) return;
    let live = true;
    const bytes = base64UrlDecode(publicKey);
    void verifiedKey(bytes).then((canonical) => {
      if (live)
        setServer({
          raw: publicKey,
          canonical,
          bytes: canonical ? bytes : null,
        });
    });
    return () => {
      live = false;
    };
  }, [publicKey]);

  const serverKey = server && server.raw === publicKey ? server : null;
  const subscription = device.ready ? device.subscription : null;
  const deviceKey = device.ready ? device.key : null;
  const matches =
    !!subscription && deviceKey !== null && deviceKey === serverKey?.canonical;

  let state: PushState;
  if (!ready || !user) state = 'unknown';
  else if (!publicKey || (serverKey && !serverKey.canonical)) state = 'nokey';
  else if (supported === false) state = 'unsupported';
  else if (permission === 'denied') state = 'denied';
  else if (supported === null || !device.ready || !serverKey || deviceOps > 0)
    state = 'preparing';
  else if (
    matches &&
    registered?.epoch === epoch &&
    registered.endpoint === subscription?.endpoint
  )
    state = 'on';
  else state = 'off';

  // Re-sync: one pushSubscribe per epoch and endpoint, outside `send`.
  useEffect(() => {
    if (state !== 'off' || !subscription || !serverKey?.canonical) return;
    if (workingRef.current || releasing.current) return;
    if (pendingLookups.current > 0) return;
    // A key we could not verify is never treated as a match or a mismatch.
    if (deviceKey === null) return;
    if (deviceKey !== serverKey.canonical) {
      const mark = `${subscription.endpoint}|${serverKey.canonical}`;
      if (mismatchTried.current.has(mark)) return;
      mismatchTried.current.add(mark);
      void removeFromDevice(subscription);
      return;
    }
    const pair = `${epoch}|${subscription.endpoint}`;
    if (inflight.current.has(pair) || failed.current.has(pair)) return;
    const body = subscriptionBody(subscription);
    if (!body) return;
    inflight.current.add(pair);
    const started = epoch;
    const endpoint = subscription.endpoint;
    meetingApi({ type: 'pushSubscribe', subscription: body })
      .then(
        () => {
          if (epochRef.current === started)
            setRegistered({ epoch: started, endpoint });
        },
        () => {
          if (epochRef.current === started) failed.current.add(pair);
        },
      )
      .finally(() => {
        inflight.current.delete(pair);
        bump();
      });
  });

  function begin() {
    workingRef.current = true;
    setWorking(true);
  }
  function finish() {
    workingRef.current = false;
    setWorking(false);
  }

  // Called straight from the click handler: subscribe() must be the first
  // async step so iOS still sees the user gesture.
  function enable() {
    if (state !== 'off' || workingRef.current || !device.ready) return;
    const bytes = serverKey?.bytes;
    const canonical = serverKey?.canonical;
    if (!bytes || !canonical) return;
    begin();
    const { registration } = device;
    const started = epoch;
    let subscribing: Promise<PushSubscription>;
    try {
      subscribing = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
    } catch (error) {
      subscribing = Promise.reject(error);
    }
    subscribing
      .then(
        async (created) => {
          knownKeys.current.set(created.endpoint, canonical);
          // Another account now: leave the device to its own re-sync.
          if (epochRef.current !== started) return void (await lookup());
          const body = subscriptionBody(created);
          const saved = body
            ? await save({ type: 'pushSubscribe', subscription: body })
            : null;
          if (epochRef.current !== started) return void (await lookup());
          if (!saved) {
            failed.current.add(`${started}|${created.endpoint}`);
            await removeFromDevice(created);
            return;
          }
          setDevice({
            ready: true,
            registration,
            subscription: created,
            key: canonical,
          });
          setRegistered({ epoch: started, endpoint: created.endpoint });
        },
        // A refusal shows on the next render: permission is read live.
        () => {},
      )
      .finally(finish);
  }

  async function disable() {
    if (state !== 'on' || workingRef.current || !subscription) return;
    begin();
    const started = epoch;
    const target = subscription;
    try {
      const gone = await removeFromDevice(target);
      if (epochRef.current !== started) return;
      if (!gone) {
        // Still subscribed and still registered: say so, allow another try.
        onError(pushOffFailed);
        return;
      }
      setRegistered(null);
      await save({ type: 'pushUnsubscribe', endpoint: target.endpoint });
    } finally {
      finish();
    }
  }

  // Before logout, whatever the state: try to drop this device's
  // subscription (R2). Work of the old epoch stops here; a lookup that has
  // not finished by the deadline no longer removes anything.
  async function releaseDevice() {
    const mine = epochRef.current + 1;
    epochRef.current = mine;
    setEpoch(mine);
    setRegistered(null);
    releasing.current = true;
    const current = () => epochRef.current === mine;
    const attempt = (async () => {
      if (!('serviceWorker' in navigator)) return;
      const found = await navigator.serviceWorker.getRegistration();
      if (!current()) return;
      const existing = await found?.pushManager?.getSubscription();
      if (!current() || !existing) return;
      await removeFromDevice(existing);
    })().catch(() => {});
    const late = await Promise.race([
      attempt.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3000)),
    ]);
    if (late && current()) {
      epochRef.current = mine + 1;
      setEpoch(mine + 1);
    }
  }

  // After the logout request answered (either way).
  function logoutDone() {
    releasing.current = false;
    bump();
  }

  return { state, working, enable, disable, releaseDevice, logoutDone };
}
