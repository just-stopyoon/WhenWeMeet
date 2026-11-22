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
      // The epoch the lookup started in, and whether it succeeded. A failed
      // lookup keeps no subscription: an old endpoint never comes back.
      epoch: number;
      ok: boolean;
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
// signing out), on every sign-in/sign-out here and at logout start.
// Registrations, in-flight and failed re-syncs are keyed by `epoch|endpoint`.
// Only the latest lookup's result counts; it must have succeeded in the
// current epoch before anything is registered or shown as on.
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
  // Counts sign-ins seen here (any source); a logout's background device
  // removal stops if another sign-in came after it started.
  const [signIns, setSignIns] = useState(0);
  const identity = `${user}\n${session}`;
  const [seenIdentity, setSeenIdentity] = useState(identity);
  if (seenIdentity !== identity) {
    setSeenIdentity(identity);
    setEpoch((value) => value + 1);
    if (user) setSignIns((value) => value + 1);
  }
  const epochRef = useRef(epoch);
  const signInsRef = useRef(signIns);
  useLayoutEffect(() => {
    epochRef.current = epoch;
    signInsRef.current = signIns;
  }, [epoch, signIns]);

  const workingRef = useRef(false);
  const releasing = useRef(false);
  const inflight = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const mismatchTried = useRef(new Set<string>());
  // Keys proven by our own subscribe() call (the browser may not report it).
  const knownKeys = useRef(new Map<string, string>());
  // The latest lookup started, and the latest one that has finished. Older
  // lookups are superseded: their results and their waiting are ignored.
  const lookupId = useRef(0);
  const settledId = useRef(0);
  // The same two numbers for rendering: while the latest lookup has not
  // ended, the state is "preparing" (state table row 5).
  const [lookupStarted, setLookupStarted] = useState(0);
  const [lookupSettled, setLookupSettled] = useState(0);

  // Reads the device's real subscription. Resolves with it when this is
  // still the latest lookup and it succeeded; undefined otherwise.
  const lookup = useCallback(async () => {
    if (!pushApis()) return undefined;
    const id = ++lookupId.current;
    const started = epochRef.current;
    // Not inside the caller's effect: the render shows it on the next turn.
    queueMicrotask(() => setLookupStarted(id));
    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription: PushSubscription | null = null;
      let ok = true;
      try {
        subscription = await registration.pushManager.getSubscription();
      } catch {
        ok = false;
      }
      let key: string | null = null;
      if (subscription) {
        const own = subscription.options?.applicationServerKey;
        key =
          (own ? await verifiedKey(new Uint8Array(own)) : null) ??
          knownKeys.current.get(subscription.endpoint) ??
          null;
      }
      if (id !== lookupId.current) return undefined;
      settledId.current = id;
      setLookupSettled(id);
      setDevice({
        ready: true,
        registration,
        subscription,
        key,
        epoch: started,
        ok,
      });
      return ok ? subscription : undefined;
    } catch {
      if (id === lookupId.current) {
        settledId.current = id;
        setLookupSettled(id);
      }
      return undefined;
    } finally {
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
      // Retry only failed pairs, and only after the fresh lookup succeeded.
      void lookup().then((found) => {
        if (found === undefined) return;
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
  // The device result speaks for this epoch only once a lookup in it ended.
  const deviceCurrent = device.ready && device.epoch === epoch;
  const matches =
    !!subscription && deviceKey !== null && deviceKey === serverKey?.canonical;

  let state: PushState;
  if (!ready || !user) state = 'unknown';
  else if (!publicKey || (serverKey && !serverKey.canonical)) state = 'nokey';
  else if (supported === false) state = 'unsupported';
  else if (permission === 'denied') state = 'denied';
  else if (
    supported === null ||
    !deviceCurrent ||
    !serverKey ||
    deviceOps > 0 ||
    lookupStarted > lookupSettled
  )
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
    // Only after the latest lookup ended and succeeded in this epoch.
    if (settledId.current !== lookupId.current) return;
    if (!device.ready || !device.ok || device.epoch !== epoch) return;
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
    // Both sheets' buttons end here; nothing starts during a logout.
    if (releasing.current) return;
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
            epoch: started,
            ok: true,
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

  // At logout, whatever the state (R2, user decision A): start removing
  // this device's subscription and return at once; logout does not wait.
  // Work of the old epoch stops here. The removal's result never reaches
  // the screen, and it stops if another sign-in came after it started.
  function releaseDevice() {
    const mine = epochRef.current + 1;
    epochRef.current = mine;
    setEpoch(mine);
    setRegistered(null);
    releasing.current = true;
    const signedIn = signInsRef.current;
    const quiet = () => signInsRef.current === signedIn;
    void (async () => {
      if (!('serviceWorker' in navigator)) return;
      const found = await navigator.serviceWorker.getRegistration();
      if (!quiet()) return;
      const existing = await found?.pushManager?.getSubscription();
      if (!quiet() || !existing) return;
      // Once called, the removal holds this device's re-sync and "on" until
      // it ends; then whoever is signed in now reads the real subscription.
      setDeviceOps((value) => value + 1);
      try {
        await existing.unsubscribe();
      } finally {
        setDeviceOps((value) => value - 1);
        void lookup();
      }
    })().catch(() => {});
  }

  // After the logout request answered (either way). When the session stays
  // (logout failed), read the device again for this epoch.
  function logoutDone() {
    releasing.current = false;
    void lookup();
  }

  return { state, working, enable, disable, releaseDevice, logoutDone };
}
