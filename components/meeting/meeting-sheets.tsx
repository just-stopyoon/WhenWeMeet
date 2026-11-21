import type { RefObject } from 'react';
import { ChevronRight, Copy, Link2, LogOut, Users, X } from 'lucide-react';
import { labelDate, memberLabel, type Room } from '../../lib/meeting';
import type { PushState } from '../../hooks/use-push-notifications';
import type { OpenSheet, Sheet, View } from './types';
import { Avatar } from './ui';

type MeetingSheetsProps = {
  sheet: Sheet;
  room?: Room;
  view: View;
  user: string;
  nickname?: string;
  host: boolean;
  chosen: string;
  input: string;
  linkName: string;
  error: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpenSheet: OpenSheet;
  onInputChange: (value: string) => void;
  onLinkNameChange: (value: string) => void;
  onAddRegion: () => void;
  onAddLink: () => void;
  onTransfer: (member: string) => void;
  onRemoveMember: (member: string) => void;
  onCloseRoom: () => void;
  onLogout: () => void;
  onCopyInvite: () => void;
  pushState: PushState;
  pushWorking: boolean;
  onPushEnable: () => void;
  onPushDisable: () => void;
  onPushLater: () => void;
};

export const pushUnsupportedText =
  'iPhone은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요. 공유 → 홈 화면에 추가';
export const pushDeniedText =
  '알림이 꺼져 있어요. 기기 설정에서 허용해 주세요.';

// The "알림" row of "내 계정" (issue #14 T5 state table).
function PushRow({
  pushState,
  pushWorking,
  onPushEnable,
  onPushDisable,
}: Pick<
  MeetingSheetsProps,
  'pushState' | 'pushWorking' | 'onPushEnable' | 'onPushDisable'
>) {
  if (pushState === 'unsupported')
    return <p className="menu-row">{pushUnsupportedText}</p>;
  if (pushState === 'denied')
    return <p className="menu-row">{pushDeniedText}</p>;
  if (pushState === 'on')
    return (
      <div className="menu-row">
        <span className="menu-row-label">알림 켜짐</span>
        <button
          className="text-button"
          disabled={pushWorking}
          onClick={onPushDisable}
        >
          끄기
        </button>
      </div>
    );
  if (pushState === 'off' || pushState === 'preparing')
    return (
      <button
        className="menu-row"
        disabled={pushState === 'preparing' || pushWorking}
        onClick={onPushEnable}
      >
        알림 켜기
      </button>
    );
  return null;
}

// Shown once right after creating or joining a room (off or unsupported).
function PushPromptSheet({
  pushState,
  onPushEnable,
  onPushLater,
  onOpenSheet,
}: Pick<
  MeetingSheetsProps,
  'pushState' | 'onPushEnable' | 'onPushLater' | 'onOpenSheet'
>) {
  return (
    <>
      <h2 id="sheet-title">알림을 켜면 내 차례가 왔을 때 알려 드려요</h2>
      {pushState === 'unsupported' && <p>{pushUnsupportedText}</p>}
      {pushState === 'off' && (
        <button
          className="primary"
          onClick={() => {
            onPushEnable();
            onOpenSheet(null);
          }}
        >
          알림 켜기
        </button>
      )}
      <button className="secondary full" onClick={onPushLater}>
        나중에
      </button>
    </>
  );
}

function MembersSheet({
  room,
  onOpenSheet,
}: {
  room: Room;
  onOpenSheet: OpenSheet;
}) {
  return (
    <>
      <h2 id="sheet-title">함께하는 친구들</h2>
      <p>
        {room.members.length}명 입장 · 총 {room.size}명
      </p>
      {room.members.map((member, index) => (
        <div className="member-row" key={member}>
          <Avatar name={memberLabel(room, member)} index={index} />
          <b>{memberLabel(room, member)}</b>
          {room.host === member && <span className="tag blue">방장</span>}
        </div>
      ))}
      <button className="primary" onClick={() => onOpenSheet('invite')}>
        <Link2 size={18} /> 친구 초대하기
      </button>
    </>
  );
}

function AttendeesSheet({ room, chosen }: { room: Room; chosen: string }) {
  return (
    <>
      <h2 id="sheet-title">{labelDate(chosen)} 가능한 친구</h2>
      {['점심', '저녁'].map((slot) => (
        <div className="attendee-row" key={slot}>
          <b>{slot}</b>
          <p>
            {room.members
              .filter((member) =>
                room.responses[member]?.includes(chosen + '|' + slot),
              )
              .map((id) => memberLabel(room, id))
              .join(', ') || '아직 제출한 친구가 없어요'}
          </p>
        </div>
      ))}
    </>
  );
}

function InviteSheet({
  room,
  onCopyInvite,
}: {
  room: Room;
  onCopyInvite: () => void;
}) {
  return (
    <>
      <div className="sheet-symbol">
        <Users />
      </div>
      <h2 id="sheet-title">친구들과 함께 정해요</h2>
      <p>아래 코드를 친구들에게 알려주세요.</p>
      <div className="invite-code">{room.code}</div>
      <p className="helper">
        링크를 받은 친구는 회원가입 또는 로그인 후 참여할 수 있어요.
      </p>
      <button className="primary" onClick={onCopyInvite}>
        <Copy size={18} /> 초대 링크 복사하기
      </button>
    </>
  );
}

function AddRegionSheet({
  input,
  inputRef,
  onInputChange,
  onAddRegion,
}: Pick<
  MeetingSheetsProps,
  'input' | 'inputRef' | 'onInputChange' | 'onAddRegion'
>) {
  return (
    <>
      <h2 id="sheet-title">어디에서 만나고 싶나요?</h2>
      <label className="field">
        지역 이름
        <input
          autoFocus
          ref={inputRef}
          maxLength={25}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="예: 여의도, 문래"
        />
      </label>
      <button className="primary" onClick={onAddRegion}>
        후보 추가하기
      </button>
    </>
  );
}

function LinkSheet({
  input,
  linkName,
  inputRef,
  onInputChange,
  onLinkNameChange,
  onAddLink,
}: Pick<
  MeetingSheetsProps,
  | 'input'
  | 'linkName'
  | 'inputRef'
  | 'onInputChange'
  | 'onLinkNameChange'
  | 'onAddLink'
>) {
  return (
    <>
      <h2 id="sheet-title">좋은 곳을 발견했나요?</h2>
      <p>친구들에게 가고 싶은 곳을 알려주세요.</p>
      <label className="field">
        링크
        <input
          autoFocus
          ref={inputRef}
          type="url"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="https://map.naver.com/..."
        />
      </label>
      <label className="field">
        이름 <small>선택</small>
        <input
          value={linkName}
          onChange={(event) => onLinkNameChange(event.target.value)}
          placeholder="장소 이름을 적어 주세요"
        />
      </label>
      <p className="helper">매장명 자동 가져오기는 연결 전이에요.</p>
      <button className="primary" onClick={onAddLink}>
        링크 추가하기
      </button>
    </>
  );
}

function SettingsSheet({
  room,
  view,
  user,
  nickname,
  host,
  onOpenSheet,
  onTransfer,
  onRemoveMember,
  onCloseRoom,
  onLogout,
  pushState,
  pushWorking,
  onPushEnable,
  onPushDisable,
}: Pick<
  MeetingSheetsProps,
  | 'room'
  | 'view'
  | 'user'
  | 'nickname'
  | 'host'
  | 'onOpenSheet'
  | 'onTransfer'
  | 'onRemoveMember'
  | 'onCloseRoom'
  | 'onLogout'
  | 'pushState'
  | 'pushWorking'
  | 'onPushEnable'
  | 'onPushDisable'
>) {
  return (
    <>
      <h2 id="sheet-title">{view === 'room' ? '모임 관리' : '내 계정'}</h2>
      {view === 'room' && room ? (
        <>
          <button className="menu-row" onClick={() => onOpenSheet('invite')}>
            <Link2 />
            친구 초대
            <ChevronRight />
          </button>
          {host && (
            <>
              <h3 className="small-heading">친구 관리</h3>
              {room.members
                .filter((member) => member !== user)
                .map((member, index) => (
                  <div className="member-row" key={member}>
                    <Avatar
                      name={memberLabel(room, member)}
                      index={index + 1}
                    />
                    <b>{memberLabel(room, member)}</b>
                    <button
                      className="text-button"
                      onClick={() => onTransfer(member)}
                    >
                      방장 넘기기
                    </button>
                    <button
                      className="text-button danger"
                      onClick={() => onRemoveMember(member)}
                    >
                      내보내기
                    </button>
                  </div>
                ))}
              <button className="menu-row danger" onClick={onCloseRoom}>
                <X />
                모임 조기 종료
              </button>
            </>
          )}
          {!host && (
            <button
              className="menu-row danger"
              onClick={() => onRemoveMember(user)}
            >
              <LogOut />
              모임 나가기
            </button>
          )}
        </>
      ) : (
        <>
          <p>{nickname ?? user}님으로 이용 중이에요.</p>
          <PushRow
            pushState={pushState}
            pushWorking={pushWorking}
            onPushEnable={onPushEnable}
            onPushDisable={onPushDisable}
          />
          <button className="menu-row" onClick={onLogout}>
            <LogOut />
            로그아웃
          </button>
        </>
      )}
    </>
  );
}

export function MeetingSheets({
  sheet,
  room,
  view,
  user,
  nickname,
  host,
  chosen,
  input,
  linkName,
  error,
  dialogRef,
  inputRef,
  onOpenSheet,
  onInputChange,
  onLinkNameChange,
  onAddRegion,
  onAddLink,
  onTransfer,
  onRemoveMember,
  onCloseRoom,
  onLogout,
  onCopyInvite,
  pushState,
  pushWorking,
  onPushEnable,
  onPushDisable,
  onPushLater,
}: MeetingSheetsProps) {
  if (!sheet) return null;
  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        onOpenSheet(null);
      }}
    >
      <div className="sheet-handle" />
      <button
        className="sheet-close icon-button"
        aria-label="닫기"
        onClick={() => onOpenSheet(null)}
      >
        <X />
      </button>
      {sheet === 'members' && room && (
        <MembersSheet room={room} onOpenSheet={onOpenSheet} />
      )}
      {sheet === 'attendees' && room && (
        <AttendeesSheet room={room} chosen={chosen} />
      )}
      {sheet === 'invite' && room && (
        <InviteSheet room={room} onCopyInvite={onCopyInvite} />
      )}
      {sheet === 'addRegion' && room && (
        <AddRegionSheet
          input={input}
          inputRef={inputRef}
          onInputChange={onInputChange}
          onAddRegion={onAddRegion}
        />
      )}
      {sheet === 'link' && room && (
        <LinkSheet
          input={input}
          linkName={linkName}
          inputRef={inputRef}
          onInputChange={onInputChange}
          onLinkNameChange={onLinkNameChange}
          onAddLink={onAddLink}
        />
      )}
      {sheet === 'settings' && (
        <SettingsSheet
          room={room}
          view={view}
          user={user}
          nickname={nickname}
          host={host}
          onOpenSheet={onOpenSheet}
          onTransfer={onTransfer}
          onRemoveMember={onRemoveMember}
          onCloseRoom={onCloseRoom}
          onLogout={onLogout}
          pushState={pushState}
          pushWorking={pushWorking}
          onPushEnable={onPushEnable}
          onPushDisable={onPushDisable}
        />
      )}
      {sheet === 'push' && (
        <PushPromptSheet
          pushState={pushState}
          onPushEnable={onPushEnable}
          onPushLater={onPushLater}
          onOpenSheet={onOpenSheet}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
