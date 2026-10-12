import test from 'node:test';
import assert from 'node:assert/strict';
import { memberLabel, newRoom } from '../lib/meeting';

void test('기존 이름은 유지하고 동일 닉네임은 아이디로 구분한다', () => {
  const room = newRoom(
    '모임',
    'legacy',
    '2026-10-12',
    '2026-10-20',
    3,
    'all',
    'id',
  );
  assert.equal(memberLabel(room, 'legacy'), 'legacy');
  room.members.push('new-user', 'third-user');
  room.memberNames = {
    legacy: '친구',
    'new-user': '친구',
    'third-user': '다른 친구',
  };
  assert.equal(memberLabel(room, 'legacy'), '친구 (legacy)');
  assert.equal(memberLabel(room, 'new-user'), '친구 (new-user)');
  assert.equal(memberLabel(room, 'third-user'), '다른 친구');
  assert.deepEqual(room.members, ['legacy', 'new-user', 'third-user']);
});
