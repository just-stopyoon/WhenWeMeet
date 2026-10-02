import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newRoom, tallyRegion, type Room } from '../lib/meeting';

function votingRoom(votes: Room['votes']): Room {
  return {
    ...newRoom(
      '지역 투표',
      '방장',
      '2099-01-01',
      '2099-01-14',
      3,
      'all',
      'test',
    ),
    stage: 'region',
    members: ['방장', '친구', '관전자'],
    attendees: ['방장', '친구'],
    votes,
  };
}

for (const region of [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
]) {
  void test(`${region} 지역을 전원이 고르면 정상 확정한다`, () => {
    const source = votingRoom({ 방장: [region], 친구: [region] });
    const original = structuredClone(source);
    const updated = tallyRegion(source);
    assert.equal(updated.stage, 'final');
    assert.equal(updated.region, region);
    assert.deepEqual(updated.tied, [region]);
    assert.deepEqual(source, original);
  });

  void test(`${region} 지역과 일반 지역이 동률이면 양쪽 표를 보존한다`, () => {
    const updated = tallyRegion(votingRoom({ 방장: [region], 친구: ['연남'] }));
    assert.equal(updated.stage, 'tie');
    assert.equal(updated.region, undefined);
    assert.deepEqual(new Set(updated.tied), new Set([region, '연남']));
  });
}

void test('1차 투표의 복수 선택은 각각 집계한다', () => {
  const updated = tallyRegion(
    votingRoom({ 방장: ['연남', '건대, 성수'], 친구: ['연남'] }),
  );
  assert.equal(updated.stage, 'final');
  assert.equal(updated.region, '연남');
});

void test('참석자 투표만 집계하고 관전자 표는 결과에 포함하지 않는다', () => {
  const updated = tallyRegion(
    votingRoom({
      방장: ['연남'],
      친구: ['건대, 성수'],
      관전자: ['건대, 성수'],
    }),
  );
  assert.equal(updated.stage, 'tie');
  assert.deepEqual(new Set(updated.tied), new Set(['연남', '건대, 성수']));
});

void test('미제출 참석자 또는 참석자 부재가 있으면 투표를 마감하지 않는다', () => {
  const pending = votingRoom({ 방장: ['연남'] });
  assert.equal(tallyRegion(pending), pending);
  const empty = { ...pending, attendees: [] };
  assert.equal(tallyRegion(empty), empty);
});

void test('재투표도 특수 이름을 포함한 우승 후보를 집계한다', () => {
  const source = {
    ...votingRoom({ 방장: ['__proto__'], 친구: ['__proto__'] }),
    round: 2,
    tied: ['__proto__', '연남'],
  };
  const updated = tallyRegion(source);
  assert.equal(updated.stage, 'final');
  assert.equal(updated.region, '__proto__');
});
