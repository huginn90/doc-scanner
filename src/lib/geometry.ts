// 좌표/사각형/출력 크기 계산 (DOM 없음 — 워커·테스트에서도 사용)

export interface Point { x: number; y: number }
export type Quad = [Point, Point, Point, Point];
export type Paper = 'a4' | 'auto';
export type FilterMode = 'original' | 'enhance' | 'gray' | 'bw';
export interface PageSettings { paper: Paper; filter: FilterMode; rot: number }

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function polyArea(q: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 좌상 → 우상 → 우하 → 좌하 순서로 정렬 (입력 순서 무관) */
export function orderQuad(q: readonly Point[]): Quad {
  const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
  const cy = q.reduce((s, p) => s + p.y, 0) / q.length;
  // 화면 좌표(y 아래)에서 각도 오름차순 = 시계 방향
  const pts = q.map(p => ({ x: p.x, y: p.y }))
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (pts[i].x + pts[i].y < pts[start].x + pts[start].y) start = i;
  }
  return pts.slice(start).concat(pts.slice(0, start)) as Quad;
}

export function isConvex(q: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export function defaultQuad(w: number, h: number, inset = 0.08): Quad {
  const dx = w * inset, dy = h * inset;
  return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
}

export const scaleQuad = (q: readonly Point[], sx: number, sy = sx) =>
  q.map(p => ({ x: p.x * sx, y: p.y * sy })) as Quad;

/** 시계 방향 k×90° 회전된 이미지의 좌표를 원본(w×h) 좌표로 되돌림 */
export function unrotatePoint(p: Point, k: number, w: number, h: number): Point {
  switch (((k % 4) + 4) % 4) {
    case 1: return { x: p.y, y: h - p.x };
    case 2: return { x: w - p.x, y: h - p.y };
    case 3: return { x: w - p.y, y: p.x };
    default: return { x: p.x, y: p.y };
  }
}

/** src 4점을 dst 4점으로 보내는 호모그래피 [h11..h32, 1] */
export function homography(src: readonly Point[], dst: readonly Point[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const div = A[col][col];
    if (Math.abs(div) < 1e-12) throw new Error('singular homography');
    for (let k = col; k < 9; k++) A[col][k] /= div;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
    }
  }
  return A.map(row => row[8]).concat(1);
}

export function applyHomography(H: readonly number[], p: Point): Point {
  const den = H[6] * p.x + H[7] * p.y + 1;
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / den, y: (H[3] * p.x + H[4] * p.y + H[5]) / den };
}

const A4_MM = { short: 210, long: 297 };
const A4_PT = { short: 595.28, long: 841.89 };

/** 원근 보정 출력 크기(px). A4는 가로/세로를 문서 모양으로 판단 */
export function outputSize(quad: Quad, paper: Paper, dpi: number) {
  const [tl, tr, br, bl] = quad;
  const wEst = (dist(tl, tr) + dist(bl, br)) / 2;
  const hEst = (dist(tl, bl) + dist(tr, br)) / 2;
  const longPx = Math.round(A4_MM.long / 25.4 * dpi);
  const shortPx = Math.round(A4_MM.short / 25.4 * dpi);
  const land = wEst > hEst;
  if (paper === 'a4') return land ? { w: longPx, h: shortPx } : { w: shortPx, h: longPx };
  const r = wEst / hEst;
  return land ? { w: longPx, h: Math.round(longPx / r) } : { w: Math.round(longPx * r), h: longPx };
}

/** PDF 페이지 크기(pt): A4는 정확히 A4, 원본 비율은 긴 변을 A4 긴 변에 맞춤 */
export function pageSizePt(w: number, h: number, paper: Paper): [number, number] {
  const land = w > h;
  if (paper === 'a4') return land ? [A4_PT.long, A4_PT.short] : [A4_PT.short, A4_PT.long];
  return land ? [A4_PT.long, A4_PT.long * h / w] : [A4_PT.long * w / h, A4_PT.long];
}
