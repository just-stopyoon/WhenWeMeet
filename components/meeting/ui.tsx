import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { labelDate, type Room } from '../../lib/meeting';

export function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span className={'avatar c' + (index % 5)}>{name[0]}</span>;
}
export function AvailabilityHelp({ room, date }: { room: Room; date: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="availability-help" ref={ref}>
      <button
        type="button"
        className="availability-help-trigger"
        aria-label={`${labelDate(date)} 가능한 친구 보기`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <CircleHelp size={18} aria-hidden="true" />
      </button>
      {open && (
        <section
          id={id}
          className="availability-bubble"
          aria-label="시간대별 가능한 친구"
        >
          {['점심', '저녁'].map((slot) => {
            const people = room.members.filter((member) =>
              room.responses[member]?.includes(date + '|' + slot),
            );
            return (
              <div key={slot}>
                <strong>
                  {slot} · {people.length}명 가능
                </strong>
                <p>
                  {people.length ? people.join(', ') : '가능한 친구가 없어요.'}
                </p>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
export function Heading({
  title,
  desc,
  eyebrow,
}: {
  title: string;
  desc?: string;
  eyebrow?: string;
}) {
  return (
    <div className="heading">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1 tabIndex={-1}>
        {title
          .replaceAll('\\n', '\n')
          .split('\n')
          .map((s, i) => (
            <span key={i}>
              {s}
              <br />
            </span>
          ))}
      </h1>
      {desc && <p>{desc}</p>}
    </div>
  );
}
export function CTA({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="bottom-action">
      <button className="primary" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

export function AvatarStack({ names }: { names: string[] }) {
  return (
    <div className="avatar-stack">
      {names.map((name, index) => (
        <Avatar key={name} name={name} index={index} />
      ))}
    </div>
  );
}
