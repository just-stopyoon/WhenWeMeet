import { useEffect, useState } from 'react';
import {
  koreanToday,
  millisecondsUntilKoreanMidnight,
} from '../lib/meeting-view';

export function useKoreanToday() {
  const [today, setToday] = useState(() => koreanToday());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const now = new Date();
      setToday(koreanToday(now));
      clearTimeout(timer);
      timer = setTimeout(
        update,
        Math.max(1, millisecondsUntilKoreanMidnight(now)),
      );
    };
    const visible = () => {
      if (document.visibilityState === 'visible') update();
    };
    update();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', update);
    };
  }, []);
  return today;
}
