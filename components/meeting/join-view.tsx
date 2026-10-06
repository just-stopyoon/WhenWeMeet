import { CTA, Heading } from './ui';

type JoinViewProps = {
  code: string;
  error: string;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
};

export function JoinView({
  code,
  error,
  onCodeChange,
  onSubmit,
}: JoinViewProps) {
  return (
    <>
      <main>
        <Heading
          title="친구가 보낸\n초대 코드를 입력해요"
          desc="다시 들어가면 이전 응답이 그대로 있어요."
        />
        <label className="field">
          초대 코드
          <input
            value={code}
            maxLength={12}
            onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
            placeholder="12자리 초대 코드"
          />
        </label>
        <p className="helper">
          친구가 보낸 초대 링크를 열거나 12자리 코드를 입력해 주세요.
        </p>
        {error && <p className="error">{error}</p>}
      </main>
      <CTA onClick={onSubmit}>모임 참가하기</CTA>
    </>
  );
}
