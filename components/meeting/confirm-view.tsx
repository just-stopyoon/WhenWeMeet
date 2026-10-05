import { CalendarDays } from 'lucide-react';
import { labelDate, type Room } from '../../lib/meeting';
import { Heading } from './ui';

type ConfirmViewProps = {
  room: Room;
  user: string;
  host: boolean;
  busy: boolean;
  onConfirm: (value: boolean) => void;
  onReopenDate: () => void;
};

export function ConfirmView({
  room,
  user,
  host,
  busy,
  onConfirm,
  onReopenDate,
}: ConfirmViewProps) {
  return (
    <main>
      <Heading
        title="이날, 함께할 수 있나요?"
        desc="전체 일정을 다시 고를 필요 없어요."
      />
      <div className="confirmed-banner">
        <CalendarDays />
        <b>
          {labelDate(room.date!.split('|')[0])} {room.date!.split('|')[1]}
        </b>
      </div>
      <div className="two-buttons">
        {[true, false].map((v) => (
          <button
            key={String(v)}
            className={v ? 'primary' : 'secondary'}
            aria-pressed={room.confirmations?.[user] === v}
            onClick={() => onConfirm(v)}
          >
            {v ? '갈 수 있어요' : '이번엔 어려워요'}
          </button>
        ))}
      </div>
      <p className="helper">
        {Object.keys(room.confirmations || {}).length} / {room.members.length}명
        확인
      </p>
      {room.members.every((member) => member in (room.confirmations || {})) &&
        room.attendees.length < 2 && (
          <p className="helper">
            참석 가능한 친구가 2명보다 적어요. 방장이 다른 날짜를 선택할 수
            있어요.
          </p>
        )}
      {host && (
        <button
          className="secondary full"
          disabled={busy}
          onClick={onReopenDate}
        >
          다른 날짜 선택하기
        </button>
      )}
    </main>
  );
}
