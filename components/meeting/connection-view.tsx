import { useEffect, useRef } from 'react';
import { CalendarDays, WifiOff } from 'lucide-react';
import type { InitialLoadState } from '../../hooks/use-meeting-sync';

type ConnectionViewProps = {
  state: Exclude<InitialLoadState, { status: 'ready' }>;
  onRetry: () => void;
};

export function ConnectionView({ state, onRetry }: ConnectionViewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const failed = state.status === 'error';
  useEffect(() => {
    if (failed) heading.current?.focus({ preventScroll: true });
  }, [failed]);

  return (
    <div className="app-shell">
      <main className="connection-view" aria-busy={!failed}>
        <div className="connection-icon" aria-hidden="true">
          {failed ? <WifiOff size={32} /> : <CalendarDays size={32} />}
        </div>
        <h1 ref={heading} tabIndex={-1}>
          {failed
            ? '서버에 연결하지 못했어요'
            : state.retrying
              ? '다시 연결하고 있어요'
              : '모임을 준비하고 있어요'}
        </h1>
        <p role={failed ? 'alert' : 'status'}>
          {failed ? state.message : '잠시만 기다려 주세요.'}
        </p>
        {(failed || state.retrying) && (
          <button
            type="button"
            className="primary"
            disabled={!failed}
            onClick={onRetry}
          >
            {failed ? '다시 연결하기' : '연결 중…'}
          </button>
        )}
      </main>
    </div>
  );
}
