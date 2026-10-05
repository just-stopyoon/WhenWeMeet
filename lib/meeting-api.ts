import type {
  MeetingError,
  MeetingRequest,
  MeetingResponse,
  MeetingSnapshot,
} from './meeting-contract';

export async function meetingApi(): Promise<MeetingSnapshot>;
export async function meetingApi<R extends MeetingRequest>(
  payload: R,
): Promise<MeetingResponse<R>>;
export async function meetingApi(
  payload?: MeetingRequest,
): Promise<MeetingSnapshot | MeetingResponse> {
  const response = await fetch(
    '/api/meeting',
    payload
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      : { cache: 'no-store' },
  );
  const data = (await response.json()) as
    | MeetingSnapshot
    | MeetingResponse
    | MeetingError;
  if (!response.ok)
    throw new Error(
      ('error' in data && data.error) ||
        '연결하지 못했어요. 다시 시도해 주세요.',
    );
  return data as MeetingSnapshot | MeetingResponse;
}
