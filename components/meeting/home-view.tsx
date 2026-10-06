import { CalendarDays, Check, ChevronRight, Plus } from 'lucide-react';
import { labelDate, type Room } from '../../lib/meeting';
import { AvatarStack, CTA, Heading } from './ui';

type HomeViewProps = {
  user: string;
  today: string;
  rooms: Room[];
  onOpenRoom: (room: Room) => void;
  onJoin: () => void;
  onCreate: () => void;
};

export function HomeView({
  user,
  today,
  rooms,
  onOpenRoom,
  onJoin,
  onCreate,
}: HomeViewProps) {
  return (
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
              <strong>{rooms.length}개</strong> 있어요
            </h2>
          </div>
          <div className="calendar-art">
            <div>LET’S MEET</div>
            <b>{Number(today.slice(8))}</b>
            <span className="art-check">
              <Check size={19} />
            </span>
          </div>
        </div>
        <div className="section-head">
          <h2>
            내 모임 <span>{rooms.length}</span>
          </h2>
          <button className="text-button" onClick={onJoin}>
            코드로 참가 <ChevronRight size={15} />
          </button>
        </div>
        {rooms.map((r, i) => (
          <button
            className="room-card"
            key={r.id}
            onClick={() => onOpenRoom(r)}
          >
            <div className="card-top">
              <span className="room-emoji">{i % 2 === 0 ? '🍀' : '☕'}</span>
              <span
                className={'tag ' + (r.stage === 'final' ? 'green' : 'blue')}
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
                ? labelDate(r.date.split('|')[0]) + ' · ' + r.date.split('|')[1]
                : `${labelDate(r.start)} – ${labelDate(r.end)}`}
            </p>
            <div className="card-bottom">
              <AvatarStack names={r.members.slice(0, 4)} />
              <span>
                {r.stage === 'schedule'
                  ? `${Object.keys(r.responses).length} / ${r.size}명 제출`
                  : `${r.attendees.length}명과 함께`}
              </span>
            </div>
          </button>
        ))}
        {!rooms.length && (
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
      <CTA onClick={onCreate}>
        <Plus size={20} /> 새 모임 만들기
      </CTA>
    </>
  );
}
