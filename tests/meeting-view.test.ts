import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween, newRoom, type Room } from '../lib/meeting';
import {
  dateCandidateView,
  isSelectableDate,
  koreanToday,
  millisecondsUntilKoreanMidnight,
  reconcileRegionVoteDraft,
  regionVoteContext,
  validRegionVote,
} from '../lib/meeting-view';

function room(): Room {
  return {
    ...newRoom(
      '친구 모임',
      '방장',
      '2026-09-22',
      '2026-10-12',
      2,
      'all',
      'room-1',
    ),
    members: ['방장', '친구'],
    attendees: ['방장', '친구'],
    regions: ['A', 'B', 'C'],
    stage: 'region',
  };
}

void test('방을 열면 해당 사용자의 저장한 지역 투표를 복원한다', () => {
  const current = room();
  current.votes.친구 = ['A', 'C'];
  const result = reconcileRegionVoteDraft(
    { context: '', choices: [] },
    current,
    '친구',
  );
  assert.deepEqual(result.choices, ['A', 'C']);
  assert.equal(result.context, regionVoteContext(current, '친구'));
});

void test('같은 회차의 폴링과 후보 추가는 제출하지 않은 선택을 유지한다', () => {
  const current = room();
  current.votes.친구 = ['A'];
  const draft = {
    context: regionVoteContext(current, '친구'),
    choices: ['B', 'C'],
  };
  const polled = structuredClone(current);
  polled.votes.방장 = ['A'];
  polled.regions.push('D');
  assert.strictEqual(reconcileRegionVoteDraft(draft, polled, '친구'), draft);
});

void test('결선 전환은 이전 회차의 숨은 후보를 제거하고 새 선택을 허용한다', () => {
  const current = room();
  const draft = {
    context: regionVoteContext(current, '친구'),
    choices: ['A', 'C'],
  };
  const runoff = { ...current, round: 2, tied: ['A', 'B'], votes: {} };
  const result = reconcileRegionVoteDraft(draft, runoff, '친구');
  assert.deepEqual(result.choices, []);
  assert.equal(validRegionVote(runoff, '친구', ['B']), true);
  assert.equal(validRegionVote(runoff, '친구', ['A', 'B']), false);
  assert.equal(validRegionVote(runoff, '친구', ['C']), false);
});

void test('방, 사용자, 날짜 revision 변경은 이전 draft를 이어 쓰지 않는다', () => {
  const current = room();
  const draft = { context: regionVoteContext(current, '친구'), choices: ['A'] };
  for (const next of [
    { ...current, id: 'room-2' },
    { ...current, regionRevision: 1 },
  ]) {
    assert.deepEqual(reconcileRegionVoteDraft(draft, next, '친구').choices, []);
  }
  assert.deepEqual(
    reconcileRegionVoteDraft(draft, current, '방장').choices,
    [],
  );
});

void test('후보가 제거되면 남은 선택만 보존하고 비참석자의 선택은 비운다', () => {
  const current = room();
  const draft = {
    context: regionVoteContext(current, '친구'),
    choices: ['A', 'C'],
  };
  assert.deepEqual(
    reconcileRegionVoteDraft(draft, { ...current, regions: ['A', 'B'] }, '친구')
      .choices,
    ['A'],
  );
  const spectator = { ...current, attendees: ['방장'] };
  assert.deepEqual(
    reconcileRegionVoteDraft(draft, spectator, '친구').choices,
    [],
  );
  assert.equal(validRegionVote(spectator, '친구', ['A']), false);
});

void test('빈 결선 후보와 중복 선택은 제출할 수 없다', () => {
  const current = room();
  assert.equal(validRegionVote(current, '친구', []), false);
  assert.equal(validRegionVote(current, '친구', ['A', 'A']), false);
  assert.equal(
    validRegionVote({ ...current, round: 2, tied: [] }, '친구', ['A']),
    false,
  );
  assert.equal(
    validRegionVote({ ...current, stage: 'tie' }, '친구', ['A']),
    false,
  );
});

void test('지난 날짜를 제외하고 첫 7일과 더보기의 나머지 모든 날짜를 제공한다', () => {
  const current = room();
  const slots = daysBetween(current.start, current.end).flatMap((date) => [
    date + '|점심',
    date + '|저녁',
  ]);
  current.responses = { 방장: slots, 친구: slots };
  const first = dateCandidateView(current, '2026-10-02');
  assert.deepEqual(first.dates, daysBetween('2026-10-02', '2026-10-08'));
  assert.equal(first.hasMore, true);
  assert.equal(first.slots.length, 22);
  const expanded = dateCandidateView(current, '2026-10-02', true);
  assert.deepEqual(expanded.dates, daysBetween('2026-10-02', '2026-10-12'));
  assert.equal(expanded.hasMore, false);
  const last = dateCandidateView(current, '2026-10-12');
  assert.deepEqual(last.dates, ['2026-10-12']);
  assert.equal(last.hasMore, false);
  assert.deepEqual(dateCandidateView(current, '2026-10-13').slots, []);
});

void test('다수 참석 정렬과 실제 가장 이른 날짜를 구분한다', () => {
  const current = room();
  current.mode = 'most';
  current.size = 3;
  current.members.push('친구2');
  current.responses = {
    방장: ['2026-10-02|점심', '2026-10-03|저녁'],
    친구: ['2026-10-02|점심', '2026-10-03|저녁'],
    친구2: ['2026-10-03|저녁'],
  };
  const result = dateCandidateView(current, '2026-10-02');
  assert.deepEqual(result.dates, ['2026-10-03', '2026-10-02']);
  assert.equal(result.earliestDate, '2026-10-02');
});

void test('수동 날짜와 기존에 선택한 슬롯에도 오늘 이후의 기간 제한을 적용한다', () => {
  const current = room();
  assert.equal(isSelectableDate(current, '2026-10-01', '2026-10-02'), false);
  assert.equal(isSelectableDate(current, '2026-10-02', '2026-10-02'), true);
  assert.equal(isSelectableDate(current, '2026-10-13', '2026-10-02'), false);
});

void test('한국 자정과 연도 경계에서 날짜와 다음 갱신 시각을 계산한다', () => {
  const before = new Date('2026-12-31T14:59:59.000Z');
  const midnight = new Date('2026-12-31T15:00:00.000Z');
  assert.equal(koreanToday(before), '2026-12-31');
  assert.equal(millisecondsUntilKoreanMidnight(before), 1000);
  assert.equal(koreanToday(midnight), '2027-01-01');
  assert.equal(millisecondsUntilKoreanMidnight(midnight), 86_400_000);
});
