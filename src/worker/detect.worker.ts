// 문서 감지 워커: OpenCV 경계 감지 우선, 준비 전이거나 실패하면 영역 기반 감지
import { detectByEdges } from '../lib/cvdetect';
import { type RGBA, detectByRegion } from '../lib/imgproc';
import { type CV, loadOpenCv } from '../lib/opencv';
import type { DetectReply, DetectRequest } from '../lib/detector';

/** 첫 감지 때 OpenCV 로딩을 이 시간까지만 기다림 */
const CV_WAIT_MS = 6000;

const cvReady: Promise<CV | null> = loadOpenCv()
  .then(({ cv }) => cv)
  .catch(err => {
    console.warn('OpenCV 로드 실패, 영역 기반 감지만 사용', err);
    return null;
  });

const timeout = (ms: number) => new Promise<null>(resolve => setTimeout(() => resolve(null), ms));

self.onmessage = async (e: MessageEvent<DetectRequest>) => {
  const { id, img } = e.data;
  const reply: DetectReply = { id, quad: null, method: 'none' };
  try {
    const rgba: RGBA = img;
    const region = detectByRegion(rgba);
    const cv = await Promise.race([cvReady, timeout(CV_WAIT_MS)]);
    const edges = cv ? detectByEdges(cv, rgba, region ? [region.quad] : []) : null;
    if (edges) Object.assign(reply, { quad: edges.quad, method: 'edges' });
    else if (region) Object.assign(reply, { quad: region.quad, method: 'region' });
  } catch (err) {
    console.error(err);
  }
  self.postMessage(reply);
};
