// 문서 감지 워커: OpenCV 경계 감지. 엔진을 불러오지 못했을 때만 영역 기반 감지로 대체
import { detectByEdges } from '../lib/cvdetect';
import type { DetectRequest, DetectResult, WorkerMessage } from '../lib/detector';
import { detectByRegion } from '../lib/imgproc';
import { type CV, loadOpenCv } from '../lib/opencv';

let engine: CV | null = null;
const post = (msg: WorkerMessage) => self.postMessage(msg);

const cvReady: Promise<CV | null> = loadOpenCv()
  .then(({ cv }) => (engine = cv))
  .catch(err => {
    console.warn('OpenCV 로드 실패, 영역 기반 감지만 사용', err);
    return null;
  });
cvReady.then(cv => post({ type: 'ready', ok: !!cv }));

self.onmessage = async (e: MessageEvent<DetectRequest>) => {
  const { id, img, waitForEngine } = e.data;
  let result: DetectResult = { quad: null, method: 'none', score: 0 };
  try {
    const cv = waitForEngine ? await cvReady : engine;
    const region = detectByRegion(img);
    if (cv) {
      // 영역 기반 결과도 후보로만 넣고 경계 기준으로 검증 — 검증을 못 넘으면 "못 찾음"
      const d = detectByEdges(cv, img, region ? [region.quad] : []);
      if (d) result = { quad: d.quad, method: 'edges', score: d.score };
    } else if (region) {
      result = { quad: region.quad, method: 'region', score: region.score };
    }
  } catch (err) {
    console.error(err);
  }
  post({ type: 'result', id, ...result });
};
