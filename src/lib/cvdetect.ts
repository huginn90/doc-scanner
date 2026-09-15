// OpenCV 기반 문서 감지: 채널별 Canny 경계 → 윤곽선 → 사각형 후보 → 경계 일치도로 채점
import { type Point, type Quad, isConvex, orderQuad, polyArea, dist } from './geometry';
import { type Detection, type RGBA, maxAreaQuad } from './imgproc';
import type { CV } from './opencv';

type Mat = InstanceType<CV['Mat']>;

const MIN_AREA = 0.1;      // 이미지 대비 최소 면적
const MIN_SUPPORT = 0.55;  // 네 변이 실제 경계와 겹치는 최소 비율

/**
 * 사각형 네 변을 따라 경계 픽셀이 있는 비율 (0~1).
 * 가장 약한 변도 반영해, 한 변이라도 허공에 뜬 사각형은 낮은 점수를 받음.
 */
export function edgeSupport(edges: Uint8Array, w: number, h: number, quad: Quad): number {
  const hit = (x: number, y: number) => {
    const cx = Math.round(x), cy = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px >= 0 && py >= 0 && px < w && py < h && edges[py * w + px]) return true;
      }
    }
    return false;
  };
  const sides: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const n = Math.max(16, Math.round(dist(a, b) / 2));
    let hits = 0, total = 0;
    // 모서리 부근은 둥글거나 손가락에 가려질 수 있어 제외
    for (let k = 0; k <= n; k++) {
      const t = 0.08 + 0.84 * (k / n);
      total++;
      if (hit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) hits++;
    }
    sides.push(hits / total);
  }
  const mean = sides.reduce((s, v) => s + v, 0) / 4;
  return 0.5 * mean + 0.5 * Math.min(...sides);
}

function matPoints(m: Mat): Point[] {
  const d = m.data32S, pts: Point[] = [];
  for (let i = 0; i + 1 < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

/** 채널별 Canny를 합친 경계 지도 (밝기가 비슷해도 색이 다르면 경계로 잡힘) */
function edgeMap(cv: CV, img: RGBA, track: (m: Mat) => Mat): Mat {
  const src = track(cv.matFromImageData(img as unknown as ImageData));
  const rgb = track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const blurred = track(new cv.Mat());
  cv.GaussianBlur(rgb, blurred, new cv.Size(5, 5), 0);
  const gray = track(new cv.Mat());
  cv.cvtColor(blurred, gray, cv.COLOR_RGB2GRAY);

  const channels = new cv.MatVector();
  cv.split(blurred, channels);
  const planes: Mat[] = [gray];
  for (let i = 0; i < channels.size(); i++) planes.push(track(channels.get(i)));
  channels.delete();

  const edges = track(cv.Mat.zeros(img.height, img.width, cv.CV_8UC1));
  const tmp = track(new cv.Mat());
  const e = track(new cv.Mat());
  for (const p of planes) {
    // Otsu 임계값을 기준으로 Canny 임계값 자동 설정
    const otsu = cv.threshold(p, tmp, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    const hi = Math.max(40, otsu), lo = Math.max(15, otsu * 0.4);
    cv.Canny(p, e, lo, hi);
    cv.bitwise_or(edges, e, edges);
  }
  // 경계선의 작은 틈을 메움
  const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  const closed = track(new cv.Mat());
  cv.dilate(edges, closed, kernel);
  return closed;
}

/**
 * 경계 기반 감지. extra로 다른 방법(영역 기반)의 후보를 넣으면 같은 기준으로 함께 채점.
 * 좌표는 입력 이미지 기준.
 */
export function detectByEdges(cv: CV, img: RGBA, extra: Quad[] = []): Detection | null {
  const mats: Mat[] = [];
  const track = (m: Mat) => (mats.push(m), m);
  try {
    const { width: w, height: h } = img;
    const edges = edgeMap(cv, img, track);
    const edgeData = edges.data as Uint8Array;

    const contours = new cv.MatVector();
    const hierarchy = track(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const candidates: Quad[] = [...extra];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      if (cv.contourArea(hull) >= MIN_AREA * w * h) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
        const pts = approx.rows === 4 ? matPoints(approx) : null;
        const quad = pts ? orderQuad(pts) : maxAreaQuad(matPoints(hull));
        if (quad) candidates.push(quad);
        approx.delete();
      }
      hull.delete();
      c.delete();
    }
    contours.delete();

    const minSide = 0.1 * Math.min(w, h);
    let best: Detection | null = null;
    for (const raw of candidates) {
      const quad = orderQuad(raw);
      if (!isConvex(quad)) continue;
      if (quad.some((p, i) => dist(p, quad[(i + 1) % 4]) < minSide)) continue;
      const areaFrac = Math.abs(polyArea(quad)) / (w * h);
      if (areaFrac < MIN_AREA) continue;
      const support = edgeSupport(edgeData, w, h, quad);
      if (support < MIN_SUPPORT) continue;
      // 경계 일치가 가장 중요하고, 같은 조건이면 큰 사각형(문서 외곽)을 선호
      const score = support * support * Math.sqrt(areaFrac);
      if (!best || score > best.score) best = { quad, score };
    }
    return best;
  } finally {
    mats.forEach(m => m.delete());
  }
}
