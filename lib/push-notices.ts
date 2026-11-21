// Who is told what when a room changes stage (issue #14 T3, meeting Q1·Q7,
// spec R6). Pure: the server calls it with the row it read, the room it saved
// and the acting account. Only the room title, the chosen date and the final
// region go into a notice; nicknames, account IDs and invite codes never do.

import { labelDate, type Room } from './meeting';

export type PushNotice = {
  account: string;
  title: string;
  body: string;
  roomId: string;
  url: string;
};

type Rule = { recipients: string[]; body: string };

const dateText = (slot: string) => {
  const [date, meal] = slot.split('|');
  return `${labelDate(date)} ${meal}`;
};

function rule(before: Room, after: Room): Rule | null {
  // No stage change, no notice (votes, new candidates, links, ...). The
  // runoff is a change too: `tie` → `region`.
  if (before.stage === after.stage) return null;
  const date = after.date ? dateText(after.date) : undefined;
  if (before.stage === 'schedule' && after.stage === 'date')
    return {
      recipients: [after.host],
      body: '모두 일정을 제출했어요. 날짜를 정해 주세요.',
    };
  // Every rule below names the chosen date; a room without one sends nothing.
  if (!date) return null;
  if (after.stage === 'confirm')
    return {
      recipients: after.members.filter((member) => member !== after.host),
      body: `${date}에 올 수 있는지 알려 주세요.`,
    };
  if (
    after.stage === 'region' &&
    (before.stage === 'date' || before.stage === 'confirm')
  )
    return {
      recipients: after.attendees,
      body: `날짜가 정해졌어요 · ${date}. 지역을 투표해 주세요.`,
    };
  if (after.stage === 'region' && before.stage === 'tie')
    return {
      recipients: after.attendees,
      body: `${date} · 동률 후보로 다시 투표해요. 한 곳을 골라 주세요.`,
    };
  if (after.stage === 'tie')
    return {
      recipients: [after.host],
      body: `${date} · 지역 투표가 동률이에요. 재투표나 무작위 선택을 골라 주세요.`,
    };
  if (after.stage === 'final' && after.region)
    return {
      recipients: after.members,
      body: `약속이 정해졌어요 · ${date} · ${after.region}`,
    };
  // Not in the table: e.g. back to `date` (reopenDate) or `closed`.
  return null;
}

export function pushNotices(
  before: Room,
  after: Room,
  actor: string,
): PushNotice[] {
  const found = rule(before, after);
  if (!found) return [];
  const url = `/?room=${after.id}`;
  return [...new Set(found.recipients)]
    .filter((account) => account !== actor && after.members.includes(account))
    .map((account) => ({
      account,
      title: after.title,
      body: found.body,
      roomId: after.id,
      url,
    }));
}

// The service worker shows `title` and `body`, replaces an older notice with
// the same `tag` (one per room) and opens `url` on click.
export function pushPayload(notice: PushNotice): string {
  return JSON.stringify({
    title: notice.title,
    body: notice.body,
    tag: notice.roomId,
    url: notice.url,
  });
}
