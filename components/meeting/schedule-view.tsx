import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Moon,
  Sun,
} from 'lucide-react';
import { iso, labelDate, type Room } from '../../lib/meeting';
import { isSelectableDate } from '../../lib/meeting-view';
import type { OpenSheet } from './types';
import { AvatarStack, CTA, Heading } from './ui';

type ScheduleViewProps = {
  room: Room;
  user: string;
  today: string;
  month: string;
  chosen: string;
  selected: string[];
  showScheduleResults: boolean;
  onMonthChange: (month: string) => void;
  onChosenChange: (date: string) => void;
  onSelectedChange: (slots: string[]) => void;
  onEditSchedule: () => void;
  onSubmit: () => void;
  onOpenSheet: OpenSheet;
};

export function ScheduleView({
  room,
  user,
  today,
  month,
  chosen,
  selected,
  showScheduleResults,
  onMonthChange,
  onChosenChange,
  onSelectedChange,
  onEditSchedule,
  onSubmit,
  onOpenSheet,
}: ScheduleViewProps) {
  return (
    <>
      <main>
        <Heading
          title={
            showScheduleResults
              ? '친구들은 언제 가능할까요?'
              : '우리, 언제 시간 돼요?'
          }
          desc={
            showScheduleResults
              ? '제출된 일정의 중간 결과예요. 날짜를 눌러 확인해 보세요.'
              : '가능한 날짜의 점심·저녁을 골라 주세요.'
          }
        />
        <button
          aria-label="참여 인원 보기"
          className="participation"
          onClick={(event) => onOpenSheet('members', event.currentTarget)}
        >
          <AvatarStack names={room.members.slice(0, 4)} />
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
                  onClick={async () => {
                    const d = new Date(month + '-01T12:00:00');
                    d.setMonth(d.getMonth() + n);
                    onMonthChange(iso(d).slice(0, 7));
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
                const date = month + '-' + String(i + 1).padStart(2, '0'),
                  slots = selected.filter((s) => s.startsWith(date));
                const counts = ['점심', '저녁'].map(
                  (s) =>
                    room.members.filter((m) =>
                      room.responses[m]?.includes(date + '|' + s),
                    ).length,
                );
                const available = Math.max(...counts);
                const heat = available / room.size;
                return (
                  <button
                    key={date}
                    disabled={
                      date < room.start ||
                      date > room.end ||
                      (!showScheduleResults && date < today)
                    }
                    className={
                      (chosen === date ? 'focused ' : '') +
                      (!showScheduleResults && slots.length
                        ? 'has-selection'
                        : '')
                    }
                    style={
                      showScheduleResults
                        ? {
                            backgroundColor: available
                              ? `hsl(215 90% ${96 - heat * 48}%)`
                              : '#f2f4f6',
                            color: heat >= 0.6 ? '#fff' : '#191f28',
                            outline:
                              chosen === date ? '2px solid #191f28' : undefined,
                            outlineOffset: '-2px',
                          }
                        : undefined
                    }
                    onClick={() => onChosenChange(date)}
                    aria-label={
                      showScheduleResults
                        ? `${labelDate(date)}, 점심 ${counts[0]}명, 저녁 ${counts[1]}명 가능`
                        : `${labelDate(date)} 선택`
                    }
                    aria-pressed={chosen === date}
                  >
                    <b>{i + 1}</b>
                    {showScheduleResults ? (
                      <span className="heat-count">{available}명</span>
                    ) : (
                      <div className="dots">
                        {['점심', '저녁'].map((s) => (
                          <i
                            key={s}
                            className={
                              slots.includes(date + '|' + s) ? 'filled' : ''
                            }
                          />
                        ))}
                      </div>
                    )}
                    {date === today && <small>오늘</small>}
                  </button>
                );
              },
            )}
          </div>
        </div>
        {showScheduleResults && (
          <>
            <p className="helper">
              점심·저녁 중 더 많은 인원이 가능한 시간대를 기준으로 표시해요.
              진할수록 많은 친구가 가능해요. (최대 {room.size}명)
            </p>
            <section
              className="schedule-results"
              aria-label="선택한 날짜의 중간 결과"
            >
              <h3>{labelDate(chosen)}</h3>
              {['점심', '저녁'].map((slot) => {
                const people = room.members.filter((m) =>
                  room.responses[m]?.includes(chosen + '|' + slot),
                );
                return (
                  <div key={slot}>
                    <h4>
                      {slot} · {people.length}명 가능
                    </h4>
                    <p>
                      {people.length
                        ? people.join(', ')
                        : '제출한 친구 중 가능한 사람이 없어요.'}
                    </p>
                  </div>
                );
              })}
              <p className="helper">
                아직 제출하지 않은 친구의 일정은 포함되지 않아요.
              </p>
            </section>
          </>
        )}
        {!showScheduleResults && (
          <>
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
                      disabled={!isSelectableDate(room, chosen, today)}
                      aria-pressed={yes}
                      className={yes ? 'active' : ''}
                      onClick={() =>
                        onSelectedChange(
                          yes
                            ? selected.filter((x) => x !== key)
                            : [...selected, key],
                        )
                      }
                    >
                      {i === 0 ? <Sun size={23} /> : <Moon size={23} />}
                      <b>{s}</b>
                      <span className="slot-check">
                        {yes && <Check size={13} />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {user in room.responses && (
                <button
                  className="text-button"
                  onClick={(event) =>
                    onOpenSheet('attendees', event.currentTarget)
                  }
                >
                  이 시간에 가능한 친구 보기 <ChevronRight size={15} />
                </button>
              )}
            </div>
            <div className="selection-summary">
              <CheckCheck size={20} />
              <p>
                {selected.length ? (
                  <>
                    <b>
                      {new Set(selected.map((s) => s.split('|')[0])).size}일
                    </b>
                    의 일정을 골랐어요
                  </>
                ) : (
                  '선택하지 않은 시간은 불가능으로 제출돼요'
                )}
              </p>
              {!!selected.length && (
                <button onClick={() => onSelectedChange([])}>초기화</button>
              )}
            </div>
            {room.responses[user] && (
              <p className="helper">
                이미 제출했어요. 마감 전까지 바꿀 수 있어요.
              </p>
            )}
          </>
        )}
      </main>
      <CTA onClick={showScheduleResults ? onEditSchedule : onSubmit}>
        {showScheduleResults
          ? '내 일정 수정하기'
          : selected.length
            ? '이 일정으로 제출하기'
            : '가능한 일정 없음으로 제출'}
      </CTA>
    </>
  );
}
