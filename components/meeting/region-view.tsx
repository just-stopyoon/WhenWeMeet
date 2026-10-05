import { Check, MapPin, Plus } from 'lucide-react';
import { labelDate, type Room } from '../../lib/meeting';
import { regionVoteOptions } from '../../lib/meeting-view';
import type { OpenSheet } from './types';
import { CTA, Heading } from './ui';

type RegionViewProps = {
  room: Room;
  user: string;
  regionVotes: string[];
  validVote: boolean;
  onVotesChange: (choices: string[]) => void;
  onVote: () => void;
  onOpenSheet: OpenSheet;
};

export function RegionView({
  room,
  user,
  regionVotes,
  validVote,
  onVotesChange,
  onVote,
  onOpenSheet,
}: RegionViewProps) {
  return (
    <>
      <main>
        <div className="confirmed-banner">
          <Check size={18} />
          <b>
            {labelDate(room.date!.split('|')[0])} {room.date!.split('|')[1]}
          </b>
        </div>
        <Heading
          title="어디에서 만날까요?"
          desc={
            !room.attendees.includes(user)
              ? '참석하는 친구들이 지역을 고르고 있어요.'
              : room.round > 1
                ? '동률인 지역 중 한 곳을 골라 주세요.'
                : '마음 가는 지역을 최대 2곳 골라 주세요.'
          }
        />
        <div className="section-head">
          <span>선호 지역</span>
          <b className="blue-text">
            {room.attendees.includes(user)
              ? `${regionVotes.length} / ${room.round > 1 ? 1 : 2}개`
              : '관전 중'}
          </b>
        </div>
        <div className="regions">
          {regionVoteOptions(room).map((r) => (
            <button
              key={r}
              disabled={!room.attendees.includes(user)}
              aria-pressed={
                room.attendees.includes(user) && regionVotes.includes(r)
              }
              className={
                room.attendees.includes(user) && regionVotes.includes(r)
                  ? 'selected'
                  : ''
              }
              onClick={() =>
                onVotesChange(
                  regionVotes.includes(r)
                    ? regionVotes.filter((x) => x !== r)
                    : regionVotes.length < (room.round > 1 ? 1 : 2)
                      ? [...regionVotes, r]
                      : regionVotes,
                )
              }
            >
              <MapPin size={19} />
              <b>{r}</b>
              {room.attendees.includes(user) && regionVotes.includes(r) && (
                <Check size={15} />
              )}
            </button>
          ))}
        </div>
        {!regionVoteOptions(room).length && (
          <p className="helper">
            투표할 지역 후보가 없어요. 방장이 일정을 변경해 날짜와 지역을 다시
            정할 수 있어요.
          </p>
        )}
        {room.round === 1 && (
          <button
            className="add-region"
            onClick={(event) => onOpenSheet('addRegion', event.currentTarget)}
          >
            <Plus size={17} /> 다른 지역 추가하기
          </button>
        )}
        <p className="helper">
          {Object.keys(room.votes).length} / {room.attendees.length}명 제출 ·{' '}
          {room.round === 1
            ? '마감 전까지 후보를 추가하고 투표를 수정할 수 있어요.'
            : '동점인 후보 중 하나를 골라 주세요.'}
        </p>
      </main>
      {room.attendees.includes(user) ? (
        <CTA disabled={!validVote} onClick={onVote}>
          {room.votes[user] ? '선택 수정하기' : '이 지역으로 투표하기'}
        </CTA>
      ) : (
        <div className="bottom-action">
          <p className="helper">이번 일정은 관전 중이에요.</p>
        </div>
      )}
    </>
  );
}
