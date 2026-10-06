'use client';
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Users,
  Check,
  MoreHorizontal,
} from 'lucide-react';
import { addDays, type Room } from '../lib/meeting';
import {
  dateCandidateView,
  reconcileRegionVoteDraft,
  regionVoteContext,
  validRegionVote,
  type RegionVoteDraft,
} from '../lib/meeting-view';
import { useKoreanToday } from '../hooks/use-korean-today';
import { useMeetingSync } from '../hooks/use-meeting-sync';
import type { MeetingSnapshot } from '../lib/meeting-contract';
import type { View, Sheet } from '../components/meeting/types';
import { HomeView } from '../components/meeting/home-view';
import { LoginView } from '../components/meeting/login-view';
import { CreateView } from '../components/meeting/create-view';
import { JoinView } from '../components/meeting/join-view';
import { RoomView } from '../components/meeting/room-view';
import { ScheduleView } from '../components/meeting/schedule-view';
import { DateView } from '../components/meeting/date-view';
import { ConfirmView } from '../components/meeting/confirm-view';
import { RegionView } from '../components/meeting/region-view';
import { TieView } from '../components/meeting/tie-view';
import { FinalView } from '../components/meeting/final-view';
import { MeetingSheets } from '../components/meeting/meeting-sheets';

export default function Home() {
  const today = useKoreanToday();
  const [view, changeView] = useState<View>('home'),
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
    [regionDraft, setRegionDraft] = useState<RegionVoteDraft>({
      context: '',
      choices: [],
    }),
    [customDate, setCustomDate] = useState('');
  const [expandedDateContext, setExpandedDateContext] = useState('');
  const [previousRoomContext, setPreviousRoomContext] = useState('');
  const [category, setCategory] = useState<'food' | 'cafe'>('food'),
    [linkName, setLinkName] = useState('');
  const [editingSchedule, setEditingSchedule] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const sheetWasOpen = useRef(false);
  const sheetOrigin = useRef<{
    trigger: HTMLButtonElement | undefined;
    context: string;
  } | null>(null);
  const onInitialLoad = useCallback(
    (snapshot: MeetingSnapshot, invite: string | null) => {
      if (invite) setCode(invite.toUpperCase());
      changeView(snapshot.user ? (invite ? 'join' : 'home') : 'login');
    },
    [],
  );
  const onRefresh = useCallback(
    (snapshot: MeetingSnapshot) => {
      if (view === 'room' && !snapshot.rooms.some((r) => r.id === active)) {
        changeView('home');
        changeSheet(null);
        setToast('종료되었거나 더 이상 참여 중인 모임이 아니에요.');
      }
      if (!snapshot.user) {
        changeView('login');
        changeSheet(null);
      }
    },
    [view, active],
  );
  const onInitialError = useCallback((message: string) => {
    setError(message);
    changeView('login');
  }, []);
  const onPollError = useCallback((message: string) => setToast(message), []);
  const onSaveStart = useCallback(() => setError(''), []);
  const onSaveError = useCallback((message: string) => {
    setError(message);
    setToast(message);
  }, []);
  const { ready, user, rooms, busy, send, replaceSession, clearSession } =
    useMeetingSync({
      onInitialLoad,
      onRefresh,
      onInitialError,
      onPollError,
      onSaveStart,
      onSaveError,
    });
  const sheetContext = JSON.stringify([
    user,
    view,
    view === 'room' ? active : null,
  ]);
  function setView(v: View) {
    setError('');
    changeView(v);
  }
  function setSheet(v: Sheet, trigger?: HTMLButtonElement) {
    if (v && !sheet) sheetOrigin.current = { trigger, context: sheetContext };
    setInput('');
    setError('');
    changeSheet(v);
  }
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 2800);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  const sheetOpen = sheet !== null;
  useLayoutEffect(() => {
    if (!sheetOpen) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, [sheetOpen]);
  useLayoutEffect(() => {
    if (sheet) {
      sheetWasOpen.current = true;
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.open) {
        dialog.showModal();
        // React's mount-time autoFocus runs while the dialog is still hidden.
        sheetInputRef.current?.focus({ preventScroll: true });
      }
      // An internal sheet switch can remove the focused control.
      if (!dialog.contains(document.activeElement))
        dialog
          .querySelector<HTMLButtonElement>('.sheet-close')
          ?.focus({ preventScroll: true });
      return;
    }
    // Restore only after an actual close commit, never in effect cleanup.
    if (!sheetWasOpen.current) return;
    sheetWasOpen.current = false;
    const origin = sheetOrigin.current;
    sheetOrigin.current = null;
    const trigger = origin?.trigger;
    if (
      origin?.context === sheetContext &&
      trigger?.isConnected &&
      !trigger.matches(':disabled, [aria-disabled="true"]') &&
      trigger.getClientRects().length > 0 &&
      getComputedStyle(trigger).visibility === 'visible'
    ) {
      trigger.focus({ preventScroll: true });
      if (document.activeElement === trigger) return;
    }
    const heading = appRef.current?.querySelector<HTMLElement>('main h1');
    heading?.focus({ preventScroll: true });
    if (!heading || document.activeElement !== heading)
      appRef.current?.focus({ preventScroll: true });
  }, [sheet, sheetContext]);
  const room = rooms.find((r) => r.id === active),
    host = room?.host === user;
  const showScheduleResults =
    !!room && user in room.responses && !editingSchedule;
  const nextRegionDraft = room
    ? reconcileRegionVoteDraft(regionDraft, room, user)
    : regionDraft;
  const regionVotes = room ? nextRegionDraft.choices : [];
  const roomContext = JSON.stringify([room?.id, room?.regionRevision ?? 0]);
  const dateContext = JSON.stringify([roomContext, today]);
  const dateCandidates = room
    ? dateCandidateView(room, today, expandedDateContext === dateContext)
    : null;
  if (nextRegionDraft !== regionDraft) setRegionDraft(nextRegionDraft);
  if (roomContext !== previousRoomContext) {
    setPreviousRoomContext(roomContext);
    changeSheet(null);
    setCustomDate('');
    setExpandedDateContext('');
  }
  function setRegionVotes(choices: string[]) {
    if (room)
      setRegionDraft({ context: regionVoteContext(room, user), choices });
  }
  const expired = (r: Room) =>
    r.stage === 'closed' ||
    today >= (r.date ? addDays(r.date.split('|')[0], 2) : addDays(r.end, 1));
  const notify = (s: string) => setToast(s);
  function openRoom(r: Room) {
    setEditingSchedule(false);
    setActive(r.id);
    setSelected(r.responses[user] || []);
    setRegionDraft(
      reconcileRegionVoteDraft({ context: '', choices: [] }, r, user),
    );
    setExpandedDateContext('');
    setChosen(r.start < today ? today : r.start);
    setMonth((r.start < today ? today : r.start).slice(0, 7));
    setView('room');
  }
  async function login() {
    const data = await send({ type: 'login', name: nick.trim(), pin });
    if (!data) return;
    replaceSession(data);
    setPin('');
    setView(code ? 'join' : 'home');
  }
  async function create() {
    const data = await send({
      type: 'create',
      title: name.trim(),
      start,
      end,
      size,
      mode,
    });
    if (data) {
      openRoom(data.room);
      setName('');
      notify('모임을 만들었어요. 친구들을 초대해 보세요.');
    }
  }
  async function join() {
    const data = await send({ type: 'join', code: code.trim().toUpperCase() });
    if (data) {
      openRoom(data.room);
      window.history.replaceState(null, '', '/');
    }
  }
  async function submit() {
    if (!room) return;
    if (await send({ type: 'schedule', roomId: room.id, slots: selected })) {
      setEditingSchedule(false);
      notify('가능한 일정을 제출했어요.');
    }
  }
  async function confirmDate(slot: string, manual = false) {
    if (!room || !host) return;
    if (!(await send({ type: 'date', roomId: room.id, slot, manual }))) return;
    setRegionVotes([]);
    notify(
      manual
        ? '참석 여부를 다시 확인해 주세요.'
        : '날짜가 정해졌어요! 이제 지역을 골라 주세요.',
    );
  }
  async function reopenDate() {
    if (!room || !host) return;
    if (
      !window.confirm(
        '날짜를 다시 선택할까요? 기존 가능 일정과 지역 후보는 유지되고, 참석 확인과 지역 투표는 초기화돼요.',
      )
    )
      return;
    if (await send({ type: 'reopenDate', roomId: room.id }))
      notify('날짜를 다시 선택해 주세요.');
  }
  async function removeMember(n: string) {
    if (!room) return;
    if (
      !window.confirm(
        n === user
          ? '모임에서 나갈까요? 제출한 표는 삭제돼요.'
          : `${n}님을 내보내고 표를 삭제할까요?`,
      )
    )
      return;
    if (!(await send({ type: 'remove', roomId: room.id, member: n }))) return;
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
  async function confirmAttendance(value: boolean) {
    if (!room) return;
    if (
      await send({
        type: 'confirm',
        roomId: room.id,
        value,
        regionRevision: room.regionRevision ?? 0,
      })
    )
      notify('참석 여부를 제출했어요.');
  }
  async function vote() {
    if (!room || !validRegionVote(room, user, regionVotes)) return;
    if (
      await send({
        type: 'vote',
        roomId: room.id,
        choices: regionVotes,
        round: room.round,
        regionRevision: room.regionRevision ?? 0,
      })
    )
      notify('지역 투표를 제출했어요.');
  }
  async function runoff() {
    if (room) await send({ type: 'runoff', roomId: room.id });
  }
  async function random() {
    if (room && (await send({ type: 'random', roomId: room.id })))
      notify('만날 지역이 정해졌어요!');
  }
  async function deleteLink(id: string) {
    if (room) await send({ type: 'deleteLink', roomId: room.id, id });
  }
  async function copyInvite() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(
        window.location.origin + '/?join=' + room.code,
      );
      notify('초대 링크를 복사했어요.');
    } catch {
      notify('코드를 직접 선택해 복사해 주세요.');
    }
  }
  async function addRegion() {
    if (!room) return;
    if (!input.trim()) return setError('지역을 입력해 주세요.');
    if (room.regions.includes(input.trim()))
      return setError('이미 있는 지역이에요.');
    if (room.stage !== 'region' || room.round !== 1)
      return setError('1차 지역 투표가 마감되어 추가할 수 없어요.');
    if (await send({ type: 'region', roomId: room.id, name: input.trim() }))
      setSheet(null);
  }
  async function addLink() {
    if (!room) return;
    let url;
    try {
      url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol)) throw Error();
    } catch {
      return setError('올바른 http 또는 https 링크를 입력해 주세요.');
    }
    if (room.links.some((l) => l.url === url.href && l.category === category))
      return setError('이미 추가한 링크예요.');
    if (
      !(await send({
        type: 'addLink',
        roomId: room.id,
        url: url.href,
        name: linkName.trim(),
        category,
      }))
    )
      return;
    setSheet(null);
    setLinkName('');
    notify('링크를 추가했어요.');
  }
  async function transfer(member: string) {
    if (!room || !(await send({ type: 'transfer', roomId: room.id, member })))
      return;
    setSheet(null);
    notify(`${member}님에게 방장을 넘겼어요.`);
  }
  async function closeRoom() {
    if (!room || !window.confirm('모임을 종료할까요?')) return;
    if (!(await send({ type: 'close', roomId: room.id }))) return;
    setSheet(null);
    setView('home');
  }
  async function logout() {
    if (!(await send({ type: 'logout' }))) return;
    clearSession();
    setView('login');
    setSheet(null);
  }
  const mine = rooms.filter((r) => r.members.includes(user) && !expired(r));
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
        <span>함께 정하는 우리 약속</span>
        <small>
          친구들과 같은 모임을 공유해요.
          <br />
          초대 링크로 함께 참여하세요.
        </small>
      </aside>
      <div
        ref={appRef}
        tabIndex={-1}
        className={'app-shell' + (busy ? ' is-saving' : '')}
        aria-busy={busy}
      >
        {busy && <output className="sync-status">저장하고 있어요…</output>}
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
            onClick={(event) =>
              user
                ? setSheet('settings', event.currentTarget)
                : notify('닉네임으로 시작해 보세요.')
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
          <HomeView
            user={user}
            today={today}
            rooms={mine}
            onOpenRoom={openRoom}
            onJoin={() => setView('join')}
            onCreate={() => setView('create')}
          />
        )}
        {view === 'login' && (
          <LoginView
            nick={nick}
            pin={pin}
            error={error}
            onNickChange={setNick}
            onPinChange={setPin}
            onSubmit={login}
          />
        )}
        {view === 'create' && (
          <CreateView
            name={name}
            start={start}
            end={end}
            size={size}
            mode={mode}
            today={today}
            error={error}
            onNameChange={setName}
            onStartChange={setStart}
            onEndChange={setEnd}
            onSizeChange={setSize}
            onModeChange={setMode}
            onSubmit={create}
          />
        )}
        {view === 'join' && (
          <JoinView
            code={code}
            error={error}
            onCodeChange={setCode}
            onSubmit={join}
          />
        )}
        {view === 'room' && room && (
          <RoomView
            room={room}
            user={user}
            host={host}
            busy={busy}
            expired={expired(room)}
            onHome={() => setView('home')}
            onReopenDate={reopenDate}
          >
            {room.stage === 'schedule' && (
              <ScheduleView
                room={room}
                user={user}
                today={today}
                month={month}
                chosen={chosen}
                selected={selected}
                showScheduleResults={showScheduleResults}
                onMonthChange={setMonth}
                onChosenChange={setChosen}
                onSelectedChange={setSelected}
                onEditSchedule={() => {
                  setSelected(room.responses[user] || []);
                  setEditingSchedule(true);
                }}
                onSubmit={submit}
                onOpenSheet={setSheet}
              />
            )}
            {room.stage === 'date' && dateCandidates && (
              <DateView
                room={room}
                host={host}
                today={today}
                dateCandidates={dateCandidates}
                customDate={customDate}
                onCustomDateChange={setCustomDate}
                onShowMore={() => setExpandedDateContext(dateContext)}
                onConfirmDate={confirmDate}
              />
            )}
            {room.stage === 'confirm' && (
              <ConfirmView
                room={room}
                user={user}
                host={host}
                busy={busy}
                onConfirm={confirmAttendance}
                onReopenDate={reopenDate}
              />
            )}
            {room.stage === 'region' && (
              <RegionView
                room={room}
                user={user}
                regionVotes={regionVotes}
                validVote={validRegionVote(room, user, regionVotes)}
                onVotesChange={setRegionVotes}
                onVote={vote}
                onOpenSheet={setSheet}
              />
            )}
            {room.stage === 'tie' && (
              <TieView
                room={room}
                host={host}
                onRunoff={runoff}
                onRandom={random}
              />
            )}
            {room.stage === 'final' && (
              <FinalView
                room={room}
                user={user}
                host={host}
                category={category}
                onCategoryChange={setCategory}
                onDeleteLink={deleteLink}
                onShare={share}
                onOpenSheet={setSheet}
              />
            )}
          </RoomView>
        )}
        {toast && (
          <output className="toast">
            <Check size={17} />
            {toast}
          </output>
        )}
        <MeetingSheets
          sheet={sheet}
          room={room}
          view={view}
          user={user}
          host={host}
          chosen={chosen}
          input={input}
          linkName={linkName}
          error={error}
          dialogRef={dialogRef}
          inputRef={sheetInputRef}
          onOpenSheet={setSheet}
          onInputChange={setInput}
          onLinkNameChange={setLinkName}
          onAddRegion={addRegion}
          onAddLink={addLink}
          onTransfer={transfer}
          onRemoveMember={removeMember}
          onCloseRoom={closeRoom}
          onLogout={logout}
          onCopyInvite={copyInvite}
        />
      </div>
    </>
  );
}
