import {
  CalendarDays,
  ChevronRight,
  Coffee,
  Copy,
  Heart,
  Link2,
  MapPin,
  PartyPopper,
  Plus,
  Utensils,
  X,
} from 'lucide-react';
import { addDays, labelDate, type Room } from '../../lib/meeting';
import type { LinkCategory, OpenSheet } from './types';
import { AvatarStack, Heading } from './ui';

type FinalViewProps = {
  room: Room;
  user: string;
  host: boolean;
  category: LinkCategory;
  onCategoryChange: (category: LinkCategory) => void;
  onDeleteLink: (id: string) => void;
  onShare: (text: string) => void;
  onOpenSheet: OpenSheet;
};

export function FinalView({
  room,
  user,
  host,
  category,
  onCategoryChange,
  onDeleteLink,
  onShare,
  onOpenSheet,
}: FinalViewProps) {
  return (
    <main>
      <div className="celebrate">
        <PartyPopper size={38} />
        <span>우리 약속, 준비 완료</span>
      </div>
      <Heading title="그날, 여기서 만나요!" />
      <div className="ticket">
        <div className="ticket-top">
          <span>OUR NEXT MEETUP</span>
          <Heart size={18} />
        </div>
        <h2>{room.title}</h2>
        <div>
          <CalendarDays />
          <p>
            <small>언제</small>
            <b>
              {labelDate(room.date!.split('|')[0])} · {room.date!.split('|')[1]}
            </b>
          </p>
        </div>
        <div>
          <MapPin />
          <p>
            <small>어디서</small>
            <b>{room.region}</b>
          </p>
        </div>
        <div className="ticket-people">
          <AvatarStack names={room.attendees} />
          <span>{room.attendees.length}명이 함께해요</span>
        </div>
      </div>
      <button
        className="secondary full"
        onClick={() =>
          onShare(
            `${room.title}\n${labelDate(room.date!.split('|')[0])} ${room.date!.split('|')[1]} · ${room.region}\n${window.location.origin}/?join=${room.code}`,
          )
        }
      >
        <Copy size={17} /> 약속 공유하기
      </button>
      <div className="section-head links-title">
        <h2>여기 어때요?</h2>
        <span>가고 싶은 곳을 모아봐요</span>
      </div>
      <div className="tabs">
        {(['food', 'cafe'] as const).map((c) => (
          <button
            key={c}
            className={category === c ? 'active' : ''}
            onClick={() => onCategoryChange(c)}
          >
            {c === 'food' ? <Utensils size={17} /> : <Coffee size={17} />}{' '}
            {c === 'food' ? '음식점' : '카페'}{' '}
            <span>{room.links.filter((l) => l.category === c).length}</span>
          </button>
        ))}
      </div>
      {room.links
        .filter((l) => l.category === category)
        .map((l) => (
          <div className="place-card" key={l.id}>
            <span className="place-icon">
              {category === 'food' ? '🍽️' : '☕'}
            </span>
            <a href={l.url} target="_blank" rel="noopener noreferrer">
              <b>{l.name || new URL(l.url).hostname}</b>
              <p>
                {new URL(l.url).hostname} <ChevronRight size={13} />
              </p>
            </a>
            {(host || l.author === user) && (
              <button
                className="icon-button"
                aria-label="링크 삭제"
                onClick={() => onDeleteLink(l.id)}
              >
                <X size={16} />
              </button>
            )}
          </div>
        ))}
      {!room.links.some((l) => l.category === category) && (
        <div className="empty-links">
          <Link2 size={26} />
          <b>첫 번째 장소를 추천해 주세요</b>
          <p>지도나 소개 페이지 링크면 충분해요.</p>
        </div>
      )}
      <button
        className="add-region"
        onClick={(event) => onOpenSheet('link', event.currentTarget)}
      >
        <Plus size={18} /> {category === 'food' ? '음식점' : '카페'} 링크 추가
      </button>
      <p className="expiration">
        이 모임은 {labelDate(addDays(room.date!.split('|')[0], 2))} 00:00에
        사라져요.
      </p>
    </main>
  );
}
