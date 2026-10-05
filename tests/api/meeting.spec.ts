import {
  test,
  expect,
  action,
  addDays,
  createRoom,
  expectError,
  getRoom,
  listRooms,
  postAction,
  postRawAction,
  prepareRoom,
  slotsFor,
  today,
  type Room,
  type MeetingRequest,
  type TestAccount,
} from '../support/fixtures';

const vote = (
  room: Room,
  choices: readonly string[],
): Extract<MeetingRequest, { type: 'vote' }> => ({
  type: 'vote',
  roomId: room.id,
  choices,
  round: room.round,
  regionRevision: room.regionRevision ?? 0,
});
async function enterRegion(
  accounts: readonly TestAccount[],
  schedules?: readonly (readonly string[])[],
) {
  const room = await prepareRoom(
    accounts,
    { start: addDays(today(), 1), mode: schedules ? 'most' : 'all' },
    schedules,
  );
  return action(accounts[0], {
    type: 'date',
    roomId: room.id,
    slot: `${room.start}|점심`,
  });
}

test('전원 참가와 제출을 기다리며 빈 일정도 제출로 센다', async ({
  accounts,
}) => {
  const [host, friend, other] = accounts;
  let room = await createRoom(host, { start: addDays(today(), 1) });
  await action(friend, { type: 'join', code: room.code });
  const slot = slotsFor(room)[0];
  await Promise.all([
    action(host, { type: 'schedule', roomId: room.id, slots: [] }),
    action(friend, { type: 'schedule', roomId: room.id, slots: [slot, slot] }),
  ]);
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('schedule');
  expect(room.responses[host.name]).toEqual([]);
  expect(room.responses[friend.name]).toEqual([slot]);
  await action(other, { type: 'join', code: room.code });
  await expectError(
    await postAction(other, {
      type: 'schedule',
      roomId: room.id,
      slots: [`${addDays(room.end, 1)}|점심`],
    }),
    400,
  );
  room = await action(other, {
    type: 'schedule',
    roomId: room.id,
    slots: [slot],
  });
  expect(room.stage).toBe('date');
  expect(Object.keys(room.responses).sort()).toEqual(
    accounts.map((account) => account.name).sort(),
  );
  await expectError(
    await postAction(friend, { type: 'date', roomId: room.id, slot }),
    400,
    /방장만/,
  );
  await action(host, { type: 'close', roomId: room.id });
});

for (const attending of [0, 1]) {
  test(`수동 날짜 참석 ${attending}명 이후 방장이 재선택할 수 있다`, async ({
    accounts,
  }) => {
    const [host, friend] = accounts;
    const ready = await prepareRoom(accounts, { start: addDays(today(), 1) });
    const slot = `${ready.start}|점심`;
    let room = await action(host, {
      type: 'date',
      roomId: ready.id,
      slot,
      manual: true,
    });
    await Promise.all(
      accounts.map((account, index) =>
        action(account, {
          type: 'confirm',
          roomId: room.id,
          value: index < attending,
          regionRevision: 0,
        }),
      ),
    );
    room = await getRoom(host, room.id);
    expect(room.stage).toBe('confirm');
    expect(room.attendees).toHaveLength(attending);
    await expectError(
      await postAction(friend, { type: 'reopenDate', roomId: room.id }),
      400,
      /방장만/,
    );
    room = await action(host, { type: 'reopenDate', roomId: room.id });
    expect(room.stage).toBe('date');
    expect(room.date).toBeUndefined();
    expect(room.confirmations).toEqual({});
    expect(room.attendees).toEqual([]);
    expect(room.votes).toEqual({});
    expect(room.round).toBe(1);
    expect(room.regionRevision).toBe(1);
    expect(room.responses).toEqual(ready.responses);
    expect(room.regions).toEqual(ready.regions);
    await action(host, { type: 'date', roomId: room.id, slot, manual: true });
    for (const stale of [{ regionRevision: 0 }, {}])
      await expectError(
        await postAction(friend, {
          type: 'confirm',
          roomId: room.id,
          value: true,
          ...stale,
        }),
        400,
        /지난 날짜/,
      );
    room = await action(friend, {
      type: 'confirm',
      roomId: room.id,
      value: true,
      regionRevision: 1,
    });
    expect(room.confirmations).toEqual({ [friend.name]: true });
    await action(host, { type: 'close', roomId: room.id });
  });
}

test('마지막 미응답자 제거 후 남은 찬성자는 즉시 지역 투표로 이동한다', async ({
  accounts,
}) => {
  const [host, friend, pending] = accounts;
  let room = await prepareRoom(accounts, { start: addDays(today(), 1) });
  room = await action(host, {
    type: 'date',
    roomId: room.id,
    slot: `${room.start}|점심`,
    manual: true,
  });
  await Promise.all(
    [host, friend].map((account) =>
      action(account, {
        type: 'confirm',
        roomId: room.id,
        value: true,
        regionRevision: 0,
      }),
    ),
  );
  expect((await getRoom(host, room.id)).stage).toBe('confirm');
  await expectError(
    await postAction(friend, {
      type: 'remove',
      roomId: room.id,
      member: pending.name,
    }),
    400,
    /방장만/,
  );
  room = await action(host, {
    type: 'remove',
    roomId: room.id,
    member: pending.name,
  });
  expect(room.stage).toBe('region');
  expect(new Set(room.attendees)).toEqual(new Set([host.name, friend.name]));
  expect(room.size).toBe(3);
  expect(room.responses[pending.name]).toBeUndefined();
  expect((await listRooms(pending)).some((entry) => entry.id === room.id)).toBe(
    false,
  );
  await expectError(
    await postAction(pending, vote(room, ['연남'])),
    400,
    /참여자가 아니/,
  );
  await action(host, { type: 'close', roomId: room.id });
});

test('미응답자가 직접 탈퇴해도 확인을 재계산하고 방장은 위임 후 나간다', async ({
  accounts,
}) => {
  const [host, friend, pending] = accounts;
  let room = await prepareRoom(accounts, { start: addDays(today(), 1) });
  await action(host, {
    type: 'date',
    roomId: room.id,
    slot: `${room.start}|점심`,
    manual: true,
  });
  for (const account of [host, friend])
    await action(account, {
      type: 'confirm',
      roomId: room.id,
      value: true,
      regionRevision: 0,
    });
  const left = await postAction(pending, {
    type: 'remove',
    roomId: room.id,
    member: pending.name,
  });
  expect(left.status()).toBe(200);
  expect(await left.json()).toEqual({ room: null });
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('region');
  await expectError(
    await postAction(host, {
      type: 'remove',
      roomId: room.id,
      member: host.name,
    }),
    400,
    /방장은 먼저/,
  );
  await action(host, {
    type: 'transfer',
    roomId: room.id,
    member: friend.name,
  });
  const hostLeft = await postAction(host, {
    type: 'remove',
    roomId: room.id,
    member: host.name,
  });
  expect(hostLeft.status()).toBe(200);
  expect((await getRoom(friend, room.id)).members).toEqual([friend.name]);
  await action(friend, { type: 'close', roomId: room.id });
});

for (const revision of [undefined, null]) {
  test(`참석 확인과 지역 투표는 revision ${revision === null ? 'null' : '생략'}을 0으로 처리하고 재선택 후 거절한다`, async ({
    accounts,
  }) => {
    const [host, friend] = accounts;
    let room = await prepareRoom(accounts, { start: addDays(today(), 1) });
    const slot = `${room.start}|점심`;
    room = await action(host, {
      type: 'date',
      roomId: room.id,
      slot,
      manual: true,
    });
    await expectError(
      await postRawAction(host, {
        type: 'confirm',
        roomId: room.id,
        value: 'true',
        regionRevision: revision,
      }),
      400,
    );
    for (const [index, account] of accounts.entries())
      room = await action(account, {
        type: 'confirm',
        roomId: room.id,
        value: index < 2,
        regionRevision: revision,
      });
    expect(room.stage).toBe('region');
    expect(room.attendees).toEqual([host.name, friend.name]);
    room = await action(host, {
      ...vote(room, ['연남']),
      regionRevision: revision,
    });
    expect(room.votes).toEqual({ [host.name]: ['연남'] });

    room = await action(host, { type: 'reopenDate', roomId: room.id });
    expect(room.regionRevision).toBe(1);
    await action(host, { type: 'date', roomId: room.id, slot, manual: true });
    await expectError(
      await postAction(friend, {
        type: 'confirm',
        roomId: room.id,
        value: true,
        regionRevision: revision,
      }),
      400,
      /지난 날짜/,
    );
    expect((await getRoom(host, room.id)).confirmations).toEqual({});
    for (const [index, account] of accounts.entries())
      room = await action(account, {
        type: 'confirm',
        roomId: room.id,
        value: index < 2,
        regionRevision: 1,
      });
    await expectError(
      await postAction(host, {
        ...vote(room, ['연남']),
        regionRevision: revision,
      }),
      400,
      /지난 회차/,
    );
    await expectError(
      await postRawAction(host, {
        type: 'vote',
        roomId: room.id,
        choices: ['연남'],
        regionRevision: 1,
      }),
      400,
      /지난 회차/,
    );
    expect((await getRoom(host, room.id)).votes).toEqual({});
    room = await action(host, vote(room, ['연남']));
    expect(room.votes).toEqual({ [host.name]: ['연남'] });
    await action(host, { type: 'close', roomId: room.id });
  });
}

test('동시 지역 투표를 보존하고 재투표에서 이전 회차를 거절한다', async ({
  accounts,
}) => {
  const [host, friend] = accounts;
  let room = await enterRegion(accounts);
  for (const name of ['A', 'B', 'C'])
    room = await action(host, { type: 'region', roomId: room.id, name });
  const choices = [['A', 'C'], ['A', 'B'], ['B']];
  await Promise.all(
    accounts.map((account, index) =>
      action(account, vote(room, choices[index])),
    ),
  );
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('tie');
  expect(new Set(room.tied)).toEqual(new Set(['A', 'B']));
  expect(room.votes).toEqual(
    Object.fromEntries(
      accounts.map((account, index) => [account.name, choices[index]]),
    ),
  );
  await expectError(
    await postAction(friend, { type: 'runoff', roomId: room.id }),
    400,
    /방장만/,
  );
  room = await action(host, { type: 'runoff', roomId: room.id });
  expect(room.round).toBe(2);
  expect(room.votes).toEqual({});
  for (const invalid of [
    { round: 1 },
    { regionRevision: 1 },
    { choices: ['A', 'B'] },
    { choices: ['C'] },
  ])
    await expectError(
      await postAction(friend, { ...vote(room, ['A']), ...invalid }),
      400,
    );
  await expectError(
    await postAction(host, { type: 'region', roomId: room.id, name: 'D' }),
    400,
    /1차 지역 투표/,
  );
  await Promise.all(
    accounts.map((account, index) =>
      action(account, vote(room, [index === 2 ? 'B' : 'A'])),
    ),
  );
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('final');
  expect(room.region).toBe('A');
  expect(Object.keys(room.votes)).toHaveLength(3);
  await expectError(
    await postAction(host, { type: 'reopenDate', roomId: room.id }),
    400,
  );
  await action(host, { type: 'close', roomId: room.id });
});

test('지역 투표 도중 날짜를 재선택하면 이전 revision의 표를 거절한다', async ({
  accounts,
}) => {
  const [host, friend] = accounts;
  const previous = await enterRegion(accounts);
  await action(friend, vote(previous, ['연남']));
  let room = await action(host, { type: 'reopenDate', roomId: previous.id });
  expect(room.votes).toEqual({});
  room = await action(host, {
    type: 'date',
    roomId: room.id,
    slot: `${room.start}|저녁`,
  });
  await expectError(
    await postAction(friend, vote(previous, ['연남'])),
    400,
    /지난 회차/,
  );
  room = await action(friend, vote(room, ['연남']));
  expect(room.votes).toEqual({ [friend.name]: ['연남'] });
  await action(host, { type: 'close', roomId: room.id });
});

for (const name of ['constructor', '__proto__', 'toString']) {
  test(`특수 지역 이름 ${name}도 실제 D1 투표로 확정한다`, async ({
    accounts,
  }) => {
    const [host, friend] = accounts;
    let room = await enterRegion([host, friend]);
    room = await action(friend, { type: 'region', roomId: room.id, name });
    await Promise.all([
      action(host, vote(room, [name])),
      action(friend, vote(room, [name])),
    ]);
    room = await getRoom(host, room.id);
    expect(room.stage).toBe('final');
    expect(room.region).toBe(name);
    expect(room.tied).toEqual([name]);
    await action(host, { type: 'close', roomId: room.id });
  });
}

test('특수 지역과 일반 지역의 동률은 방장 추첨으로 확정한다', async ({
  accounts,
}) => {
  const [host, friend] = accounts;
  let room = await enterRegion([host, friend]);
  room = await action(host, {
    type: 'region',
    roomId: room.id,
    name: '__proto__',
  });
  await Promise.all([
    action(host, vote(room, ['__proto__'])),
    action(friend, vote(room, ['연남'])),
  ]);
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('tie');
  expect(new Set(room.tied)).toEqual(new Set(['__proto__', '연남']));
  await expectError(
    await postAction(friend, { type: 'random', roomId: room.id }),
    400,
    /방장만/,
  );
  room = await action(host, { type: 'random', roomId: room.id });
  expect(room.stage).toBe('final');
  expect(['__proto__', '연남']).toContain(room.region);
  await action(host, { type: 'close', roomId: room.id });
});

test('비참석 방장은 후보를 추가할 수 있지만 지역 투표에는 참여하지 못한다', async ({
  accounts,
}) => {
  const [host, friend, other] = accounts;
  const start = addDays(today(), 1);
  const slot = `${start}|점심`;
  let room = await enterRegion(accounts, [[], [slot], [slot]]);
  expect(new Set(room.attendees)).toEqual(new Set([friend.name, other.name]));
  room = await action(host, {
    type: 'region',
    roomId: room.id,
    name: '관전자 후보',
  });
  await expectError(await postAction(host, vote(room, ['관전자 후보'])), 400);
  await Promise.all([
    action(friend, vote(room, ['관전자 후보'])),
    action(other, vote(room, ['관전자 후보'])),
  ]);
  room = await getRoom(host, room.id);
  expect(room.stage).toBe('final');
  expect(room.region).toBe('관전자 후보');
  expect(room.votes[host.name]).toBeUndefined();
  await action(host, { type: 'close', roomId: room.id });
});

test('최종 링크는 함께 조회하며 작성자와 방장만 삭제한다', async ({
  accounts,
}) => {
  const [host, author, other] = accounts;
  let room = await enterRegion(accounts);
  await expectError(
    await postAction(author, {
      type: 'addLink',
      roomId: room.id,
      url: 'https://example.com/before-final',
      name: '확정 전 링크',
      category: 'food',
    }),
    400,
  );
  await Promise.all(
    accounts.map((account) => action(account, vote(room, ['연남']))),
  );
  room = await getRoom(host, room.id);
  room = await action(author, {
    type: 'addLink',
    roomId: room.id,
    url: 'https://example.com/shared-food',
    name: '함께 볼 음식점',
    category: 'food',
  });
  const link = room.links[0];
  expect((await getRoom(other, room.id)).links).toEqual([link]);
  await expectError(
    await postAction(other, {
      type: 'deleteLink',
      roomId: room.id,
      id: link.id,
    }),
    400,
  );
  await expectError(
    await postAction(host, {
      type: 'addLink',
      roomId: room.id,
      url: link.url,
      name: '중복 링크',
      category: 'food',
    }),
    400,
    /이미 추가/,
  );
  for (const deleter of [author, host]) {
    room = await action(deleter, {
      type: 'deleteLink',
      roomId: room.id,
      id: room.links[0].id,
    });
    expect(room.links).toEqual([]);
    if (deleter === author)
      room = await action(author, {
        type: 'addLink',
        roomId: room.id,
        url: 'https://example.com/shared-cafe',
        name: '함께 볼 카페',
        category: 'cafe',
      });
  }
  await expectError(
    await postAction(author, {
      type: 'addLink',
      roomId: room.id,
      url: 'javascript:alert(1)',
      name: '지원하지 않는 주소',
      category: 'food',
    }),
    400,
  );
  room = await action(author, {
    type: 'addLink',
    roomId: room.id,
    url: 'https://example.com/unnamed-place',
    name: '',
    category: 'food',
  });
  expect(room.links).toHaveLength(1);
  expect(room.links[0].name).toBe('');
  await expectError(
    await postRawAction(author, {
      type: 'addLink',
      roomId: room.id,
      url: 'https://example.com/missing-name',
      category: 'food',
    }),
    400,
  );
  expect((await getRoom(other, room.id)).links).toEqual(room.links);
  await action(host, { type: 'close', roomId: room.id });
});
