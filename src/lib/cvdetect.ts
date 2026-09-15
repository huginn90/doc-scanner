// OpenCV 기반 문서 감지
//  1) 잡티(털·질감)를 줄이고 채널별 Canny로 경계 지도 + 색 기울기 방향 계산
//  2) 후보 사각형: 직선(Hough) 조합 + 윤곽선 근사 + 외부 후보(영역 기반)
//  3) 채점: 네 변을 따라 "방향이 맞는" 경계가 있는 비율 × 면적 × A4 비율 선호
//  4) 최종 사각형의 각 변을 경계 픽셀에 직선 맞춤해 모서리를 정밀하게 보정
import { type Point, type Quad, dist, isConvex, orderQuad, polyArea } from './geometry';
import { type Detection, type RGBA, maxAreaQuad } from './imgproc';
import type { CV } from './opencv';

type Mat = InstanceType<CV['Mat']>;

/** 경계 픽셀과 그 위치의 기울기(경계에 수직 방향) */
export interface EdgeField { w: number; h: number; edges: Uint8Array; gx: Float32Array; gy: Float32Array }

/** 법선 형태 직선: nx·x + ny·y = rho, theta ∈ [0, π) 는 직선 방향. a/b는 대표 선분 끝점 */
interface Line { nx: number; ny: number; rho: number; theta: number; len: number; a?: Point; b?: Point }

const MIN_AREA = 0.1;        // 이미지 대비 최소 면적
const MIN_SUPPORT = 0.5;     // 네 변이 실제 경계와 겹치는 최소 점수
const ALIGN_COS = 0.85;      // 경계 방향이 변과 ~30° 이내로 맞아야 인정
const A4_RATIO = Math.SQRT2;
const MAX_LINES = 20;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 채점

/** 한 변을 따라, 변과 같은 방향의 경계 픽셀이 (법선 ±3px 안에) 있는 비율 */
function sideSupport(f: EdgeField, a: Point, b: Point): number {
  const len = dist(a, b);
  if (len < 1) return 0;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const n = Math.max(12, Math.round(len / 2));
  let hits = 0;
  for (let k = 0; k <= n; k++) {
    // 모서리 부근은 둥글거나 손가락에 가려질 수 있어 제외
    const t = 0.06 + 0.88 * (k / n);
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    for (let o = -3; o <= 3; o++) {
      const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const i = y * f.w + x;
      if (!f.edges[i]) continue;
      const gx = f.gx[i], gy = f.gy[i];
      if (Math.abs(gx * nx + gy * ny) >= ALIGN_COS * Math.hypot(gx, gy)) { hits++; break; }
    }
  }
  return hits / (n + 1);
}

/** 네 변 평균과 가장 약한 변을 함께 반영 — 한 변이라도 허공에 뜨면 낮은 점수 */
export function quadSupport(f: EdgeField, q: Quad): number {
  const s = q.map((a, i) => sideSupport(f, a, q[(i + 1) % 4]));
  return 0.5 * (s[0] + s[1] + s[2] + s[3]) / 4 + 0.5 * Math.min(...s);
}

/** A4(1:1.414)에 가까울수록 1, 멀어도 0.6까지만 깎음 (책·영수증 등도 인식되도록) */
export function aspectFactor(q: Quad): number {
  const [tl, tr, br, bl] = q;
  const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2;
  const r = Math.max(w, h) / Math.max(1, Math.min(w, h));
  // 비스듬히 찍으면 겉보기 비율이 1.2~1.7까지 변하므로 그 범위는 크게 깎지 않음
  const z = Math.log(r / A4_RATIO) / 0.2;
  return 0.6 + 0.4 * Math.exp(-z * z / 2);
}

// ---------------------------------------------------------------- 경계 지도

function buildField(cv: CV, img: RGBA, track: (m: Mat) => Mat): { field: EdgeField; edgesMat: Mat } {
  const { width: w, height: h } = img;
  const src = track(cv.matFromImageData(img as unknown as ImageData));
  const rgb = track(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  // 중앙값 필터: 털·종이 질감 같은 가는 잡티는 지우고 문서 외곽 같은 계단형 경계는 유지
  const median = track(new cv.Mat());
  cv.medianBlur(rgb, median, 5);
  const smooth = track(new cv.Mat());
  cv.GaussianBlur(median, smooth, new cv.Size(3, 3), 0);
  const gray = track(new cv.Mat());
  cv.cvtColor(smooth, gray, cv.COLOR_RGB2GRAY);

  // 채널별 Canny 합치기: 밝기가 비슷해도 색이 다르면(민트 표지 vs 피부) 경계로 잡힘
  const channels = new cv.MatVector();
  cv.split(smooth, channels);
  const planes: Mat[] = [gray];
  for (let i = 0; i < channels.size(); i++) planes.push(track(channels.get(i)));
  channels.delete();
  const edges = track(cv.Mat.zeros(h, w, cv.CV_8UC1));
  const e = track(new cv.Mat());
  for (const p of planes) {
    cv.Canny(p, e, 20, 60, 3, true);
    cv.bitwise_or(edges, e, edges);
  }

  // 색 기울기: 픽셀마다 R/G/B 중 변화가 가장 큰 채널의 Sobel 방향
  const d = smooth.data as Uint8Array;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1, bx = 0, by = 0;
      for (let c = 0; c < 3; c++) {
        const tl = d[(i - w - 1) * 3 + c], t = d[(i - w) * 3 + c], tr = d[(i - w + 1) * 3 + c];
        const l = d[(i - 1) * 3 + c], r = d[(i + 1) * 3 + c];
        const bl = d[(i + w - 1) * 3 + c], b = d[(i + w) * 3 + c], br = d[(i + w + 1) * 3 + c];
        const sx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const sy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        const m = sx * sx + sy * sy;
        if (m > best) { best = m; bx = sx; by = sy; }
      }
      gx[i] = bx;
      gy[i] = by;
    }
  }
  return { field: { w, h, edges: new Uint8Array(edges.data), gx, gy }, edgesMat: edges };
}

// ---------------------------------------------------------------- 후보: 직선 조합

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

function lineFrom(x1: number, y1: number, x2: number, y2: number, len: number): Line {
  let theta = Math.atan2(y2 - y1, x2 - x1);
  if (theta < 0) theta += Math.PI;
  if (theta >= Math.PI) theta -= Math.PI;
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  return { nx, ny, rho: nx * x1 + ny * y1, theta, len };
}

function intersect(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
}

/**
 * 선분 검출 후 같은 직선끼리 묶어 "방향이 맞는 길이" 합이 긴 순으로.
 * 털·질감처럼 경계 방향이 제각각인 곳을 지나는 가짜 직선은 걸러냄.
 */
function houghLines(cv: CV, edges: Mat, f: EdgeField, track: (m: Mat) => Mat): Line[] {
  const m = Math.min(f.w, f.h);
  const segs = track(new cv.Mat());
  cv.HoughLinesP(edges, segs, 1, DEG, Math.round(m * 0.08), m * 0.1, m * 0.04);
  const d = segs.data32S;
  const lines: Line[] = [];
  for (let i = 0; i + 3 < d.length; i += 4) {
    const a = { x: d[i], y: d[i + 1] }, b = { x: d[i + 2], y: d[i + 3] };
    const aligned = sideSupport(f, a, b);
    if (aligned < 0.6) continue;
    lines.push({ ...lineFrom(a.x, a.y, b.x, b.y, dist(a, b) * aligned * aligned), a, b });
  }
  lines.sort((a, b) => b.len - a.len);

  const merged: Line[] = [];
  for (const s of lines) {
    const same = merged.find(c => {
      if (angleDiff(c.theta, s.theta) > 4 * DEG) return false;
      // theta가 0/π 경계를 넘으면 법선 방향이 뒤집혀 rho 부호가 바뀜
      const flip = Math.abs(c.theta - s.theta) > Math.PI / 2;
      return Math.abs(c.rho - (flip ? -s.rho : s.rho)) < m * 0.015;
    });
    if (same) same.len += s.len;
    else merged.push({ ...s });
  }
  return merged.sort((a, b) => b.len - a.len).slice(0, MAX_LINES).map(l => refineLine(f, l));
}

const project = (l: Line, p: Point): Point => {
  const d = l.nx * p.x + l.ny * p.y - l.rho;
  return { x: p.x - d * l.nx, y: p.y - d * l.ny };
};

/** Hough 직선은 몇 px 어긋나므로 실제 경계 픽셀에 두 번 맞춰 정밀화 */
function refineLine(f: EdgeField, l: Line): Line {
  if (!l.a || !l.b) return l;
  let cur = l;
  for (let k = 0; k < 2; k++) {
    const fit = fitSide(f, project(cur, l.a), project(cur, l.b));
    if (!fit) break;
    cur = { ...fit, len: l.len, a: l.a, b: l.b };
  }
  return cur;
}

/** 대략 평행한 직선 두 쌍으로 사각형 만들기 (원근 때문에 최대 35°까지 기울어짐 허용) */
function lineQuads(lines: Line[], w: number, h: number): Quad[] {
  const pairs: [Line, Line][] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (angleDiff(lines[i].theta, lines[j].theta) < 35 * DEG) pairs.push([lines[i], lines[j]]);

  const mx = w * 0.03, my = h * 0.03;
  const quads: Quad[] = [];
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const [a, b] = pairs[p], [c, d] = pairs[q];
      if (a === c || a === d || b === c || b === d) continue;
      if (angleDiff(a.theta, c.theta) < 45 * DEG || angleDiff(b.theta, d.theta) < 45 * DEG) continue;
      const pts = [intersect(a, c), intersect(c, b), intersect(b, d), intersect(d, a)];
      if (pts.some(pt => !pt || pt.x < -mx || pt.y < -my || pt.x > w + mx || pt.y > h + my)) continue;
      quads.push(orderQuad((pts as Point[]).map(pt => ({
        x: Math.min(w, Math.max(0, pt.x)), y: Math.min(h, Math.max(0, pt.y)),
      }))));
    }
  }
  return quads;
}

// ---------------------------------------------------------------- 후보: 윤곽선

function contourQuads(cv: CV, edges: Mat, w: number, h: number, track: (m: Mat) => Mat): Quad[] {
  const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  const closed = track(new cv.Mat());
  cv.dilate(edges, closed, kernel);
  const contours = new cv.MatVector();
  const hierarchy = track(new cv.Mat());
  cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const matPoints = (m: Mat): Point[] => {
    const d = m.data32S, pts: Point[] = [];
    for (let i = 0; i + 1 < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
    return pts;
  };
  const quads: Quad[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const hull = new cv.Mat();
    cv.convexHull(c, hull, false, true);
    if (cv.contourArea(hull) >= MIN_AREA * w * h) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
      const quad = approx.rows === 4 ? orderQuad(matPoints(approx)) : maxAreaQuad(matPoints(hull));
      if (quad) quads.push(quad);
      approx.delete();
    }
    hull.delete();
    c.delete();
  }
  contours.delete();
  return quads;
}

// ---------------------------------------------------------------- 모서리 정밀 보정

/** 변 주변(±3px)의 방향이 맞는 경계 픽셀에 직선 맞춤 (주성분 분석) */
function fitSide(f: EdgeField, a: Point, b: Point): Line | null {
  const len = dist(a, b);
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const xs: number[] = [], ys: number[] = [];
  for (let k = 0, n = Math.round(len); k <= n; k++) {
    const t = 0.06 + 0.88 * (k / n);
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    for (let o = -3; o <= 3; o++) {
      const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const i = y * f.w + x;
      if (!f.edges[i]) continue;
      const gx = f.gx[i], gy = f.gy[i];
      if (Math.abs(gx * nx + gy * ny) >= ALIGN_COS * Math.hypot(gx, gy)) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < Math.max(10, len * 0.3)) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return lineFrom(mx, my, mx + Math.cos(phi), my + Math.sin(phi), len);
}

function refineQuad(f: EdgeField, q: Quad): Quad {
  const sides = q.map((a, i) => {
    const b = q[(i + 1) % 4];
    return fitSide(f, a, b) ?? lineFrom(a.x, a.y, b.x, b.y, dist(a, b));
  });
  const limit = 0.03 * Math.hypot(f.w, f.h);
  return q.map((p, i) => {
    const c = intersect(sides[(i + 3) % 4], sides[i]);
    return c && dist(c, p) < limit
      ? { x: Math.min(f.w, Math.max(0, c.x)), y: Math.min(f.h, Math.max(0, c.y)) }
      : p;
  }) as Quad;
}

// ---------------------------------------------------------------- 감지

/** 테스트·디버그용: 주어진 사각형들의 채점 요소 */
export function inspectQuads(cv: CV, img: RGBA, quads: Quad[]) {
  const mats: Mat[] = [];
  const track = (m: Mat) => (mats.push(m), m);
  try {
    const { field, edgesMat } = buildField(cv, img, track);
    const lines = houghLines(cv, edgesMat, field, track);
    const lq = lineQuads(lines, img.width, img.height);
    const target = orderQuad(quads[0]);
    const err = (q: Quad) => Math.max(...q.map((p, i) => dist(p, target[i])));
    const nearest = lq.reduce<Quad | null>((b, q) => (!b || err(q) < err(b) ? q : b), null);
    return {
      lines: lines.map(l => ({ deg: +(l.theta / DEG).toFixed(1), rho: Math.round(l.rho), len: Math.round(l.len) })),
      lineQuads: lq.length,
      nearestLineQuadErr: nearest ? +err(nearest).toFixed(1) : null,
      quads: quads.map(q => {
        const quad = orderQuad(q);
        const s = quad.map((a, i) => sideSupport(field, a, quad[(i + 1) % 4]));
        return {
          sides: s.map(v => +v.toFixed(2)),
          support: +quadSupport(field, quad).toFixed(3),
          area: +(Math.abs(polyArea(quad)) / (img.width * img.height)).toFixed(3),
          aspect: +aspectFactor(quad).toFixed(3),
        };
      }),
    };
  } finally {
    mats.forEach(m => m.delete());
  }
}

/**
 * 경계 기반 감지. extra로 다른 방법(영역 기반)의 후보를 넣으면 같은 기준으로 함께 채점.
 * 좌표는 입력 이미지 기준. 믿을 만한 사각형이 없으면 null.
 */
export function detectByEdges(cv: CV, img: RGBA, extra: Quad[] = []): Detection | null {
  const mats: Mat[] = [];
  const track = (m: Mat) => (mats.push(m), m);
  try {
    const { width: w, height: h } = img;
    const { field, edgesMat } = buildField(cv, img, track);
    const candidates = [
      ...extra.map(q => orderQuad(q)),
      ...contourQuads(cv, edgesMat, w, h, track),
      ...lineQuads(houghLines(cv, edgesMat, field, track), w, h),
    ];

    const minSide = 0.1 * Math.min(w, h);
    const score = (quad: Quad) => {
      if (!isConvex(quad)) return -1;
      if (quad.some((p, i) => dist(p, quad[(i + 1) % 4]) < minSide)) return -1;
      const areaFrac = Math.abs(polyArea(quad)) / (w * h);
      if (areaFrac < MIN_AREA) return -1;
      const support = quadSupport(field, quad);
      if (support < MIN_SUPPORT) return -1;
      // 경계 일치가 가장 중요하고, 비슷하면 큰 사각형(양식 안쪽 표가 아닌 종이 외곽)과 A4 비율 선호
      return support * support * Math.sqrt(areaFrac) * aspectFactor(quad);
    };

    let best: Detection | null = null;
    for (const quad of candidates) {
      const s = score(quad);
      if (s > 0 && (!best || s > best.score)) best = { quad, score: s };
    }
    if (!best) return null;

    const refined = orderQuad(refineQuad(field, best.quad));
    const rs = score(refined);
    return rs >= best.score * 0.97 ? { quad: refined, score: rs } : best;
  } finally {
    mats.forEach(m => m.delete());
  }
}
