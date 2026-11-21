import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newRoom, type Room } from '../lib/meeting';
import { pushNotices, pushPayload, type PushNotice } from '../lib/push-notices';
import { applyAction, type UnvalidatedAction } from '../lib/room-actions';

// Issue #14 seam 1 (T3): who receives which notice, and what it says (Q1·Q7·R6).
// Transitions come from the real applyAction() so every case is one the server
// can actually produce. Every marker below is a different string: allowed
// fields (room title, date, region) and forbidden ones (nickname, account ID,
// invite code) can then be told apart in the result.

const slot = '2099-12-03|저녁';
const dateLabel = '12월 3일 (목) 저녁';
const title = '방제목표식';
const region = '지역표식';
const code = 'CODE표식';
const host = 'id표식방장';
const friend = 'id표식친구';
const other = 'id표식다른친구';
const members = [host, friend, other];
const nicknames = {
  [host]: '닉표식방장',
  [friend]: '닉표식친구',
  [other]: '닉표식다른친구',
};
const forbidden = [code, ...members, ...Object.values(nicknames)];

function room(overrides: Partial<Room> = {}): Room {
  return {
    ...newRoom(title, host, '2099-12-01', '2099-12-14', 3, 'all', 'room-id-1'),
    code,
    members: [...members],
    memberNames: { ...nicknames },
    regions: [region, '다른지역표식'],
    ...overrides,
  };
}

const allResponded = (slots = [slot]) =>
  Object.fromEntries(members.map((member) => [member, slots]));

function notices(source: Room, actor: string, action: UnvalidatedAction) {
  return pushNotices(source, applyAction(source, actor, action), actor);
}

function expectNotices(
  result: PushNotice[],
  accounts: string[],
  body: string,
  expectedTitle = title,
) {
  assert.deepEqual(
    [...result].sort((a, b) => a.account.localeCompare(b.account)),
    [...accounts].sort().map((account) => ({
      account,
      title: expectedTitle,
      body,
      roomId: 'room-id-1',
      url: '/?room=room-id-1',
    })),
  );
}

function expectNoForbiddenText(result: PushNotice[]) {
  for (const notice of result)
    for (const marker of forbidden) {
      assert.ok(!notice.title.includes(marker), `title has ${marker}`);
      assert.ok(!notice.body.includes(marker), `body has ${marker}`);
    }
}

const scheduleDone = '모두 일정을 제출했어요. 날짜를 정해 주세요.';
const confirmAsk = `${dateLabel}에 올 수 있는지 알려 주세요.`;
const regionStart = `날짜가 정해졌어요 · ${dateLabel}. 지역을 투표해 주세요.`;
const runoffStart = `${dateLabel} · 동률 후보로 다시 투표해요. 한 곳을 골라 주세요.`;
const tieNotice = `${dateLabel} · 지역 투표가 동률이에요. 재투표나 무작위 선택을 골라 주세요.`;
const finalNotice = `약속이 정해졌어요 · ${dateLabel} · ${region}`;

const voting = (overrides: Partial<Room> = {}) =>
  room({
    stage: 'region',
    date: slot,
    responses: allResponded(),
    attendees: [...members],
    ...overrides,
  });

void test('일정 마감(schedule → date)은 방장에게 날짜 없이 알린다', () => {
  const source = room({
    responses: { [host]: [slot], [other]: [slot] },
  });
  const result = notices(source, friend, {
    type: 'schedule',
    slots: [slot],
  });
  expectNotices(result, [host], scheduleDone);
  expectNoForbiddenText(result);
});

void test('마지막 제출이 방장이면 일정 마감 알림은 아무에게도 가지 않는다', () => {
  const source = room({
    responses: { [friend]: [slot], [other]: [slot] },
  });
  assert.deepEqual(
    notices(source, host, { type: 'schedule', slots: [slot] }),
    [],
  );
});

void test('참석 확인 요청(date → confirm)은 방장 외 구성원에게 날짜와 함께 알린다', () => {
  const source = room({ stage: 'date', responses: allResponded([]) });
  const result = notices(source, host, {
    type: 'date',
    slot,
    manual: true,
  });
  expectNotices(result, [friend, other], confirmAsk);
  expectNoForbiddenText(result);
});

void test('지역 투표 시작(date → region)은 행동한 방장을 뺀 참석자에게만 알린다', () => {
  const source = room({
    stage: 'date',
    responses: { [host]: [slot], [friend]: [slot], [other]: [] },
  });
  const result = notices(source, host, { type: 'date', slot });
  // `other` is a member but not an attendee: no notice when the date is set.
  expectNotices(result, [friend], regionStart);
  expectNoForbiddenText(result);
});

void test('비참석 방장도 지역 투표 시작 알림을 받지 않는다', () => {
  const source = room({
    stage: 'confirm',
    date: slot,
    responses: allResponded([]),
    confirmations: { [host]: false, [friend]: true },
  });
  const result = notices(source, other, {
    type: 'confirm',
    value: true,
  });
  expectNotices(result, [friend], regionStart);
});

void test('참석 확인이 끝나면(confirm → region) 마지막 응답자를 뺀 참석자에게 알린다', () => {
  const source = room({
    stage: 'confirm',
    date: slot,
    responses: allResponded([]),
    confirmations: { [host]: true, [friend]: true },
  });
  const result = notices(source, other, {
    type: 'confirm',
    value: true,
  });
  expectNotices(result, [host, friend], regionStart);
});

void test('참석 확인 중 탈퇴로 지역 투표가 시작되면 나간 사람은 받지 않는다', () => {
  const source = room({
    stage: 'confirm',
    date: slot,
    responses: allResponded([]),
    confirmations: { [host]: true, [friend]: true },
  });
  const left = notices(source, other, { type: 'remove', member: other });
  expectNotices(left, [host, friend], regionStart);
  const kicked = notices(source, host, { type: 'remove', member: other });
  expectNotices(kicked, [friend], regionStart);
});

void test('동률(region → tie)은 방장에게 날짜와 함께 알린다', () => {
  const source = voting({
    votes: { [friend]: [region], [other]: ['다른지역표식'] },
    attendees: [friend, other],
  });
  const result = notices(source, other, {
    type: 'vote',
    choices: ['다른지역표식'],
    round: 1,
  });
  // `other` already voted; the re-vote keeps the tie and finishes tallying.
  expectNotices(result, [host], tieNotice);
  expectNoForbiddenText(result);
});

void test('방장이 마지막 투표로 동률을 만들면 동률 알림은 가지 않는다', () => {
  const source = voting({
    votes: { [friend]: [region], [other]: ['다른지역표식'] },
    attendees: [host, friend, other],
  });
  assert.deepEqual(
    notices(source, host, {
      type: 'vote',
      choices: [region, '다른지역표식'],
      round: 1,
    }),
    [],
  );
});

void test('투표 중 탈퇴·강퇴로 동률이 되면 방장에게, 확정되면 남은 구성원에게 알린다', () => {
  const tieSource = voting({
    votes: { [host]: [region], [friend]: ['다른지역표식'] },
  });
  expectNotices(
    notices(tieSource, other, { type: 'remove', member: other }),
    [host],
    tieNotice,
  );
  const finalSource = voting({
    votes: { [host]: [region], [friend]: [region] },
  });
  expectNotices(
    notices(finalSource, other, { type: 'remove', member: other }),
    [host, friend],
    finalNotice,
  );
  expectNotices(
    notices(finalSource, host, { type: 'remove', member: other }),
    [friend],
    finalNotice,
  );
});

void test('장소 확정(region → final)은 행동한 사람을 뺀 구성원 전원에게 날짜·지역과 함께 알린다', () => {
  const source = voting({
    attendees: [host, friend],
    votes: { [host]: [region] },
  });
  const result = notices(source, friend, {
    type: 'vote',
    choices: [region],
    round: 1,
  });
  // `other` did not attend but still hears about the final place.
  expectNotices(result, [host, other], finalNotice);
  expectNoForbiddenText(result);
});

void test('무작위 선택(tie → final)도 장소 확정 알림이다', () => {
  const source = voting({
    stage: 'tie',
    tied: [region],
    votes: { [host]: [region], [friend]: [region] },
  });
  expectNotices(
    notices(source, host, { type: 'random' }),
    [friend, other],
    finalNotice,
  );
});

void test('재투표(tie → region)는 첫 투표와 다른 문구로 행동한 방장을 뺀 참석자에게 알린다', () => {
  const source = voting({
    stage: 'tie',
    tied: [region, '다른지역표식'],
    attendees: [host, friend],
    votes: { [host]: [region], [friend]: ['다른지역표식'] },
  });
  const result = notices(source, host, { type: 'runoff' });
  expectNotices(result, [friend], runoffStart);
  assert.notEqual(runoffStart, regionStart);
  expectNoForbiddenText(result);
});

void test('단계가 그대로이거나 표에 없는 전환이면 빈 목록이다', () => {
  const cases: [Room, string, UnvalidatedAction][] = [
    [
      voting({ votes: {} }),
      friend,
      { type: 'vote', choices: [region], round: 1 },
    ],
    [voting(), friend, { type: 'region', name: '새후보표식' }],
    [voting(), host, { type: 'reopenDate' }],
    [
      voting({ stage: 'confirm', confirmations: {} }),
      host,
      { type: 'reopenDate' },
    ],
    [voting({ stage: 'tie', tied: [region] }), host, { type: 'reopenDate' }],
    [
      voting({ stage: 'final', region }),
      friend,
      {
        type: 'addLink',
        url: 'https://example.com/',
        name: '링크',
        category: 'food',
      },
    ],
    [voting({ stage: 'final', region }), host, { type: 'close' }],
    [voting(), host, { type: 'transfer', member: friend }],
    [room({ members: [host, friend], responses: {} }), other, { type: 'join' }],
    [room({ responses: {} }), friend, { type: 'schedule', slots: [slot] }],
  ];
  for (const [source, actor, action] of cases)
    assert.deepEqual(
      notices(source, actor, action),
      [],
      `${String(action.type)} from ${source.stage}`,
    );
});

void test('방 이름·지역이 닉네임과 우연히 같아도 허용 필드의 값으로 정확한 문장을 만든다', () => {
  const sameTitle = nicknames[friend];
  const sameRegion = nicknames[other];
  const source = voting({
    title: sameTitle,
    regions: [sameRegion, '다른지역표식'],
    attendees: [host, friend],
    votes: { [host]: [sameRegion] },
  });
  const result = notices(source, friend, {
    type: 'vote',
    choices: [sameRegion],
    round: 1,
  });
  expectNotices(
    result,
    [host, other],
    `약속이 정해졌어요 · ${dateLabel} · ${sameRegion}`,
    sameTitle,
  );
});

void test('페이로드는 제목·본문·tag(모임 id)·주소만 담은 JSON이다', () => {
  const notice: PushNotice = {
    account: host,
    title,
    body: finalNotice,
    roomId: 'room-id-1',
    url: '/?room=room-id-1',
  };
  const payload = JSON.parse(pushPayload(notice)) as Record<string, unknown>;
  assert.deepEqual(payload, {
    title,
    body: finalNotice,
    tag: 'room-id-1',
    url: '/?room=room-id-1',
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'body',
    'tag',
    'title',
    'url',
  ]);
});
