import { CalendarDays, ChevronRight } from 'lucide-react';
import { labelDate, type Room } from '../../lib/meeting';
import {
  isSelectableDate,
  type dateCandidateView,
} from '../../lib/meeting-view';
import { AvailabilityHelp, Heading } from './ui';

type DateViewProps = {
  room: Room;
  host: boolean;
  today: string;
  dateCandidates: ReturnType<typeof dateCandidateView>;
  customDate: string;
  onCustomDateChange: (date: string) => void;
  onShowMore: () => void;
  onConfirmDate: (slot: string, manual: boolean) => void;
};

export function DateView({
  room,
  host,
  today,
  dateCandidates,
  customDate,
  onCustomDateChange,
  onShowMore,
  onConfirmDate,
}: DateViewProps) {
  return (
    <main>
      <div className="result-icon">
        <CalendarDays size={36} />
        <span>✨</span>
      </div>
      <Heading
        title={
          dateCandidates.slots.length
            ? '함께할 수 있는 날을\n찾았어요!'
            : '남은 기간에 조건에 맞는\n날짜가 없어요'
        }
        desc={
          host
            ? '친구들과 이야기하고 날짜를 확정해 주세요.'
            : '방장이 최종 날짜를 선택하고 있어요.'
        }
      />
      <div className="candidate-list">
        {dateCandidates.dates.map((d) => {
          const candidates = dateCandidates.slots.filter((c) =>
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
                <div className="candidate-availability">
                  <p>
                    {Math.max(...candidates.map((c) => c.count))}
                    명 가능{' '}
                    {d === dateCandidates.earliestDate ? '· 가장 이른 날' : ''}
                  </p>
                  <AvailabilityHelp room={room} date={d} />
                </div>
                <div className="candidate-slots">
                  {candidates.map((c) => (
                    <button
                      disabled={!host}
                      key={c.slot}
                      onClick={() => onConfirmDate(c.slot, false)}
                    >
                      {c.slot.split('|')[1]} 확정 <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {dateCandidates.hasMore && (
        <button className="secondary full" onClick={onShowMore}>
          날짜 더 보기
        </button>
      )}
      {host && (
        <div className="manual-date">
          <h3>다른 날짜로 정하고 싶나요?</h3>
          <p>기간 안의 날짜를 고르면 참석 여부를 다시 받아요.</p>
          <input
            aria-label="다른 날짜"
            type="date"
            min={room.start < today ? today : room.start}
            max={room.end}
            value={customDate}
            onChange={(e) => onCustomDateChange(e.target.value)}
          />
          <div className="two-buttons">
            {['점심', '저녁'].map((s) => (
              <button
                className="secondary"
                disabled={
                  !customDate || !isSelectableDate(room, customDate, today)
                }
                key={s}
                onClick={() => onConfirmDate(customDate + '|' + s, true)}
              >
                {s}으로 다시 확인
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
