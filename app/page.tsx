'use client';
import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  ChevronRight,
  ChevronLeft,
  CalendarDays,
  MapPin,
  Link2,
  Users,
  Check,
  X,
  MoreHorizontal,
  Sun,
  Moon,
  Mail,
  Copy,
  LogOut,
  Coffee,
  Utensils,
  Sparkles,
  PartyPopper,
  Heart,
  CheckCheck,
} from 'lucide-react';
import {
  seedRoom,
  newRoom,
  aggregate,
  tallyRegion,
  iso,
  addDays,
  labelDate,
  daysBetween,
  type Room,
  type Account,
} from '../lib/meeting';
type View = 'home' | 'login' | 'create' | 'join' | 'room';
type Sheet =
  | null
  | 'email'
  | 'members'
  | 'invite'
  | 'settings'
  | 'link'
  | 'addRegion'
  | 'attendees';
const KEY = 'when-meet-prototype-v1';
const today = iso(new Date());
const hashPin = async (pin: string, nick: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(nick + ':' + pin),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span className={'avatar c' + (index % 5)}>{name[0]}</span>;
}
function Heading({
  title,
  desc,
  eyebrow,
}: {
  title: string;
  desc?: string;
  eyebrow?: string;
}) {
  return (
    <div className="heading">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1>
        {title.split('\n').map((s, i) => (
          <span key={i}>
            {s}
            <br />
          </span>
        ))}
      </h1>
      {desc && <p>{desc}</p>}
    </div>
  );
}
function CTA({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="bottom-action">
      <button className="primary" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </div>
  );
}
export default function Home() {
  const [ready, setReady] = useState(false),
    [rooms, setRooms] = useState<Room[]>([]),
    [accounts, setAccounts] = useState<Account[]>([]),
    [user, setUser] = useState('양파'),
    [view, changeView] = useState<View>('home'),
    [active, setActive] = useState('demo');
  const [sheet, changeSheet] = useState<Sheet>(null),
    [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [input, setInput] = useState(''),
    [nick, setNick] = useState(''),
    [pin, setPin] = useState('');
  const [name, setName] = useState(''),
    [start, setStart] = useState(today),
    [end, setEnd] = useState(addDays(today, 13)),
    [size, setSize] = useState(5),
    [mode, setMode] = useState<'all' | 'most'>('all'),
    [code, setCode] = useState('');
  const [chosen, setChosen] = useState(today),
    [month, setMonth] = useState(today.slice(0, 7)),
    [selected, setSelected] = useState<string[]>([]),
    [regionVotes, setRegionVotes] = useState<string[]>([]),
    [customDate, setCustomDate] = useState('');
  const [category, setCategory] = useState<'food' | 'cafe'>('food'),
    [linkName, setLinkName] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  function setView(v: View) {
    setError('');
    changeView(v);
  }
  function setSheet(v: Sheet) {
    setInput('');
    setError('');
    changeSheet(v);
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const d = JSON.parse(raw);
          setRooms(d.rooms);
          setAccounts(d.accounts);
          setUser(d.user || '');
          if (!d.user) setView('login');
        } else setRooms([seedRoom(today)]);
      } catch {
        setRooms([seedRoom(today)]);
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (ready)
      localStorage.setItem(KEY, JSON.stringify({ rooms, accounts, user }));
  }, [ready, rooms, accounts, user]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 2800);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  useEffect(() => {
    if (!sheet) return;
    dialogRef.current?.showModal();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    document.addEventListener('keydown', key);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', key);
    };
  }, [sheet]);
  const room = rooms.find((r) => r.id === active),
    host = room?.host === user;
  const expired = (r: Room) =>
    r.stage === 'closed' ||
    today >= (r.date ? addDays(r.date.split('|')[0], 2) : addDays(r.end, 1));
  const update = (r: Room) =>
    setRooms((prev) => prev.map((x) => (x.id === r.id ? r : x)));
  const notify = (s: string) => setToast(s);
  function openRoom(r: Room) {
    setActive(r.id);
    setSelected(r.responses[user] || []);
    setRegionVotes(r.votes[user] || []);
    setChosen(r.start < today ? today : r.start);
    setMonth((r.start < today ? today : r.start).slice(0, 7));
    setView('room');
  }
  async function login() {
    const n = nick.trim();
    if (!n || !/^\d{4}$/.test(pin))
      return setError('닉네임과 숫자 4자리 PIN을 입력해 주세요.');
    if (n === '양파')
      return setError('양파는 체험용 닉네임이에요. 다른 이름을 골라 주세요.');
    const hash = await hashPin(pin, n),
      old = accounts.find((a) => a.name === n);
    if (old && old.hash !== hash) return setError('PIN이 일치하지 않아요.');
    if (!old) setAccounts([...accounts, { name: n, hash }]);
    setUser(n);
    setPin('');
    setView('home');
  }
  function create() {
    if (!name.trim()) return setError('모임 이름을 입력해 주세요.');
    const count = daysBetween(start, end).length;
    if (start < today || count < 7 || count > 31)
      return setError('오늘 이후 날짜로 7~31일을 선택해 주세요.');
    const r = newRoom(
      name.trim(),
      user,
      start,
      end,
      size,
      mode,
      crypto.randomUUID(),
    );
    setRooms([...rooms, r]);
    openRoom(r);
    setName('');
    notify('모임을 만들었어요. 친구들을 초대해 보세요.');
  }
  function join() {
    const r = rooms.find((x) => x.code === code.trim().toUpperCase());
    if (!r) return setError('이 브라우저에 있는 모임 코드를 확인해 주세요.');
    if (expired(r)) return setError('종료된 모임이에요.');
    if (r.members.includes(user)) return openRoom(r);
    if (r.members.length >= r.size) return setError('정원이 가득 찼어요.');
    if (r.stage !== 'schedule') return setError('일정 투표가 이미 끝났어요.');
    const nr = { ...r, members: [...r.members, user] };
    update(nr);
    openRoom(nr);
  }
  function submit() {
    if (!room) return;
    const r = { ...room, responses: { ...room.responses, [user]: selected } };
    if (Object.keys(r.responses).length === r.size) r.stage = 'date';
    update(r);
    setSheet('email');
    notify('가능한 일정을 제출했어요.');
  }
  function confirmDate(slot: string, manual = false) {
    if (!room || !host) return;
    const attendees = room.members.filter((m) =>
      room.responses[m]?.includes(slot),
    );
    update({
      ...room,
      date: slot,
      attendees: manual ? [] : attendees,
      stage: manual ? 'confirm' : 'region',
      confirmations: {},
      votes: {},
    });
    setRegionVotes([]);
    notify(
      manual
        ? '참석 여부를 다시 확인해 주세요.'
        : '날짜가 정해졌어요! 이제 지역을 골라 주세요.',
    );
  }
  function demoFill() {
    if (!room?.demo) return;
    let r = { ...room };
    if (r.stage === 'schedule') {
      r.responses = { ...r.responses };
      for (const m of r.members)
        if (m !== user)
          r.responses[m] = daysBetween(r.start, r.end).flatMap((d) => [
            d + '|점심',
            d + '|저녁',
          ]);
      if (Object.keys(r.responses).length === r.size) r.stage = 'date';
    } else if (r.stage === 'region') {
      r.votes = { ...r.votes };
      for (const m of r.attendees)
        if (m !== user) r.votes[m] = [(r.round > 1 ? r.tied! : r.regions)[0]];
      r = tallyRegion(r);
    } else if (r.stage === 'confirm') {
      r.confirmations = Object.fromEntries(r.members.map((m) => [m, true]));
      r.attendees = [...r.members];
      r.stage = 'region';
    }
    update(r);
    notify('체험용 친구들의 응답을 채웠어요.');
  }
  function removeMember(n: string) {
    if (!room) return;
    const responses = { ...room.responses },
      votes = { ...room.votes };
    delete responses[n];
    delete votes[n];
    update({
      ...room,
      members: room.members.filter((x) => x !== n),
      attendees: room.attendees.filter((x) => x !== n),
      responses,
      votes,
    });
    if (n === user) {
      setView('home');
      setSheet(null);
    }
    notify('멤버와 표를 정리했어요. 목표 인원은 유지돼요.');
  }
  async function share(text: string) {
    try {
      if (navigator.share)
        await navigator.share({ title: '언제 만날래', text });
      else {
        await navigator.clipboard.writeText(text);
        notify('클립보드에 복사했어요.');
      }
    } catch {
      notify('공유를 취소했거나 지원하지 않는 환경이에요.');
    }
  }
  const mine = rooms.filter((r) => r.members.includes(user) && !expired(r));
  const avatars = (names: string[]) => (
    <div className="avatar-stack">
      {names.map((n, i) => (
        <Avatar key={n} name={n} index={i} />
      ))}
    </div>
  );
  if (!ready)
    return (
      <div className="app-shell">
        <div className="loading">
          <CalendarDays />
          <p>모임을 준비하고 있어요</p>
        </div>
      </div>
    );
  return (
    <>
      <aside className="desktop-note">
        <div className="brand-icon">
          <CalendarDays size={26} />
        </div>
        <b>언제 만날래</b>
        <p>
          날짜부터 장소까지,
          <br />
          우리 약속을 한곳에서.
        </p>
        <span>모바일 웹 프로토타입</span>
        <small>
          이 브라우저에만 저장됩니다.
          <br />
          실제 초대·메일은 연결 전입니다.
        </small>
      </aside>
      <div className="app-shell">
        <header>
          <button
            className="icon-button"
            aria-label="내 모임으로"
            onClick={() => setView(user ? 'home' : 'login')}
          >
            {view === 'home' || view === 'login' ? (
              <span className="brand-mini">
                <CalendarDays size={20} />
              </span>
            ) : (
              <ArrowLeft size={23} />
            )}
          </button>
          <b>
            {view === 'room'
              ? room?.title
              : view === 'create'
                ? '새 모임'
                : view === 'join'
                  ? '모임 참가'
                  : '언제 만날래'}
          </b>
          <button
            className="icon-button"
            aria-label="설정"
            onClick={() =>
              user ? setSheet('settings') : notify('닉네임으로 시작해 보세요.')
            }
          >
            {view === 'room' ? (
              <MoreHorizontal />
            ) : (
              <span className="profile-dot">
                {user ? user[0] : <Users size={17} />}
              </span>
            )}
          </button>
        </header>
        {view === 'home' && (
          <>
            <main>
              <Heading
                eyebrow="함께라서 더 좋은 시간"
                title={`${user}님,\n우리 언제 만날까요?`}
                desc="흩어져 있던 약속을 한곳에 모았어요."
              />
              <div className="home-summary">
                <div>
                  <span className="tag blue">다가오는 모임</span>
                  <h2>
                    기다려지는 약속이
                    <br />
                    <strong>{mine.length}개</strong> 있어요
                  </h2>
                </div>
                <div className="calendar-art">
                  <div>LET’S MEET</div>
                  <b>{new Date().getDate()}</b>
                  <span className="art-check">
                    <Check size={19} />
                  </span>
                </div>
              </div>
              <div className="section-head">
                <h2>
                  내 모임 <span>{mine.length}</span>
                </h2>
                <button className="text-button" onClick={() => setView('join')}>
                  코드로 참가 <ChevronRight size={15} />
                </button>
              </div>
              {mine.map((r, i) => (
                <button
                  className="room-card"
                  key={r.id}
                  onClick={() => openRoom(r)}
                >
                  <div className="card-top">
                    <span className="room-emoji">
                      {i % 2 === 0 ? '🍀' : '☕'}
                    </span>
                    <span
                      className={
                        'tag ' + (r.stage === 'final' ? 'green' : 'blue')
                      }
                    >
                      {r.stage === 'schedule'
                        ? '일정 투표 중'
                        : r.stage === 'date' || r.stage === 'confirm'
                          ? '날짜 정하는 중'
                          : r.stage === 'final'
                            ? '약속 확정'
                            : '지역 투표 중'}
                    </span>
                    <ChevronRight className="chevron" size={20} />
                  </div>
                  <h3>{r.title}</h3>
                  <p>
                    <CalendarDays size={15} />
                    {r.date
                      ? labelDate(r.date.split('|')[0]) +
                        ' · ' +
                        r.date.split('|')[1]
                      : `${labelDate(r.start)} – ${labelDate(r.end)}`}
                  </p>
                  <div className="card-bottom">
                    {avatars(r.members.slice(0, 4))}
                    <span>
                      {r.stage === 'schedule'
                        ? `${Object.keys(r.responses).length} / ${r.size}명 제출`
                        : `${r.attendees.length}명과 함께`}
                    </span>
                  </div>
                </button>
              ))}
              {!mine.length && (
                <div className="empty">
                  <CalendarDays />
                  <h3>첫 약속을 만들어 볼까요?</h3>
                  <p>친구들을 초대하고 가능한 날짜를 모아보세요.</p>
                </div>
              )}
              <div className="tip">
                <span>💡</span>
                <p>
                  가능한 날짜만 고르면 끝!
                  <br />
                  <b>점심·저녁으로 가볍게 정해요.</b>
                </p>
              </div>
            </main>
            <CTA onClick={() => setView('create')}>
              <Plus size={20} /> 새 모임 만들기
            </CTA>
          </>
        )}
        {view === 'login' && (
          <>
            <main>
              <div className="login-symbol">👋</div>
              <Heading
                title="반가워요!\n어떻게 불러드릴까요?"
                desc="닉네임과 PIN 하나로 우리 모임을 관리해요."
              />
              <label className="field">
                닉네임
                <input
                  autoComplete="username"
                  maxLength={16}
                  value={nick}
                  onChange={(e) => setNick(e.target.value)}
                  placeholder="친구들이 알아볼 수 있는 이름"
                />
              </label>
              <label className="field">
                숫자 4자리 PIN
                <input
                  type="password"
                  autoComplete="current-password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="기억하기 쉬운 숫자 4자리"
                />
              </label>
              <p className="helper">
                처음 쓰는 닉네임이면 새 계정으로 시작해요.
                <br />
                PIN은 찾을 수 없으니 꼭 기억해 주세요.
              </p>
              {error && <p className="error">{error}</p>}
              <button
                className="text-button demo-login"
                onClick={() => {
                  setUser('양파');
                  if (!rooms.some((r) => r.demo))
                    setRooms([...rooms, seedRoom(today)]);
                  setView('home');
                }}
              >
                먼저 체험해 볼게요 <ArrowRight size={16} />
              </button>
            </main>
            <CTA onClick={login}>시작하기</CTA>
          </>
        )}
        {view === 'create' && (
          <>
            <main>
              <Heading
                eyebrow="새로운 약속"
                title="만나고 싶은 친구들을\n한자리에 초대해요"
              />
              <label className="field">
                모임 이름
                <input
                  value={name}
                  maxLength={30}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 오랜만에 우리 다섯 🍀"
                />
              </label>
              <div className="field">
                몇 명이 함께하나요?
                <div className="stepper">
                  <span>나를 포함해서</span>
                  <button
                    aria-label="인원 줄이기"
                    disabled={size === 2}
                    onClick={() => setSize(size - 1)}
                  >
                    −
                  </button>
                  <strong>{size}명</strong>
                  <button
                    aria-label="인원 늘리기"
                    disabled={size === 10}
                    onClick={() => setSize(size + 1)}
                  >
                    +
                  </button>
                </div>
                <small>만든 뒤에는 인원수를 바꿀 수 없어요.</small>
              </div>
              <div className="field">
                언제쯤 만날까요?
                <div className="date-inputs">
                  <input
                    aria-label="시작일"
                    type="date"
                    min={today}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                  <span>—</span>
                  <input
                    aria-label="종료일"
                    type="date"
                    min={start}
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </div>
                <small>시작일과 마지막 날을 포함해 7~31일</small>
              </div>
              <div className="field">
                날짜를 정하는 기준
                {(['all', 'most'] as const).map((m) => (
                  <button
                    key={m}
                    aria-label={
                      m === 'all'
                        ? '모두 가능한 날'
                        : '가장 많이 모일 수 있는 날'
                    }
                    aria-pressed={mode === m}
                    className={'radio-card ' + (mode === m ? 'selected' : '')}
                    onClick={() => setMode(m)}
                  >
                    <div>
                      <b>
                        {m === 'all'
                          ? '모두 가능한 날'
                          : '가장 많이 모일 수 있는 날'}
                      </b>
                      <p>
                        {m === 'all'
                          ? '한 명도 빠짐없이 함께해요'
                          : '더 많은 친구와 먼저 만나요'}
                      </p>
                    </div>
                    <span className="radio" />
                  </button>
                ))}
              </div>
              {error && <p className="error">{error}</p>}
            </main>
            <CTA onClick={create}>모임 만들기</CTA>
          </>
        )}
        {view === 'join' && (
          <>
            <main>
              <Heading
                title="친구가 보낸\n초대 코드를 입력해요"
                desc="다시 들어가면 이전 응답이 그대로 있어요."
              />
              <label className="field">
                초대 코드
                <input
                  value={code}
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="예: MEET05"
                />
              </label>
              <p className="helper">
                로컬 체험에서는 이 브라우저에 있는 모임에만 참가할 수 있어요.
              </p>
              {error && <p className="error">{error}</p>}
            </main>
            <CTA onClick={join}>모임 참가하기</CTA>
          </>
        )}
        {view === 'room' && room && (
          <>
            {expired(room) ? (
              <main>
                <div className="empty">
                  <CalendarDays />
                  <h1>종료된 약속이에요</h1>
                  <p>새로운 약속으로 다시 만나요.</p>
                  <button className="primary" onClick={() => setView('home')}>
                    내 모임으로
                  </button>
                </div>
              </main>
            ) : (
              <>
                <div className="steps">
                  {['날짜', '지역', '약속'].map((s, i) => {
                    const idx = ['schedule', 'date', 'confirm'].includes(
                      room.stage,
                    )
                      ? 0
                      : room.stage === 'final'
                        ? 2
                        : 1;
                    return (
                      <div key={s} className={idx >= i ? 'on' : ''}>
                        <span>{idx > i ? <Check size={12} /> : i + 1}</span>
                        {s}
                        {i < 2 && <i />}
                      </div>
                    );
                  })}
                </div>
                {room.stage === 'schedule' && (
                  <>
                    <main>
                      <Heading
                        title="우리, 언제 시간 돼요?"
                        desc="가능한 날짜의 점심·저녁을 골라 주세요."
                      />
                      <button
                        aria-label="참여 인원 보기"
                        className="participation"
                        onClick={() => setSheet('members')}
                      >
                        {avatars(room.members.slice(0, 4))}
                        <span>
                          <b>{Object.keys(room.responses).length}명 제출</b>
                          <small>
                            {room.members.length}명 입장 · 총 {room.size}명
                          </small>
                        </span>
                        <ChevronRight size={18} />
                      </button>
                      <div className="calendar">
                        <div className="calendar-title">
                          <h2>{month.replace('-', '년 ')}월</h2>
                          <div>
                            {[-1, 1].map((n) => (
                              <button
                                key={n}
                                aria-label={n < 0 ? '이전 달' : '다음 달'}
                                onClick={() => {
                                  const d = new Date(month + '-01T12:00:00');
                                  d.setMonth(d.getMonth() + n);
                                  setMonth(iso(d).slice(0, 7));
                                }}
                              >
                                {n < 0 ? (
                                  <ChevronLeft size={20} />
                                ) : (
                                  <ChevronRight size={20} />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="week">
                          {'일월화수목금토'.split('').map((d) => (
                            <span key={d}>{d}</span>
                          ))}
                        </div>
                        <div className="date-grid">
                          {Array.from(
                            {
                              length: new Date(month + '-01T12:00:00').getDay(),
                            },
                            (_, i) => (
                              <span key={'blank' + i} />
                            ),
                          )}
                          {Array.from(
                            {
                              length: new Date(
                                Number(month.slice(0, 4)),
                                Number(month.slice(5)),
                                0,
                              ).getDate(),
                            },
                            (_, i) => {
                              const date =
                                  month + '-' + String(i + 1).padStart(2, '0'),
                                slots = selected.filter((s) =>
                                  s.startsWith(date),
                                );
                              return (
                                <button
                                  key={date}
                                  disabled={
                                    date < room.start ||
                                    date > room.end ||
                                    date < today
                                  }
                                  className={
                                    (chosen === date ? 'focused ' : '') +
                                    (slots.length ? 'has-selection' : '')
                                  }
                                  onClick={() => setChosen(date)}
                                  aria-label={`${labelDate(date)} 선택`}
                                >
                                  <b>{i + 1}</b>
                                  <div className="dots">
                                    {['점심', '저녁'].map((s) => (
                                      <i
                                        key={s}
                                        className={
                                          slots.includes(date + '|' + s)
                                            ? 'filled'
                                            : ''
                                        }
                                      />
                                    ))}
                                  </div>
                                  {date === today && <small>오늘</small>}
                                </button>
                              );
                            },
                          )}
                        </div>
                      </div>
                      <div className="slot-panel">
                        <div className="section-head">
                          <h3>{labelDate(chosen)}</h3>
                          <span>복수 선택 가능</span>
                        </div>
                        <div className="slot-buttons">
                          {['점심', '저녁'].map((s, i) => {
                            const key = chosen + '|' + s,
                              yes = selected.includes(key);
                            return (
                              <button
                                key={s}
                                aria-pressed={yes}
                                className={yes ? 'active' : ''}
                                onClick={() =>
                                  setSelected(
                                    yes
                                      ? selected.filter((x) => x !== key)
                                      : [...selected, key],
                                  )
                                }
                              >
                                {i === 0 ? (
                                  <Sun size={23} />
                                ) : (
                                  <Moon size={23} />
                                )}
                                <b>{s}</b>
                                <span className="slot-check">
                                  {yes && <Check size={13} />}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <button
                          className="text-button"
                          onClick={() => setSheet('attendees')}
                        >
                          이 시간에 가능한 친구 보기 <ChevronRight size={15} />
                        </button>
                      </div>
                      <div className="selection-summary">
                        <CheckCheck size={20} />
                        <p>
                          {selected.length ? (
                            <>
                              <b>
                                {
                                  new Set(selected.map((s) => s.split('|')[0]))
                                    .size
                                }
                                일
                              </b>
                              의 일정을 골랐어요
                            </>
                          ) : (
                            '선택하지 않은 시간은 불가능으로 제출돼요'
                          )}
                        </p>
                        {!!selected.length && (
                          <button onClick={() => setSelected([])}>
                            초기화
                          </button>
                        )}
                      </div>
                      {room.responses[user] && (
                        <p className="helper">
                          이미 제출했어요. 마감 전까지 바꿀 수 있어요.
                        </p>
                      )}
                    </main>
                    <CTA onClick={submit}>
                      {selected.length
                        ? '이 일정으로 제출하기'
                        : '가능한 일정 없음으로 제출'}
                    </CTA>
                  </>
                )}
                {room.stage === 'date' && (
                  <main>
                    <div className="result-icon">
                      <CalendarDays size={36} />
                      <span>✨</span>
                    </div>
                    <Heading
                      title={
                        aggregate(room).length
                          ? '함께할 수 있는 날을\n찾았어요!'
                          : '아직 모두 가능한\n날짜가 없어요'
                      }
                      desc={
                        host
                          ? '친구들과 이야기하고 날짜를 확정해 주세요.'
                          : '방장이 최종 날짜를 선택하고 있어요.'
                      }
                    />
                    <div className="candidate-list">
                      {Array.from(
                        new Set(
                          aggregate(room).map((c) => c.slot.split('|')[0]),
                        ),
                      )
                        .slice(0, 7)
                        .map((d, i) => {
                          const candidates = aggregate(room).filter((c) =>
                            c.slot.startsWith(d),
                          );
                          return (
                            <div className="date-candidate" key={d}>
                              <div className="date-square">
                                <span>{Number(d.slice(5, 7))}월</span>
                                <b>{Number(d.slice(8))}</b>
                              </div>
                              <div>
                                <b>{labelDate(d)}</b>
                                <p>
                                  {Math.max(...candidates.map((c) => c.count))}
                                  명 가능 {i === 0 ? '· 가장 이른 날' : ''}
                                </p>
                                <div className="candidate-slots">
                                  {candidates.map((c) => (
                                    <button
                                      disabled={!host}
                                      key={c.slot}
                                      onClick={() => confirmDate(c.slot)}
                                    >
                                      {c.slot.split('|')[1]} 확정{' '}
                                      <ChevronRight size={12} />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                    {host && (
                      <div className="manual-date">
                        <h3>다른 날짜로 정하고 싶나요?</h3>
                        <p>기간 안의 날짜를 고르면 참석 여부를 다시 받아요.</p>
                        <input
                          aria-label="다른 날짜"
                          type="date"
                          min={room.start}
                          max={room.end}
                          value={customDate}
                          onChange={(e) => setCustomDate(e.target.value)}
                        />
                        <div className="two-buttons">
                          {['점심', '저녁'].map((s) => (
                            <button
                              className="secondary"
                              disabled={
                                !customDate ||
                                customDate < room.start ||
                                customDate > room.end
                              }
                              key={s}
                              onClick={() =>
                                confirmDate(customDate + '|' + s, true)
                              }
                            >
                              {s}으로 다시 확인
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </main>
                )}
                {room.stage === 'confirm' && (
                  <main>
                    <Heading
                      title="이날, 함께할 수 있나요?"
                      desc="전체 일정을 다시 고를 필요 없어요."
                    />
                    <div className="confirmed-banner">
                      <CalendarDays />
                      <b>
                        {labelDate(room.date!.split('|')[0])}{' '}
                        {room.date!.split('|')[1]}
                      </b>
                    </div>
                    <div className="two-buttons">
                      {[true, false].map((v) => (
                        <button
                          key={String(v)}
                          className={v ? 'primary' : 'secondary'}
                          onClick={() => {
                            const confirmations = {
                              ...room.confirmations,
                              [user]: v,
                            };
                            const r = { ...room, confirmations };
                            if (r.members.every((m) => m in confirmations)) {
                              r.attendees = r.members.filter(
                                (m) => confirmations[m],
                              );
                              if (r.attendees.length >= 2) r.stage = 'region';
                            }
                            update(r);
                            notify('참석 여부를 제출했어요.');
                          }}
                        >
                          {v ? '갈 수 있어요' : '이번엔 어려워요'}
                        </button>
                      ))}
                    </div>
                    <p className="helper">
                      {Object.keys(room.confirmations || {}).length} /{' '}
                      {room.members.length}명 확인
                    </p>
                  </main>
                )}
                {room.stage === 'region' && (
                  <>
                    <main>
                      <div className="confirmed-banner">
                        <Check size={18} />
                        <b>
                          {labelDate(room.date!.split('|')[0])}{' '}
                          {room.date!.split('|')[1]}
                        </b>
                      </div>
                      <Heading
                        title="어디에서 만날까요?"
                        desc={
                          room.round > 1
                            ? '동률인 지역 중 한 곳을 골라 주세요.'
                            : '마음 가는 지역을 최대 2곳 골라 주세요.'
                        }
                      />
                      <div className="section-head">
                        <span>선호 지역</span>
                        <b className="blue-text">
                          {regionVotes.length} / {room.round > 1 ? 1 : 2}개
                        </b>
                      </div>
                      <div className="regions">
                        {(room.round > 1 ? room.tied || [] : room.regions).map(
                          (r) => (
                            <button
                              key={r}
                              aria-pressed={regionVotes.includes(r)}
                              className={
                                regionVotes.includes(r) ? 'selected' : ''
                              }
                              onClick={() =>
                                setRegionVotes(
                                  regionVotes.includes(r)
                                    ? regionVotes.filter((x) => x !== r)
                                    : regionVotes.length <
                                        (room.round > 1 ? 1 : 2)
                                      ? [...regionVotes, r]
                                      : regionVotes,
                                )
                              }
                            >
                              <MapPin size={19} />
                              <b>{r}</b>
                              {regionVotes.includes(r) && <Check size={15} />}
                            </button>
                          ),
                        )}
                      </div>
                      {Object.keys(room.votes).length === 0 &&
                        room.round === 1 && (
                          <button
                            className="add-region"
                            onClick={() => setSheet('addRegion')}
                          >
                            <Plus size={17} /> 다른 지역 추가하기
                          </button>
                        )}
                      <p className="helper">
                        {Object.keys(room.votes).length} /{' '}
                        {room.attendees.length}명 제출 · 첫 투표 후에는 지역을
                        추가할 수 없어요.
                      </p>
                    </main>
                    {room.attendees.includes(user) ? (
                      <CTA
                        disabled={!regionVotes.length}
                        onClick={() => {
                          update(
                            tallyRegion({
                              ...room,
                              votes: { ...room.votes, [user]: regionVotes },
                            }),
                          );
                          notify('지역 투표를 제출했어요.');
                        }}
                      >
                        {room.votes[user]
                          ? '선택 수정하기'
                          : '이 지역으로 투표하기'}
                      </CTA>
                    ) : (
                      <div className="bottom-action">
                        <p className="helper">이번 일정은 관전 중이에요.</p>
                      </div>
                    )}
                  </>
                )}
                {room.stage === 'tie' && (
                  <main>
                    <div className="result-icon">🤔</div>
                    <Heading
                      title="친구들의 마음이\n반반으로 나뉘었어요"
                      desc="한 번 더 골라 볼까요, 운에 맡겨 볼까요?"
                    />
                    <div className="tie-options">
                      {room.tied?.map((r) => (
                        <div key={r}>
                          <MapPin />
                          <b>{r}</b>
                        </div>
                      ))}
                    </div>
                    {host ? (
                      <>
                        <button
                          className="primary"
                          onClick={() => {
                            update({
                              ...room,
                              stage: 'region',
                              votes: {},
                              round: room.round + 1,
                            });
                            setRegionVotes([]);
                          }}
                        >
                          한 번 더 투표하기
                        </button>
                        <button
                          className="secondary full"
                          onClick={() => {
                            update({
                              ...room,
                              region:
                                room.tied![
                                  Math.floor(Math.random() * room.tied!.length)
                                ],
                              stage: 'final',
                            });
                            notify('만날 지역이 정해졌어요!');
                          }}
                        >
                          <Sparkles size={18} /> 무작위로 정하기
                        </button>
                      </>
                    ) : (
                      <p className="helper">
                        방장이 다음 방법을 선택하고 있어요.
                      </p>
                    )}
                  </main>
                )}
                {room.stage === 'final' && (
                  <main>
                    <div className="celebrate">
                      <PartyPopper size={38} />
                      <span>우리 약속, 준비 완료</span>
                    </div>
                    <Heading title="그날, 여기서 만나요!" />
                    <div className="ticket">
                      <div className="ticket-top">
                        <span>OUR NEXT MEETUP</span>
                        <Heart size={18} />
                      </div>
                      <h2>{room.title}</h2>
                      <div>
                        <CalendarDays />
                        <p>
                          <small>언제</small>
                          <b>
                            {labelDate(room.date!.split('|')[0])} ·{' '}
                            {room.date!.split('|')[1]}
                          </b>
                        </p>
                      </div>
                      <div>
                        <MapPin />
                        <p>
                          <small>어디서</small>
                          <b>{room.region}</b>
                        </p>
                      </div>
                      <div className="ticket-people">
                        {avatars(room.attendees)}
                        <span>{room.attendees.length}명이 함께해요</span>
                      </div>
                    </div>
                    <button
                      className="secondary full"
                      onClick={() =>
                        share(
                          `${room.title}\n${labelDate(room.date!.split('|')[0])} ${room.date!.split('|')[1]} · ${room.region}\n초대 코드 ${room.code}`,
                        )
                      }
                    >
                      <Copy size={17} /> 약속 공유하기
                    </button>
                    <div className="section-head links-title">
                      <h2>여기 어때요?</h2>
                      <span>가고 싶은 곳을 모아봐요</span>
                    </div>
                    <div className="tabs">
                      {(['food', 'cafe'] as const).map((c) => (
                        <button
                          key={c}
                          className={category === c ? 'active' : ''}
                          onClick={() => setCategory(c)}
                        >
                          {c === 'food' ? (
                            <Utensils size={17} />
                          ) : (
                            <Coffee size={17} />
                          )}{' '}
                          {c === 'food' ? '음식점' : '카페'}{' '}
                          <span>
                            {room.links.filter((l) => l.category === c).length}
                          </span>
                        </button>
                      ))}
                    </div>
                    {room.links
                      .filter((l) => l.category === category)
                      .map((l) => (
                        <div className="place-card" key={l.id}>
                          <span className="place-icon">
                            {category === 'food' ? '🍽️' : '☕'}
                          </span>
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <b>{l.name || new URL(l.url).hostname}</b>
                            <p>
                              {new URL(l.url).hostname}{' '}
                              <ChevronRight size={13} />
                            </p>
                          </a>
                          {(host || l.author === user) && (
                            <button
                              className="icon-button"
                              aria-label="링크 삭제"
                              onClick={() =>
                                update({
                                  ...room,
                                  links: room.links.filter(
                                    (x) => x.id !== l.id,
                                  ),
                                })
                              }
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                      ))}
                    {!room.links.some((l) => l.category === category) && (
                      <div className="empty-links">
                        <Link2 size={26} />
                        <b>첫 번째 장소를 추천해 주세요</b>
                        <p>지도나 소개 페이지 링크면 충분해요.</p>
                      </div>
                    )}
                    <button
                      className="add-region"
                      onClick={() => setSheet('link')}
                    >
                      <Plus size={18} />{' '}
                      {category === 'food' ? '음식점' : '카페'} 링크 추가
                    </button>
                    <p className="expiration">
                      이 모임은{' '}
                      {labelDate(addDays(room.date!.split('|')[0], 2))} 00:00에
                      사라져요.
                    </p>
                  </main>
                )}
                {room.demo &&
                  ['schedule', 'region', 'confirm'].includes(room.stage) && (
                    <div className="demo-control">
                      <span>체험용 모임</span>
                      <button onClick={demoFill}>
                        친구들 응답 채우기 <Sparkles size={13} />
                      </button>
                    </div>
                  )}
              </>
            )}
          </>
        )}
        {toast && (
          <output className="toast">
            <Check size={17} />
            {toast}
          </output>
        )}
        {sheet && (
          <dialog
            ref={dialogRef}
            className="sheet"
            aria-labelledby="sheet-title"
            onCancel={() => setSheet(null)}
          >
            <div className="sheet-handle" />
            <button
              className="sheet-close icon-button"
              aria-label="닫기"
              onClick={() => setSheet(null)}
            >
              <X />
            </button>
            {sheet === 'email' && (
              <>
                <div className="sheet-symbol">
                  <Mail />
                </div>
                <h2 id="sheet-title">결과가 나오면 알려드릴까요?</h2>
                <p>날짜와 지역이 정해질 때 한 번씩 알려드려요.</p>
                <label className="field">
                  이메일
                  <input
                    type="email"
                    autoFocus
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="hello@example.com"
                  />
                </label>
                <p className="helper">
                  체험에서는 신청 상태만 저장해요. 실제 메일은 발송하지 않아요.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input))
                      return setError('이메일 주소를 확인해 주세요.');
                    if (room)
                      update({
                        ...room,
                        emails: { ...room.emails, [user]: input },
                      });
                    setSheet(null);
                    notify('이메일 신청 상태를 저장했어요.');
                  }}
                >
                  알림 받기
                </button>
                <button
                  className="text-button center"
                  onClick={() => setSheet(null)}
                >
                  다음에 할게요
                </button>
              </>
            )}
            {sheet === 'members' && room && (
              <>
                <h2 id="sheet-title">함께하는 친구들</h2>
                <p>
                  {room.members.length}명 입장 · 총 {room.size}명
                </p>
                {room.members.map((m, i) => (
                  <div className="member-row" key={m}>
                    <Avatar name={m} index={i} />
                    <b>{m}</b>
                    {room.host === m && <span className="tag blue">방장</span>}
                  </div>
                ))}
                <button className="primary" onClick={() => setSheet('invite')}>
                  <Link2 size={18} /> 친구 초대하기
                </button>
              </>
            )}
            {sheet === 'attendees' && room && (
              <>
                <h2 id="sheet-title">{labelDate(chosen)} 가능한 친구</h2>
                {['점심', '저녁'].map((s) => (
                  <div className="attendee-row" key={s}>
                    <b>{s}</b>
                    <p>
                      {room.members
                        .filter((m) =>
                          room.responses[m]?.includes(chosen + '|' + s),
                        )
                        .join(', ') || '아직 제출한 친구가 없어요'}
                    </p>
                  </div>
                ))}
              </>
            )}
            {sheet === 'invite' && room && (
              <>
                <div className="sheet-symbol">
                  <Users />
                </div>
                <h2 id="sheet-title">친구들과 함께 정해요</h2>
                <p>아래 코드를 친구들에게 알려주세요.</p>
                <div className="invite-code">{room.code}</div>
                <p className="helper">
                  다른 기기에서 참가하는 기능은 서버 연결 후 사용할 수 있어요.
                </p>
                <button
                  className="primary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(room.code);
                      notify('초대 코드를 복사했어요.');
                    } catch {
                      notify('코드를 직접 선택해 복사해 주세요.');
                    }
                  }}
                >
                  <Copy size={18} /> 코드 복사하기
                </button>
              </>
            )}
            {sheet === 'addRegion' && room && (
              <>
                <h2 id="sheet-title">어디에서 만나고 싶나요?</h2>
                <label className="field">
                  지역 이름
                  <input
                    autoFocus
                    maxLength={25}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="예: 여의도, 문래"
                  />
                </label>
                <button
                  className="primary"
                  onClick={() => {
                    if (!input.trim()) return setError('지역을 입력해 주세요.');
                    if (room.regions.includes(input.trim()))
                      return setError('이미 있는 지역이에요.');
                    if (Object.keys(room.votes).length)
                      return setError('투표가 시작되어 추가할 수 없어요.');
                    update({
                      ...room,
                      regions: [...room.regions, input.trim()],
                    });
                    setSheet(null);
                  }}
                >
                  후보 추가하기
                </button>
              </>
            )}
            {sheet === 'link' && room && (
              <>
                <h2 id="sheet-title">좋은 곳을 발견했나요?</h2>
                <p>친구들에게 가고 싶은 곳을 알려주세요.</p>
                <label className="field">
                  링크
                  <input
                    autoFocus
                    type="url"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="https://map.naver.com/..."
                  />
                </label>
                <label className="field">
                  이름 <small>선택</small>
                  <input
                    value={linkName}
                    onChange={(e) => setLinkName(e.target.value)}
                    placeholder="장소 이름을 적어 주세요"
                  />
                </label>
                <p className="helper">매장명 자동 가져오기는 연결 전이에요.</p>
                <button
                  className="primary"
                  onClick={() => {
                    let url;
                    try {
                      url = new URL(input);
                      if (!['http:', 'https:'].includes(url.protocol))
                        throw Error();
                    } catch {
                      return setError(
                        '올바른 http 또는 https 링크를 입력해 주세요.',
                      );
                    }
                    if (
                      room.links.some(
                        (l) => l.url === url.href && l.category === category,
                      )
                    )
                      return setError('이미 추가한 링크예요.');
                    update({
                      ...room,
                      links: [
                        ...room.links,
                        {
                          id: crypto.randomUUID(),
                          url: url.href,
                          name: linkName.trim(),
                          category,
                          author: user,
                        },
                      ],
                    });
                    setSheet(null);
                    setLinkName('');
                    notify('링크를 추가했어요.');
                  }}
                >
                  링크 추가하기
                </button>
              </>
            )}
            {sheet === 'settings' && (
              <>
                <h2 id="sheet-title">
                  {view === 'room' ? '모임 관리' : '내 계정'}
                </h2>
                {view === 'room' && room ? (
                  <>
                    <button
                      className="menu-row"
                      onClick={() => setSheet('invite')}
                    >
                      <Link2 />
                      친구 초대
                      <ChevronRight />
                    </button>
                    <button
                      className="menu-row"
                      onClick={() => setSheet('email')}
                    >
                      <Mail />
                      이메일 알림 신청
                      <ChevronRight />
                    </button>
                    {host && (
                      <>
                        <h3 className="small-heading">친구 관리</h3>
                        {room.members
                          .filter((m) => m !== user)
                          .map((m, i) => (
                            <div className="member-row" key={m}>
                              <Avatar name={m} index={i + 1} />
                              <b>{m}</b>
                              <button
                                className="text-button"
                                onClick={() => {
                                  update({ ...room, host: m });
                                  setSheet(null);
                                  notify(`${m}님에게 방장을 넘겼어요.`);
                                }}
                              >
                                방장 넘기기
                              </button>
                              <button
                                className="text-button danger"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `${m}님을 내보내고 표를 삭제할까요?`,
                                    )
                                  )
                                    removeMember(m);
                                }}
                              >
                                내보내기
                              </button>
                            </div>
                          ))}
                        <button
                          className="menu-row danger"
                          onClick={() => {
                            if (window.confirm('모임을 종료할까요?')) {
                              update({ ...room, stage: 'closed' });
                              setSheet(null);
                              setView('home');
                            }
                          }}
                        >
                          <X />
                          모임 조기 종료
                        </button>
                      </>
                    )}
                    {!host && (
                      <button
                        className="menu-row danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              '모임에서 나갈까요? 제출한 표는 삭제돼요.',
                            )
                          )
                            removeMember(user);
                        }}
                      >
                        <LogOut />
                        모임 나가기
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p>{user}님으로 이용 중이에요.</p>
                    <button
                      className="menu-row"
                      onClick={() => {
                        setUser('');
                        setView('login');
                        setSheet(null);
                      }}
                    >
                      <LogOut />
                      다른 닉네임으로 들어가기
                    </button>
                    <button
                      className="menu-row"
                      onClick={() => {
                        setRooms((prev) => [
                          seedRoom(today),
                          ...prev.filter((x) => !x.demo),
                        ]);
                        setUser('양파');
                        setSheet(null);
                        setView('home');
                        notify('샘플 모임을 처음으로 되돌렸어요.');
                      }}
                    >
                      <Sparkles />
                      샘플 모임 다시 체험하기
                    </button>
                  </>
                )}
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </dialog>
        )}
      </div>
    </>
  );
}
