import { addDays, aggregate, type Room } from './meeting';

export const koreanToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export function millisecondsUntilKoreanMidnight(now = new Date()) {
  const tomorrow = addDays(koreanToday(now), 1);
  return Date.parse(tomorrow + 'T00:00:00+09:00') - now.getTime();
}

export function isSelectableDate(room: Room, date: string, today: string) {
  return date >= room.start && date <= room.end && date >= today;
}

export function dateCandidateView(room: Room, today: string, expanded = false) {
  const slots = aggregate(room).filter(({ slot }) =>
    isSelectableDate(room, slot.split('|')[0], today),
  );
  const dates = [...new Set(slots.map(({ slot }) => slot.split('|')[0]))];
  return {
    slots,
    dates: expanded ? dates : dates.slice(0, 7),
    hasMore: !expanded && dates.length > 7,
    earliestDate: [...dates].sort()[0],
  };
}

export type RegionVoteDraft = { context: string; choices: string[] };

export const regionVoteContext = (room: Room, user: string) =>
  JSON.stringify([room.id, user, room.round, room.regionRevision ?? 0]);

export const regionVoteOptions = (room: Room) =>
  room.round > 1 ? room.tied || [] : room.regions;

export function validRegionVote(room: Room, user: string, choices: string[]) {
  const options = regionVoteOptions(room);
  return (
    room.stage === 'region' &&
    room.attendees.includes(user) &&
    choices.length >= 1 &&
    choices.length <= (room.round > 1 ? 1 : 2) &&
    new Set(choices).size === choices.length &&
    choices.every((choice) => options.includes(choice))
  );
}

export function reconcileRegionVoteDraft(
  draft: RegionVoteDraft,
  room: Room,
  user: string,
): RegionVoteDraft {
  const context = regionVoteContext(room, user);
  const source =
    draft.context === context ? draft.choices : room.votes[user] || [];
  const options = regionVoteOptions(room);
  const choices = room.attendees.includes(user)
    ? [...new Set(source)]
        .filter((choice) => options.includes(choice))
        .slice(0, room.round > 1 ? 1 : 2)
    : [];
  if (
    draft.context === context &&
    choices.length === draft.choices.length &&
    choices.every((choice, index) => choice === draft.choices[index])
  )
    return draft;
  return { context, choices };
}
