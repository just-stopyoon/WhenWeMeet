import type { Room } from '../../lib/meeting';
import { CTA, Heading } from './ui';

type CreateViewProps = {
  name: string;
  start: string;
  end: string;
  size: number;
  mode: Room['mode'];
  today: string;
  error: string;
  onNameChange: (value: string) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onSizeChange: (value: number) => void;
  onModeChange: (value: Room['mode']) => void;
  onSubmit: () => void;
};

export function CreateView({
  name,
  start,
  end,
  size,
  mode,
  today,
  error,
  onNameChange,
  onStartChange,
  onEndChange,
  onSizeChange,
  onModeChange,
  onSubmit,
}: CreateViewProps) {
  return (
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
            onChange={(e) => onNameChange(e.target.value)}
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
              onClick={() => onSizeChange(size - 1)}
            >
              −
            </button>
            <strong>{size}명</strong>
            <button
              aria-label="인원 늘리기"
              disabled={size === 10}
              onClick={() => onSizeChange(size + 1)}
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
              onChange={(e) => onStartChange(e.target.value)}
            />
            <span>—</span>
            <input
              aria-label="종료일"
              type="date"
              min={start}
              value={end}
              onChange={(e) => onEndChange(e.target.value)}
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
                m === 'all' ? '모두 가능한 날' : '가장 많이 모일 수 있는 날'
              }
              aria-pressed={mode === m}
              className={'radio-card ' + (mode === m ? 'selected' : '')}
              onClick={() => onModeChange(m)}
            >
              <div>
                <b>
                  {m === 'all' ? '모두 가능한 날' : '가장 많이 모일 수 있는 날'}
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
      <CTA onClick={onSubmit}>모임 만들기</CTA>
    </>
  );
}
