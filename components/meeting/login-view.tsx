import Image from 'next/image';
import { CTA, Heading } from './ui';

type LoginViewProps = {
  signup: boolean;
  accountId: string;
  nick: string;
  pin: string;
  error: string;
  busy: boolean;
  onModeChange: () => void;
  onIdChange: (value: string) => void;
  onNickChange: (value: string) => void;
  onPinChange: (value: string) => void;
  onSubmit: () => void;
};

export function LoginView({
  signup,
  accountId,
  nick,
  pin,
  error,
  busy,
  onModeChange,
  onIdChange,
  onNickChange,
  onPinChange,
  onSubmit,
}: LoginViewProps) {
  return (
    <>
      <main>
        <Image
          unoptimized
          className="login-logo"
          src="/app-logo.png"
          alt="언제 만날래"
          width={80}
          height={80}
        />
        <Heading
          title={
            signup
              ? '처음 만나요!\n함께할 준비를 해볼까요?'
              : '반가워요!\n우리 언제 만날까요?'
          }
          desc={
            signup
              ? '아이디와 닉네임을 정하고 시작해요.'
              : '아이디와 비밀번호로 내 모임을 만나보세요.'
          }
        />
        <form
          id="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) onSubmit();
          }}
        >
          <label className="field">
            아이디
            <input
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={20}
              value={accountId}
              onChange={(e) => onIdChange(e.target.value)}
              placeholder="로그인에 사용할 아이디"
            />
          </label>
          <label className="field">
            숫자 4자리 PIN
            <input
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              inputMode="numeric"
              required
              pattern="[0-9]{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => onPinChange(e.target.value.replace(/\D/g, ''))}
              placeholder="숫자 4자리"
            />
          </label>
          {signup && (
            <label className="field">
              닉네임
              <input
                autoComplete="off"
                required
                maxLength={20}
                value={nick}
                onChange={(e) => onNickChange(e.target.value)}
                placeholder="친구들이 알아볼 수 있는 이름"
              />
              <small>다른 사람과 같은 닉네임도 사용할 수 있어요.</small>
            </label>
          )}
          <button type="submit" hidden tabIndex={-1} aria-hidden="true">
            제출
          </button>
        </form>
        <p className="helper">
          {signup
            ? '아이디와 비밀번호는 복구할 수 없으니 꼭 기억해 주세요.'
            : '기존 회원은 이전 닉네임을 아이디에 입력해 주세요.'}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="text-button auth-switch"
          disabled={busy}
          onClick={onModeChange}
        >
          {signup ? '이미 계정이 있어요 · 로그인' : '처음이에요 · 회원가입'}
        </button>
      </main>
      <CTA
        disabled={
          busy ||
          !accountId.trim() ||
          !/^\d{4}$/.test(pin) ||
          (signup && !nick.trim())
        }
        onClick={onSubmit}
      >
        {signup ? '회원가입' : '로그인'}
      </CTA>
    </>
  );
}
