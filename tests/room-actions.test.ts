import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, newRoom, type Room } from '../lib/meeting';
import { applyAction, expiresOn } from '../lib/room-actions';

const slot = '2099-01-01|점심';
const members = ['방장', '친구', '다른친구'];
function room(overrides: Partial<Room> = {}): Room {
  return {
    ...newRoom(
      '테스트 모임',
      '방장',
      '2099-01-01',
      '2099-01-14',
      3,
      'all',
      'test',
    ),
    members: [...members],
    responses: Object.fromEntries(members.map((member) => [member, [slot]])),
    stage: 'confirm',
    date: slot,
    confirmations: {},
    ...overrides,
  };
}

for (const stage of ['confirm', 'region', 'tie'] as const) {
  void test(`방장이 ${stage}에서 날짜를 재선택하면 투표만 초기화한다`, () => {
    const source = room({
      stage,
      confirmations: { 방장: true, 친구: false },
      attendees: ['방장'],
      votes: { 방장: ['연남'] },
      tied: ['연남', '건대, 성수'],
      region: '연남',
      round: 2,
      regionRevision: 3,
    });
    const original = structuredClone(source);
    const updated = applyAction(source, '방장', { type: 'reopenDate' });

    assert.equal(updated.stage, 'date');
    assert.equal(updated.date, undefined);
    assert.equal(updated.region, undefined);
    assert.equal(updated.tied, undefined);
    assert.deepEqual(updated.attendees, []);
    assert.deepEqual(updated.confirmations, {});
    assert.deepEqual(updated.votes, {});
    assert.equal(updated.round, 1);
    assert.equal(updated.regionRevision, 4);
    assert.deepEqual(updated.responses, source.responses);
    assert.deepEqual(updated.regions, source.regions);
    assert.deepEqual(updated.members, source.members);
    assert.equal(updated.size, source.size);
    assert.equal(expiresOn(updated), addDays(updated.end, 1));
    assert.deepEqual(source, original);
  });
}

void test('날짜 재선택은 구성원인 방장에게만 허용한다', () => {
  assert.throws(
    () => applyAction(room(), '친구', { type: 'reopenDate' }),
    /방장만/,
  );
  assert.throws(
    () => applyAction(room(), '외부인', { type: 'reopenDate' }),
    /참여자가 아니/,
  );
});

void test('최종 확정, 종료, 만료된 모임은 날짜를 재선택하지 못한다', () => {
  for (const stage of ['final', 'closed'] as const)
    assert.throws(() =>
      applyAction(room({ stage }), '방장', { type: 'reopenDate' }),
    );
  assert.throws(
    () =>
      applyAction(room({ date: '2000-01-01|점심' }), '방장', {
        type: 'reopenDate',
      }),
    /종료된 모임/,
  );
});

for (const attendeeCount of [0, 1]) {
  void test(`전원 확인 후 참석 ${attendeeCount}명이면 방장이 날짜를 다시 고를 수 있다`, () => {
    let current = room();
    for (const [index, member] of members.entries())
      current = applyAction(current, member, {
        type: 'confirm',
        value: index < attendeeCount,
      });

    assert.equal(current.stage, 'confirm');
    assert.equal(current.attendees.length, attendeeCount);
    const reopened = applyAction(current, '방장', { type: 'reopenDate' });
    assert.equal(reopened.stage, 'date');
    assert.equal(reopened.regionRevision, 1);
  });
}

for (const actor of ['방장', '다른친구']) {
  void test(`마지막 미응답자를 ${actor === '방장' ? '강퇴하면' : '본인이 탈퇴하면'} 남은 찬성자들이 지역 투표로 진행한다`, () => {
    const source = room({
      confirmations: { 방장: true, 친구: true },
      attendees: ['방장', '친구'],
    });
    const updated = applyAction(source, actor, {
      type: 'remove',
      member: '다른친구',
    });
    assert.deepEqual(updated.members, ['방장', '친구']);
    assert.deepEqual(updated.attendees, ['방장', '친구']);
    assert.equal(updated.stage, 'region');
    assert.equal(updated.size, 3);
    assert.equal(updated.responses['다른친구'], undefined);
  });
}

void test('참석자를 제거해 한 명만 남으면 확인 단계에 머문다', () => {
  const updated = applyAction(
    room({
      confirmations: { 방장: true, 친구: true, 다른친구: false },
      attendees: ['방장', '친구'],
    }),
    '방장',
    { type: 'remove', member: '친구' },
  );
  assert.equal(updated.stage, 'confirm');
  assert.deepEqual(updated.attendees, ['방장']);
  assert.deepEqual(updated.confirmations, { 방장: true, 다른친구: false });
});

void test('멤버 제거 뒤에도 미응답자가 있으면 확인 단계에 머문다', () => {
  const updated = applyAction(
    room({
      members: [...members, '네번째친구'],
      size: 4,
      confirmations: { 방장: true, 친구: true },
    }),
    '방장',
    { type: 'remove', member: '다른친구' },
  );
  assert.equal(updated.stage, 'confirm');
  assert.deepEqual(updated.attendees, ['방장', '친구']);
});

void test('기존 데이터의 같은 참석 응답을 재제출해도 진행 조건을 재계산한다', () => {
  const source = room({
    members: ['방장', '친구'],
    confirmations: { 방장: true, 친구: true },
    attendees: ['방장', '친구'],
  });
  const updated = applyAction(source, '방장', { type: 'confirm', value: true });
  assert.equal(updated.stage, 'region');
  assert.deepEqual(updated.attendees, ['방장', '친구']);
});

void test('확인 기록과 revision이 없는 기존 방은 첫 응답을 받을 수 있다', () => {
  const source = room();
  delete source.confirmations;
  const updated = applyAction(source, '방장', { type: 'confirm', value: true });
  assert.equal(updated.stage, 'confirm');
  assert.deepEqual(updated.confirmations, { 방장: true });
  assert.deepEqual(updated.attendees, ['방장']);
});

void test('같은 날짜를 다시 선택해도 이전 확인 요청은 새 확인에 적용하지 않는다', () => {
  const reopened = applyAction(room(), '방장', { type: 'reopenDate' });
  const current = applyAction(reopened, '방장', {
    type: 'date',
    slot,
    manual: true,
  });
  for (const regionRevision of [undefined, 0, 2])
    assert.throws(
      () =>
        applyAction(current, '친구', {
          type: 'confirm',
          value: true,
          regionRevision,
        }),
      /지난 날짜의 참석 확인/,
    );
  const updated = applyAction(current, '친구', {
    type: 'confirm',
    value: true,
    regionRevision: 1,
  });
  assert.deepEqual(updated.confirmations, { 친구: true });
  assert.deepEqual(current.confirmations, {});
});

void test('확인은 참여자, 확인 단계, boolean 응답 조건을 유지한다', () => {
  assert.throws(
    () => applyAction(room(), '외부인', { type: 'confirm', value: true }),
    /참여자가 아니/,
  );
  assert.throws(() =>
    applyAction(room({ stage: 'region' }), '방장', {
      type: 'confirm',
      value: true,
    }),
  );
  assert.throws(() =>
    applyAction(room(), '방장', { type: 'confirm', value: 'true' }),
  );
});

void test('일정 응답으로 정한 참석자는 지역 단계의 멤버 제거 시 유지된다', () => {
  const updated = applyAction(
    room({
      stage: 'region',
      attendees: [...members],
      votes: { 방장: ['연남'], 친구: ['연남'] },
    }),
    '방장',
    { type: 'remove', member: '다른친구' },
  );
  assert.deepEqual(updated.attendees, ['방장', '친구']);
  assert.equal(updated.stage, 'final');
  assert.equal(updated.region, '연남');
});

for (const stage of ['tie', 'region'] as const) {
  void test(`기존 ${stage}의 빈 동률 후보는 날짜 재선택으로 복구할 수 있다`, () => {
    let current = room({
      stage,
      round: stage === 'tie' ? 1 : 2,
      tied: [],
      regions: ['constructor', '연남'],
      attendees: [...members],
      votes: {
        방장: ['constructor'],
        친구: ['constructor'],
        다른친구: ['constructor'],
      },
    });
    current = applyAction(current, '방장', { type: 'reopenDate' });
    current = applyAction(current, '방장', { type: 'date', slot });
    for (const member of members)
      current = applyAction(current, member, {
        type: 'vote',
        round: 1,
        regionRevision: 1,
        choices: ['constructor'],
      });
    assert.equal(current.stage, 'final');
    assert.equal(current.region, 'constructor');
    assert.deepEqual(current.tied, ['constructor']);
  });
}

void test('날짜 재선택 후에도 이전 지역 회차와 revision 투표를 거절한다', () => {
  const current = room({
    stage: 'region',
    attendees: [...members],
    regionRevision: 1,
  });
  for (const action of [
    { round: 1, regionRevision: 0 },
    { round: 2, regionRevision: 1 },
  ])
    assert.throws(
      () =>
        applyAction(current, '친구', {
          type: 'vote',
          choices: ['연남'],
          ...action,
        }),
      /지난 회차의 투표/,
    );
});
