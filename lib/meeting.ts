export const REGIONS = [
  '홍대, 신촌',
  '건대, 성수',
  '잠실, 송파',
  '강남, 역삼',
  '압구정, 로데오',
  '이태원, 한남',
  '용산, 삼각지',
  '신사, 논현',
  '명동, 을지로',
  '합정, 망원',
  '연남',
];
export type Account = { name: string; hash: string };
export type Room = {
  id: string;
  code: string;
  title: string;
  start: string;
  end: string;
  size: number;
  mode: 'all' | 'most';
  host: string;
  members: string[];
  responses: Record<string, string[]>;
  stage:
    | 'schedule'
    | 'date'
    | 'confirm'
    | 'region'
    | 'tie'
    | 'final'
    | 'closed';
  regions: string[];
  votes: Record<string, string[]>;
  round: number;
  attendees: string[];
  date?: string;
  region?: string;
  tied?: string[];
  confirmations?: Record<string, boolean>;
  links: {
    id: string;
    url: string;
    name: string;
    category: 'food' | 'cafe';
    author: string;
  }[];
  emails: Record<string, string>;
  demo?: boolean;
};
export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function addDays(date: string, n: number) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return iso(d);
}
export const labelDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
export function daysBetween(start: string, end: string) {
  const dates: string[] = [];
  if (!start || !end) return dates;
  let d = start;
  while (d <= end && dates.length < 367) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}
export function newRoom(
  title: string,
  user: string,
  start: string,
  end: string,
  size: number,
  mode: 'all' | 'most',
  id: string,
): Room {
  return {
    id,
    code: id.slice(0, 6).toUpperCase(),
    title,
    start,
    end,
    size,
    mode,
    host: user,
    members: [user],
    responses: {},
    stage: 'schedule',
    regions: [...REGIONS],
    votes: {},
    round: 1,
    attendees: [],
    links: [],
    emails: {},
  };
}
export function seedRoom(today: string): Room {
  const r = newRoom(
    '오랜만에 우리 다섯 🍀',
    '양파',
    today,
    addDays(today, 13),
    5,
    'all',
    'demo',
  );
  const available = daysBetween(r.start, r.end).flatMap((day) => [
    day + '|점심',
    day + '|저녁',
  ]);
  return {
    ...r,
    code: 'MEET05',
    members: ['양파', '민지', '준호', '수빈', '지훈'],
    responses: { 민지: available, 준호: available, 수빈: available },
    demo: true,
  };
}
export function aggregate(r: Room) {
  return daysBetween(r.start, r.end)
    .flatMap((day) => [day + '|점심', day + '|저녁'])
    .map((slot) => ({
      slot,
      count: r.members.filter((m) => r.responses[m]?.includes(slot)).length,
    }))
    .filter((c) => (r.mode === 'all' ? c.count === r.size : c.count >= 2))
    .sort(
      (a, b) =>
        (r.mode === 'most' ? b.count - a.count : 0) ||
        a.slot.localeCompare(b.slot),
    );
}
export function tallyRegion(r: Room): Room {
  if (!r.attendees.length || !r.attendees.every((m) => r.votes[m])) return r;
  const tally = r.attendees
    .flatMap((m) => r.votes[m])
    .reduce<Record<string, number>>(
      (a, b) => ((a[b] = (a[b] || 0) + 1), a),
      {},
    );
  const max = Math.max(...Object.values(tally));
  const tied = Object.keys(tally).filter((k) => tally[k] === max);
  return {
    ...r,
    tied,
    stage: tied.length === 1 ? 'final' : 'tie',
    region: tied.length === 1 ? tied[0] : undefined,
  };
}
