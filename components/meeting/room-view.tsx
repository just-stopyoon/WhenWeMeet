import type { ReactNode } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import type { Room } from '../../lib/meeting';

type RoomViewProps = {
  room: Room;
  user: string;
  host: boolean;
  busy: boolean;
  expired: boolean;
  onHome: () => void;
  onReopenDate: () => void;
  children: ReactNode;
};

export function RoomView({
  room,
  user,
  host,
  busy,
  expired,
  onHome,
  onReopenDate,
  children,
}: RoomViewProps) {
  return (
    <>
      {expired ? (
        <main>
          <div className="empty">
            <CalendarDays />
            <h1 tabIndex={-1}>종료된 약속이에요</h1>
            <p>새로운 약속으로 다시 만나요.</p>
            <button className="primary" onClick={onHome}>
              내 모임으로
            </button>
          </div>
        </main>
      ) : (
        <>
          <div className="steps">
            {['날짜', '지역', '약속'].map((s, i) => {
              const idx = ['schedule', 'date', 'confirm'].includes(room.stage)
                ? 0
                : room.stage === 'final'
                  ? 2
                  : 1;
              return (
                <div key={s} className={idx >= i ? 'on' : ''}>
                  <span>{idx > i ? <Check size={12} /> : i + 1}</span>
                  {i === 0 && host && ['region', 'tie'].includes(room.stage) ? (
                    <button
                      className="change-date-button"
                      disabled={busy}
                      onClick={onReopenDate}
                    >
                      일정 변경하기
                    </button>
                  ) : (
                    s
                  )}
                  {i < 2 && <i />}
                </div>
              );
            })}
          </div>
          {['region', 'tie', 'final'].includes(room.stage) && (
            <section
              className="meeting-attendees"
              aria-label="이번 약속 참석자"
            >
              <strong>이번 약속 참석자 · {room.attendees.length}명</strong>
              <p>
                {room.attendees.length
                  ? room.attendees.join(', ')
                  : '참석 가능한 사람이 없어요.'}
              </p>
              {!room.attendees.includes(user) && (
                <p className="spectator-notice">
                  선택된 날짜·시간에 참석하지 않는 것으로 되어 있어요. 현재 관전
                  중이며 지역 투표에는 참여할 수 없어요.
                </p>
              )}
            </section>
          )}
          {children}
        </>
      )}
    </>
  );
}
