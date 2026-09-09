import { addDays, daysBetween, tallyRegion, type Room } from './meeting';

export type Action = { type: string; [key: string]: unknown };
const fail = (message: string): never => {
  throw new Error(message);
};
const requireThat = (
  condition: unknown,
  message = '지금은 이 작업을 할 수 없어요.',
) => {
  if (!condition) fail(message);
};
export const koreanToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const expiresOn = (r: Room) =>
  r.date ? addDays(r.date.split('|')[0], 2) : addDays(r.end, 1);
export function applyAction(source: Room, user: string, a: Action): Room {
  const r: Room = structuredClone(source);
  requireThat(
    r.stage !== 'closed' && koreanToday() < expiresOn(r),
    '종료된 모임이에요.',
  );
  if (a.type === 'join') {
    if (r.members.includes(user)) return r;
    requireThat(
      r.stage === 'schedule' && r.members.length < r.size,
      '정원이 찼거나 일정 투표가 끝났어요.',
    );
    r.members.push(user);
    return r;
  }
  requireThat(r.members.includes(user), '이 모임의 참여자가 아니에요.');
  const host = () => requireThat(r.host === user, '방장만 할 수 있어요.');
  switch (a.type) {
    case 'schedule': {
      requireThat(r.stage === 'schedule');
      const valid = daysBetween(r.start, r.end).flatMap((d) => [
        d + '|점심',
        d + '|저녁',
      ]);
      requireThat(
        Array.isArray(a.slots) &&
          a.slots.length <= 62 &&
          a.slots.every((s) => valid.includes(s)),
      );
      r.responses[user] = [...new Set(a.slots as string[])];
      if (
        r.members.length === r.size &&
        r.members.every((m) => m in r.responses)
      )
        r.stage = 'date';
      break;
    }
    case 'date': {
      host();
      requireThat(r.stage === 'date');
      requireThat(
        typeof a.slot === 'string' &&
          /^\d{4}-\d{2}-\d{2}\|(점심|저녁)$/.test(a.slot),
      );
      const slot = a.slot as string,
        date = slot.split('|')[0];
      requireThat(date >= r.start && date <= r.end && date >= koreanToday());
      const attendees = r.members.filter((m) => r.responses[m]?.includes(slot));
      requireThat(a.manual === true || attendees.length >= 2);
      r.date = slot;
      r.attendees = a.manual ? [] : attendees;
      r.stage = a.manual ? 'confirm' : 'region';
      r.confirmations = {};
      r.votes = {};
      break;
    }
    case 'confirm':
      requireThat(r.stage === 'confirm' && typeof a.value === 'boolean');
      r.confirmations = { ...r.confirmations, [user]: a.value as boolean };
      r.attendees = r.members.filter((m) => r.confirmations![m]);
      if (
        r.members.every((m) => m in r.confirmations!) &&
        r.attendees.length >= 2
      )
        r.stage = 'region';
      break;
    case 'vote': {
      requireThat(
        r.stage === 'region' &&
          r.attendees.includes(user) &&
          a.round === r.round,
        '마감되었거나 지난 회차의 투표예요. 새로 확인해 주세요.',
      );
      const choices = r.round > 1 ? r.tied! : r.regions;
      requireThat(
        Array.isArray(a.choices) &&
          a.choices.length >= 1 &&
          a.choices.length <= (r.round > 1 ? 1 : 2) &&
          new Set(a.choices).size === a.choices.length &&
          a.choices.every((v) => choices.includes(v)),
      );
      r.votes[user] = a.choices as string[];
      return tallyRegion(r);
    }
    case 'region':
      requireThat(
        r.stage === 'region' && r.round === 1 && !Object.keys(r.votes).length,
      );
      requireThat(
        typeof a.name === 'string' &&
          a.name.trim().length > 0 &&
          a.name.length <= 25 &&
          !r.regions.includes(a.name),
      );
      r.regions.push((a.name as string).trim());
      break;
    case 'runoff':
      host();
      requireThat(r.stage === 'tie');
      r.stage = 'region';
      r.round++;
      r.votes = {};
      break;
    case 'random': {
      host();
      requireThat(r.stage === 'tie' && r.tied?.length);
      const n = r.tied!.length,
        limit = Math.floor(4294967296 / n) * n;
      let value: number;
      do {
        value = crypto.getRandomValues(new Uint32Array(1))[0];
      } while (value >= limit);
      r.region = r.tied![value % n];
      r.stage = 'final';
      break;
    }
    case 'transfer':
      host();
      requireThat(typeof a.member === 'string' && r.members.includes(a.member));
      r.host = a.member as string;
      break;
    case 'remove': {
      const member = a.member as string;
      if (member !== user) host();
      requireThat(
        member !== r.host && r.members.includes(member),
        '방장은 먼저 방장을 넘겨 주세요.',
      );
      r.members = r.members.filter((m) => m !== member);
      r.attendees = r.attendees.filter((m) => m !== member);
      delete r.responses[member];
      delete r.votes[member];
      delete r.confirmations?.[member];
      delete r.emails[member];
      if (r.stage === 'region') return tallyRegion(r);
      break;
    }
    case 'close':
      host();
      r.stage = 'closed';
      break;
    case 'addLink': {
      requireThat(
        r.stage === 'final' &&
          typeof a.url === 'string' &&
          a.url.length <= 4096 &&
          typeof a.name === 'string' &&
          a.name.length <= 120 &&
          ['food', 'cafe'].includes(a.category as string),
      );
      const url = new URL(a.url as string);
      requireThat(['https:', 'http:'].includes(url.protocol));
      requireThat(
        !r.links.some((l) => l.url === url.href && l.category === a.category),
        '이미 추가한 링크예요.',
      );
      r.links.push({
        id: crypto.randomUUID(),
        author: user,
        url: url.href,
        name: a.name as string,
        category: a.category as 'food' | 'cafe',
      });
      break;
    }
    case 'deleteLink': {
      requireThat(r.stage === 'final');
      const link = r.links.find((l) => l.id === a.id);
      requireThat(link && (link.author === user || r.host === user));
      r.links = r.links.filter((l) => l.id !== a.id);
      break;
    }
    default:
      fail('지원하지 않는 작업이에요.');
  }
  return r;
}
