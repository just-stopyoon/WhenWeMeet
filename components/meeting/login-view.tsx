import { CTA, Heading } from './ui';

type LoginViewProps = {
  nick: string;
  pin: string;
  error: string;
  onNickChange: (value: string) => void;
  onPinChange: (value: string) => void;
  onSubmit: () => void;
};

export function LoginView({
  nick,
  pin,
  error,
  onNickChange,
  onPinChange,
  onSubmit,
}: LoginViewProps) {
  return (
    <>
      <main>
        <div className="login-symbol">👋</div>
        <Heading
          title="반가워요!\n어떻게 불러드릴까요?"
          desc="닉네임과 PIN 하나로 우리 모임을 관리해요."
        />
        <label className="field">
          닉네임
          <input
            autoComplete="username"
            maxLength={16}
            value={nick}
            onChange={(e) => onNickChange(e.target.value)}
            placeholder="친구들이 알아볼 수 있는 이름"
          />
        </label>
        <label className="field">
          숫자 4자리 PIN
          <input
            type="password"
            autoComplete="current-password"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => onPinChange(e.target.value.replace(/\D/g, ''))}
            placeholder="기억하기 쉬운 숫자 4자리"
          />
        </label>
        <p className="helper">
          처음 쓰는 닉네임이면 새 계정으로 시작해요.
          <br />
          PIN은 찾을 수 없으니 꼭 기억해 주세요.
        </p>
        {error && <p className="error">{error}</p>}
      </main>
      <CTA onClick={onSubmit}>시작하기</CTA>
    </>
  );
}
