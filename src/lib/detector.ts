// 메인 스레드용 감지 클라이언트: 워커에 맡기고, 워커를 쓸 수 없으면 영역 기반으로 직접 감지
import type { Quad } from './geometry';
import { type RGBA, detectByRegion } from './imgproc';

export type DetectMethod = 'edges' | 'region' | 'none';
export interface DetectRequest { id: number; img: RGBA; waitForEngine: boolean }
export interface DetectResult { quad: Quad | null; method: DetectMethod; score: number }
export type WorkerMessage =
  | { type: 'ready'; ok: boolean }
  | ({ type: 'result'; id: number } & DetectResult);

/** OpenCV(약 3.7MB) 첫 다운로드를 기다리는 최대 시간 */
const ENGINE_WAIT_MS = 30000;

type Status = 'loading' | 'ready' | 'failed';
let status: Status = 'loading';
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: DetectResult) => void>();
const statusWaiters = new Set<() => void>();

function setStatus(s: Status) {
  status = s;
  statusWaiters.forEach(f => f());
  statusWaiters.clear();
}

function getWorker(): Worker | null {
  if (worker || status === 'failed') return worker;
  try {
    worker = new Worker(new URL('../worker/detect.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        setStatus(msg.ok ? 'ready' : 'failed');
        return;
      }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    };
    worker.onerror = err => {
      console.error('감지 워커 오류', err);
      worker?.terminate();
      worker = null;
      setStatus('failed');
      pending.forEach(resolve => resolve({ quad: null, method: 'none', score: 0 }));
      pending.clear();
    };
  } catch (err) {
    console.warn('워커를 만들 수 없어 메인 스레드에서 감지', err);
    setStatus('failed');
  }
  return worker;
}

/** 앱 시작 시 호출: 사진을 고르는 동안 OpenCV를 미리 불러옴 */
export function warmUpDetector() {
  getWorker();
}

function waitForStatus(ms: number): Promise<void> {
  if (status !== 'loading') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); statusWaiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    statusWaiters.add(done);
  });
}

/**
 * 문서 사각형 감지. img의 버퍼는 워커로 넘어가므로 호출 후 사용하지 말 것.
 * 감지 엔진이 아직 내려받는 중이면 onWait로 알리고 기다림.
 */
export async function detectQuad(img: RGBA, onWait?: (msg: string) => void): Promise<DetectResult> {
  let w = getWorker();
  if (w && status === 'loading') {
    onWait?.('감지 엔진 준비 중… (처음 한 번만)');
    await waitForStatus(ENGINE_WAIT_MS);
    w = getWorker();
  }
  if (!w) {
    const d = detectByRegion(img);
    return { quad: d?.quad ?? null, method: d ? 'region' : 'none', score: d?.score ?? 0 };
  }
  const id = ++seq;
  const worker = w;
  return new Promise(resolve => {
    pending.set(id, resolve);
    const req: DetectRequest = { id, img, waitForEngine: status === 'ready' };
    worker.postMessage(req, [img.data.buffer]);
  });
}
