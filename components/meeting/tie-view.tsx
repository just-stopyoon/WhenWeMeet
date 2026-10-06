import { MapPin, Sparkles } from 'lucide-react';
import type { Room } from '../../lib/meeting';
import { Heading } from './ui';

type TieViewProps = {
  room: Room;
  host: boolean;
  onRunoff: () => void;
  onRandom: () => void;
};

export function TieView({ room, host, onRunoff, onRandom }: TieViewProps) {
  return (
    <main>
      <div className="result-icon">🤔</div>
      <Heading
        title={
          room.tied?.length
            ? '친구들의 마음이\n반반으로 나뉘었어요'
            : '다시 고를 지역이 없어요'
        }
        desc={
          room.tied?.length
            ? '한 번 더 골라 볼까요, 운에 맡겨 볼까요?'
            : '방장이 일정을 변경해 날짜와 지역을 다시 정할 수 있어요.'
        }
      />
      <div className="tie-options">
        {room.tied?.map((r) => (
          <div key={r}>
            <MapPin />
            <b>{r}</b>
          </div>
        ))}
      </div>
      {host && !!room.tied?.length ? (
        <>
          <button className="primary" onClick={onRunoff}>
            한 번 더 투표하기
          </button>
          <button className="secondary full" onClick={onRandom}>
            <Sparkles size={18} /> 무작위로 정하기
          </button>
        </>
      ) : (
        !host && <p className="helper">방장이 다음 방법을 선택하고 있어요.</p>
      )}
    </main>
  );
}
