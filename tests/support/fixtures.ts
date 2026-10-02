import { randomUUID } from 'node:crypto';
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { addDays, daysBetween, type Room } from '../../lib/meeting';

export { addDays, expect };
export type { Room };
export type TestAccount = {
  name: string;
  pin: string;
  request: APIRequestContext;
  storageState: Awaited<ReturnType<APIRequestContext['storageState']>>;
};
export type Accounts = [TestAccount, TestAccount, TestAccount];
export type CreateRoomOptions = Partial<
  Pick<Room, 'title' | 'start' | 'end' | 'size' | 'mode'>
>;
export type MeetingAction = { type: string; [key: string]: unknown };

export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const uniqueTitle = (prefix: string) =>
  `${prefix.slice(0, 44)} ${randomUUID().slice(0, 8)}`;
export const slotsFor = (room: Pick<Room, 'start' | 'end'>) =>
  daysBetween(room.start, room.end).flatMap((date) => [
    `${date}|점심`,
    `${date}|저녁`,
  ]);

export const test = base.extend<object, { accounts: Accounts }>({
  accounts: [
    async ({ playwright }, provide, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) throw new Error('Test baseURL is required.');
      const endpoint = new URL(baseURL);
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
        throw new Error('Meeting fixtures require a local test server.');
      const contexts: APIRequestContext[] = [];
      const accounts: TestAccount[] = [];
      try {
        for (let index = 0; index < 3; index++) {
          const name = `qa${randomUUID().replaceAll('-', '').slice(0, 12)}${index}`;
          const pin = String(1000 + Math.floor(Math.random() * 9000));
          const request = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { Origin: endpoint.origin },
          });
          contexts.push(request);
          const response = await request.post('/api/meeting', {
            data: { type: 'login', name, pin },
          });
          expect(response.status(), 'Test account login failed.').toBe(200);
          const result = (await response.json()) as { user: string };
          expect(result.user).toBe(name);
          accounts.push({
            name,
            pin,
            request,
            storageState: await request.storageState(),
          });
        }
        await provide(accounts as Accounts);
      } finally {
        await Promise.all(contexts.map((context) => context.dispose()));
      }
    },
    { scope: 'worker' },
  ],
});

export const postAction = (account: TestAccount, payload: MeetingAction) =>
  account.request.post('/api/meeting', { data: payload });

export async function action(
  account: TestAccount,
  payload: MeetingAction,
): Promise<Room> {
  const response = await postAction(account, payload);
  expect(response.status(), `${payload.type} request failed.`).toBe(200);
  const result = (await response.json()) as { room?: Room | null };
  expect(result.room, `${payload.type} did not return a room.`).toBeTruthy();
  return result.room!;
}

export async function listRooms(account: TestAccount): Promise<Room[]> {
  const response = await account.request.get('/api/meeting');
  expect(response.status()).toBe(200);
  const result = (await response.json()) as { user: string; rooms: Room[] };
  expect(result.user).toBe(account.name);
  return result.rooms;
}

export async function getRoom(account: TestAccount, id: string): Promise<Room> {
  const found = (await listRooms(account)).find((room) => room.id === id);
  expect(found, 'Expected room is missing from the account.').toBeTruthy();
  return found!;
}

export function createRoom(
  host: TestAccount,
  overrides: CreateRoomOptions = {},
): Promise<Room> {
  const start = overrides.start ?? today();
  return action(host, {
    type: 'create',
    title: uniqueTitle('테스트 모임'),
    start,
    end: addDays(start, 13),
    size: 3,
    mode: 'all',
    ...overrides,
  });
}

export async function prepareRoom(
  participants: readonly TestAccount[],
  overrides: CreateRoomOptions = {},
  schedules?: readonly (readonly string[])[],
): Promise<Room> {
  if (participants.length < 2)
    throw new Error('Preparing a room requires at least two accounts.');
  const room = await createRoom(participants[0], {
    size: participants.length,
    ...overrides,
  });
  await Promise.all(
    participants
      .slice(1)
      .map((account) => action(account, { type: 'join', code: room.code })),
  );
  const allSlots = slotsFor(room);
  await Promise.all(
    participants.map((account, index) =>
      action(account, {
        type: 'schedule',
        roomId: room.id,
        slots: schedules?.[index] ?? allSlots,
      }),
    ),
  );
  return getRoom(participants[0], room.id);
}

export async function expectError(
  response: APIResponse,
  status: number,
  message?: RegExp,
) {
  expect(response.status()).toBe(status);
  const result = (await response.json()) as { error: string };
  expect(typeof result.error).toBe('string');
  if (message) expect(result.error).toMatch(message);
}
