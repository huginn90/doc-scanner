// 순수 이미지 처리 (RGBA 버퍼만 다룸 — 워커·테스트에서도 사용)
import {
  type FilterMode, type Point, type Quad,
  dist, homography, polyArea,
} from './geometry';

export interface RGBA { data: Uint8ClampedArray; width: number; height: number }

export const createRGBA = (width: number, height: number): RGBA =>
  ({ data: new Uint8ClampedArray(width * height * 4), width, height });

export const cloneRGBA = (img: RGBA): RGBA =>
  ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

/** 시계 방향으로 k×90° 회전한 새 이미지 */
export function rotateRGBA(img: RGBA, k: number): RGBA {
  k = ((k % 4) + 4) % 4;
  if (!k) return cloneRGBA(img);
  const { width: w, height: h, data: s } = img;
  const out = k === 2 ? createRGBA(w, h) : createRGBA(h, w);
  const o32 = new Uint32Array(out.data.buffer), s32 = new Uint32Array(s.buffer, s.byteOffset, w * h);
  const ow = out.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = s32[y * w + x];
      if (k === 1) o32[x * ow + (h - 1 - y)] = v;
      else if (k === 2) o32[(h - 1 - y) * ow + (w - 1 - x)] = v;
      else o32[(w - 1 - x) * ow + y] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 기본 연산

/** 분리형 박스 블러 (running sum), in-place */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return src;
}

export function otsu(values: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.max(0, values[i] | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** 정사각 구조요소 min/max 필터 (분리형), mask: 0/1 */
function morph(mask: Uint8Array, w: number, h: number, r: number, isMax: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pick = isMax ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - pick;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (mask[y * w + k] === pick) { v = pick; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - pick;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === pick) { v = pick; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 가장 큰 연결 영역: 행별 좌/우 끝점과 (구멍을 메운) 면적 */
function largestComponent(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0, bestArea = 0, label = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    label++;
    let sp = 0, area = 0;
    stack[sp++] = s;
    labels[s] = label;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    if (area > bestArea) { bestArea = area; bestLabel = label; }
  }
  if (!bestLabel) return null;
  const points: Point[] = [];
  let spanArea = 0;
  for (let y = 0; y < h; y++) {
    let minX = -1, maxX = -1;
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] === bestLabel) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    if (minX >= 0) {
      points.push({ x: minX, y }, { x: maxX + 1, y }, { x: minX, y: y + 1 }, { x: maxX + 1, y: y + 1 });
      spanArea += maxX - minX + 1;
    }
  }
  return { points, area: spanArea };
}

export function convexHull(pts: readonly Point[]): Point[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

const triArea = (a: Point, b: Point, c: Point) =>
  Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;

/** 볼록 다각형에 내접하는 최대 면적 사각형 (대각선 고정 후 양쪽 최원점) */
export function maxAreaQuad(hull: readonly Point[]): Quad | null {
  const n = hull.length;
  if (n < 4) return null;
  let best = 0;
  let quad: Quad | null = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      let a1 = 0, j1 = -1;
      for (let j = i + 1; j < k; j++) {
        const a = triArea(hull[i], hull[j], hull[k]);
        if (a > a1) { a1 = a; j1 = j; }
      }
      let a2 = 0, j2 = -1;
      for (let j = k + 1; j < n + i; j++) {
        const a = triArea(hull[i], hull[j % n], hull[k]);
        if (a > a2) { a2 = a; j2 = j % n; }
      }
      if (j1 >= 0 && j2 >= 0 && a1 + a2 > best) {
        best = a1 + a2;
        quad = [hull[i], hull[j1], hull[k], hull[j2]];
      }
    }
  }
  return quad;
}

// ---------------------------------------------------------------- 문서 감지

export interface Detection { quad: Quad; score: number }

/**
 * 밝기/종이다움(최소 채널) 마스크에서 가장 큰 영역을 찾아 사각형으로 근사.
 * 입력은 긴 변 ~480px로 줄인 이미지를 권장. 좌표는 입력 이미지 기준.
 */
export function detectByRegion(img: RGBA): Detection | null {
  const { data: d, width: w, height: h } = img;
  const n = w * h;
  const lum = new Float32Array(n), minc = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    minc[i] = Math.min(r, g, b); // 밝고 채도 낮음 = 종이다움
  }
  boxBlur(lum, w, h, 2);
  boxBlur(minc, w, h, 2);

  let best: Detection | null = null;
  for (const feat of [lum, minc]) {
    const t = otsu(feat);
    for (const invert of [false, true]) {
      let mask: Uint8Array = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = (feat[i] > t) !== invert ? 1 : 0;
      // 열림 연산: 문서와 배경 사이의 가는 연결을 끊음
      mask = morph(morph(mask, w, h, 2, false), w, h, 2, true);
      const comp = largestComponent(mask, w, h);
      if (!comp || comp.area < n * 0.08) continue;
      const hull = convexHull(comp.points);
      const quad = maxAreaQuad(hull);
      if (!quad) continue;
      const qa = Math.abs(polyArea(quad));
      const frac = qa / n;
      const fill = Math.min(1, comp.area / qa);
      const hullFill = comp.area / Math.abs(polyArea(hull));
      let score = frac * Math.pow(fill, 4) * Math.pow(hullFill, 2);
      if (frac > 0.93) score *= 0.15; // 사진 전체 = 배경일 가능성
      if (invert) score *= 0.8;
      if (!best || score > best.score) best = { score, quad };
    }
  }
  return best && best.score >= 0.05 ? best : null;
}

// ---------------------------------------------------------------- 원근 보정

/** img 안의 quad 영역을 outW×outH 직사각형으로 펴기 (이중선형 보간) */
export function warp(img: RGBA, quad: Quad, outW: number, outH: number): RGBA {
  const { data: sd, width: cw, height: ch } = img;
  const H = homography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], quad);
  const out = createRGBA(outW, outH);
  const od = out.data;
  const maxX = cw - 1.001, maxY = ch - 1.001, stride = cw * 4;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    const V = v + 0.5;
    for (let u = 0; u < outW; u++, o += 4) {
      const U = u + 0.5;
      const den = H[6] * U + H[7] * V + 1;
      let x = (H[0] * U + H[1] * V + H[2]) / den - 0.5;
      let y = (H[3] * U + H[4] * V + H[5]) / den - 0.5;
      x = x < 0 ? 0 : x > maxX ? maxX : x;
      y = y < 0 ? 0 : y > maxY ? maxY : y;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = y0 * stride + x0 * 4, i10 = i00 + 4, i01 = i00 + stride, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        od[o + c] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

/** 원본에서 잘라낼 영역과 축소 비율 (원본이 출력보다 훨씬 크면 미리 줄여 계단 현상 방지) */
export function warpSourceRegion(quad: Quad, srcW: number, srcH: number, outW: number, outH: number) {
  const [tl, tr, br, bl] = quad;
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const w = Math.max(2, Math.min(srcW, Math.ceil(Math.max(...xs)) + 2) - x);
  const h = Math.max(2, Math.min(srcH, Math.ceil(Math.max(...ys)) + 2) - y);
  const sideW = Math.max(dist(tl, tr), dist(bl, br));
  const sideH = Math.max(dist(tl, bl), dist(tr, br));
  // 출력보다 약간(1.15배) 크게만 남겨 화질은 유지하면서 메모리 사용을 줄임
  const scale = Math.min(1, 1.15 * Math.max(outW / sideW, outH / sideH));
  return { x, y, w, h, scale };
}

// ---------------------------------------------------------------- 스캔 필터

type ChannelFn = (d: Uint8ClampedArray, j: number) => number;
const lumOf: ChannelFn = (d, j) => 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

/** 종이 배경(조명/그림자) 추정: 블록 최대값 → 팽창 → 하한 → 블러 → 저해상도 격자 */
function backgroundGrid(d: Uint8ClampedArray, w: number, h: number, channels: ChannelFn[]) {
  const block = Math.max(4, Math.round(Math.max(w, h) / 100));
  const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
  const grids = channels.map(() => new Float32Array(gw * gh));
  for (let y = 0; y < h; y++) {
    const gy = ((y / block) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const gi = gy + ((x / block) | 0), j = (y * w + x) * 4;
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c](d, j);
        if (v > grids[c][gi]) grids[c][gi] = v;
      }
    }
  }
  for (let c = 0; c < grids.length; c++) {
    const g = grids[c];
    // 3x3 팽창: 굵은 글자/선을 배경으로 오인하지 않도록
    const dil = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let m = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++)
            if (g[yy * gw + xx] > m) m = g[yy * gw + xx];
        dil[y * gw + x] = m;
      }
    }
    // 사진 등 넓은 어두운 영역이 하얗게 날아가지 않도록 하한
    const sorted = Float32Array.from(dil).sort();
    const paper = sorted[Math.floor(sorted.length * 0.9)] || 255;
    const floor = Math.max(1, paper * 0.55);
    for (let i = 0; i < dil.length; i++) if (dil[i] < floor) dil[i] = floor;
    boxBlur(dil, gw, gh, 2);
    boxBlur(dil, gw, gh, 2);
    grids[c] = dil;
  }
  return { grids, block, gw, gh };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const stretch = (lo: number, hi: number, gamma: number) => (v: number) =>
  Math.pow(clamp01((v - lo) / (hi - lo)), gamma);
const smoothstep = (a: number, b: number) => (v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 인덱스 = (값/배경) × 1024, 1.25배까지 */
function makeLut(fn: (v: number) => number) {
  const lut = new Uint8ClampedArray(1281);
  for (let k = 0; k <= 1280; k++) lut[k] = Math.round(255 * fn(k / 1024));
  return lut;
}

const CURVES: Record<Exclude<FilterMode, 'original'>, () => (v: number) => number> = {
  enhance: () => stretch(0.1, 0.9, 1.15),
  gray: () => stretch(0.12, 0.88, 1.3),
  bw: () => smoothstep(0.62, 0.78),
};

/** 조명 보정 + 톤 커브 (in-place) */
export function applyFilter(img: RGBA, mode: FilterMode): RGBA {
  if (mode === 'original') return img;
  const { data: d, width: w, height: h } = img;
  const perChannel = mode === 'enhance';
  const channels: ChannelFn[] = perChannel
    ? [(d, j) => d[j], (d, j) => d[j + 1], (d, j) => d[j + 2]]
    : [lumOf];
  const { grids, block, gw, gh } = backgroundGrid(d, w, h, channels);
  const lut = makeLut(CURVES[mode]());

  // 격자 → 픽셀 이중선형 보간 좌표 미리 계산
  const x0s = new Int32Array(w), x1s = new Int32Array(w), fxs = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const g = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
    x0s[x] = g | 0; x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = g - x0s[x];
  }
  for (let y = 0; y < h; y++) {
    const g = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = (g | 0) * gw, y1 = Math.min(gh - 1, (g | 0) + 1) * gw, fy = g - (g | 0);
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, a = x0s[x], b = x1s[x], fx = fxs[x];
      if (perChannel) {
        for (let c = 0; c < 3; c++) {
          const G = grids[c];
          const top = G[y0 + a] + (G[y0 + b] - G[y0 + a]) * fx;
          const bot = G[y1 + a] + (G[y1 + b] - G[y1 + a]) * fx;
          d[j + c] = lut[Math.min(1280, (d[j + c] * 1024 / (top + (bot - top) * fy)) | 0)];
        }
      } else {
        const G = grids[0];
        const top = G[y0 + a] + (G[y0 + b] - G[y0 + a]) * fx;
        const bot = G[y1 + a] + (G[y1 + b] - G[y1 + a]) * fx;
        const v = lut[Math.min(1280, (lumOf(d, j) * 1024 / (top + (bot - top) * fy)) | 0)];
        d[j] = d[j + 1] = d[j + 2] = v;
      }
    }
  }
  return img;
}
