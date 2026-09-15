// 문서 감지 워커: OpenCV 경계 감지(4방향 투표). 엔진을 불러오지 못했을 때만 영역 기반 감지로 대체
import { detectRobust } from '../lib/cvdetect';
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
    if (cv) {
      // 영역 기반 결과도 후보로 넣되 경계 기준 검증을 통과해야 함 — 못 넘으면 "못 찾음"
      const d = detectRobust(cv, img);
      if (d) result = { quad: d.quad, method: 'edges', score: d.score, votes: d.votes };
    } else {
      const region = detectByRegion(img);
      if (region) result = { quad: region.quad, method: 'region', score: region.score };
    }
  } catch (err) {
    console.error(err);
  }
  post({ type: 'result', id, ...result });
};
