// 메인 스레드용 감지 클라이언트: 워커에 맡기고, 워커를 쓸 수 없으면 영역 기반으로 직접 감지
import type { Quad } from './geometry';
import { type RGBA, detectByRegion } from './imgproc';

export type DetectMethod = 'edges' | 'region' | 'none';
export interface DetectRequest { id: number; img: RGBA }
export interface DetectReply { id: number; quad: Quad | null; method: DetectMethod }

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, (r: DetectReply) => void>();

function getWorker(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL('../worker/detect.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<DetectReply>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    worker.onerror = err => {
      console.error('감지 워커 오류', err);
      worker?.terminate();
      worker = null;
      broken = true;
      pending.forEach((resolve, id) => resolve({ id, quad: null, method: 'none' }));
      pending.clear();
    };
  } catch (err) {
    console.warn('워커를 만들 수 없어 메인 스레드에서 감지', err);
    broken = true;
  }
  return worker;
}

/** 앱 시작 시 호출: 사진을 고르는 동안 OpenCV를 미리 불러옴 */
export function warmUpDetector() {
  getWorker();
}

/** img의 버퍼는 워커로 넘어가므로 호출 후 사용하지 말 것 */
export function detectQuad(img: RGBA): Promise<Omit<DetectReply, 'id'>> {
  const w = getWorker();
  if (!w) {
    const d = detectByRegion(img);
    return Promise.resolve({ quad: d?.quad ?? null, method: d ? 'region' : 'none' });
  }
  const id = ++seq;
  return new Promise(resolve => {
    pending.set(id, resolve);
    w.postMessage({ id, img } satisfies DetectRequest, [img.data.buffer]);
  });
}
