// 순수 이미지 처리 (RGBA 버퍼만 다룸 — 워커·테스트에서도 사용)
import {
  type Point, type Quad,
  dist, homography, polyArea,
} from './geometry';

export interface RGBA { data: Uint8ClampedArray; width: number; height: number }
/** 1채널 밝기 이미지 (흑백·스캔 보정용) */
export interface Gray { data: Uint8ClampedArray; width: number; height: number }

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

/**
 * quad 영역을 outW×outH 직사각형으로 펴기. 쌍삼차(Catmull-Rom) 보간이라 주변 4×4 픽셀을 써서
 * 이중선형보다 확대했을 때 글자 가장자리가 덜 뭉개짐. bpp=4면 RGBA, 1이면 밝기 1채널.
 * (픽셀마다 수천만 번 도는 부분이라 가중치·인덱스를 인라인으로 계산)
 */
function warpPixels(src: Uint8ClampedArray, cw: number, ch: number, bpp: 1 | 4, quad: Quad, outW: number, outH: number) {
  const H = homography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], quad);
  const out = new Uint8ClampedArray(outW * outH * bpp);
  const channels = bpp === 4 ? 3 : 1;
  const maxX = cw - 1, maxY = ch - 1, stride = cw * bpp;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    const V = v + 0.5;
    const ax = H[1] * V + H[2], ay = H[4] * V + H[5], ad = H[7] * V + 1; // 행 안에서 변하지 않는 항
    for (let u = 0; u < outW; u++, o += bpp) {
      const U = u + 0.5;
      const den = H[6] * U + ad;
      let x = (H[0] * U + ax) / den - 0.5;
      let y = (H[3] * U + ay) / den - 0.5;
      x = x < 0 ? 0 : x > maxX ? maxX : x;
      y = y < 0 ? 0 : y > maxY ? maxY : y;
      const xi = x | 0, yi = y | 0;
      const tx = x - xi, tx2 = tx * tx, tx3 = tx2 * tx;
      const ty = y - yi, ty2 = ty * ty, ty3 = ty2 * ty;
      const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx, wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
      const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx, wx3 = 0.5 * tx3 - 0.5 * tx2;
      const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty, wy1 = 1.5 * ty3 - 2.5 * ty2 + 1;
      const wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty, wy3 = 0.5 * ty3 - 0.5 * ty2;
      const c0 = (xi > 0 ? xi - 1 : 0) * bpp, c1 = xi * bpp;
      const c2 = (xi < maxX ? xi + 1 : maxX) * bpp, c3 = (xi + 2 <= maxX ? xi + 2 : maxX) * bpp;
      const r0 = (yi > 0 ? yi - 1 : 0) * stride, r1 = yi * stride;
      const r2 = (yi < maxY ? yi + 1 : maxY) * stride, r3 = (yi + 2 <= maxY ? yi + 2 : maxY) * stride;
      for (let c = 0; c < channels; c++) {
        const a = r0 + c, b = r1 + c, d = r2 + c, e = r3 + c;
        // Uint8ClampedArray가 반올림·범위 제한 (3차 보간의 오버슈트 처리)
        out[o + c] =
          wy0 * (wx0 * src[a + c0] + wx1 * src[a + c1] + wx2 * src[a + c2] + wx3 * src[a + c3]) +
          wy1 * (wx0 * src[b + c0] + wx1 * src[b + c1] + wx2 * src[b + c2] + wx3 * src[b + c3]) +
          wy2 * (wx0 * src[d + c0] + wx1 * src[d + c1] + wx2 * src[d + c2] + wx3 * src[d + c3]) +
          wy3 * (wx0 * src[e + c0] + wx1 * src[e + c1] + wx2 * src[e + c2] + wx3 * src[e + c3]);
      }
      if (bpp === 4) out[o + 3] = 255;
    }
  }
  return out;
}

export const warp = (img: RGBA, quad: Quad, outW: number, outH: number): RGBA =>
  ({ data: warpPixels(img.data, img.width, img.height, 4, quad, outW, outH), width: outW, height: outH });

export const warpGray = (img: Gray, quad: Quad, outW: number, outH: number): Gray =>
  ({ data: warpPixels(img.data, img.width, img.height, 1, quad, outW, outH), width: outW, height: outH });

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
