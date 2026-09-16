// 보정 필터 (DOM 없음 — 테스트에서도 사용)
//  - 흑백: 조명 보정 → 부분 대비 강화 → 선명화 → 톤 정리
//  - 스캔: 조명 보정 → 선명화 → 적응형 이진화(Sauvola) → 굵은 글씨 채움 → 점 잡티 제거
import { type Gray, type RGBA, boxBlur } from './imgproc';

/** 파라미터 기준 해상도: 200dpi A4 긴 변. 다른 해상도에서는 반경 등을 비례 조정 */
const REF_LONG = 2339;
const scaleOf = (g: Gray) => Math.max(g.width, g.height) / REF_LONG;

export function luminance(img: RGBA): Gray {
  const n = img.width * img.height, d = img.data, out = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return { data: out, width: img.width, height: img.height };
}

export function grayToRGBA(g: Gray): RGBA {
  const n = g.width * g.height, out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.data[i];
    out[j + 3] = 255;
  }
  return { data: out, width: g.width, height: g.height };
}

/** 분리형 박스 블러 (8비트, 가장자리 복제) */
export function blur8(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(w * h), out = new Uint8ClampedArray(w * h);
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
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** 언샤프 마스크 (in-place): 흐린 사본과의 차이를 amount만큼 더함 */
export function unsharp(g: Gray, radius: number, amount: number): Gray {
  const b = blur8(g.data, g.width, g.height, radius), d = g.data;
  for (let i = 0; i < d.length; i++) d[i] = d[i] + amount * (d[i] - b[i]);
  return g;
}

/** 저해상도 격자(블록 크기 block)를 픽셀 위치로 이중선형 보간하기 위한 좌표표 */
function gridLookup(n: number, block: number, gn: number) {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const g = Math.min(gn - 1, Math.max(0, (x + 0.5) / block - 0.5));
    i0[x] = g | 0;
    i1[x] = Math.min(gn - 1, i0[x] + 1);
    f[x] = g - i0[x];
  }
  return { i0, i1, f };
}

/**
 * 조명 보정 (in-place): 종이 밝기를 추정해 나눔 → 그림자·누런 조명이 사라지고 종이 ≈ 255.
 * 종이 추정: 블록 최대값 → 3×3 팽창(굵은 글자 무시) → 하한(넓은 사진이 하얗게 날아가지 않게) → 블러
 */
export function normalizeIllumination(g: Gray): Gray {
  const { data: d, width: w, height: h } = g;
  const block = Math.max(4, Math.round(Math.max(w, h) / 100));
  const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
  const grid = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = ((y / block) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const gi = gy + ((x / block) | 0), v = d[y * w + x];
      if (v > grid[gi]) grid[gi] = v;
    }
  }
  const bg = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++)
          if (grid[yy * gw + xx] > m) m = grid[yy * gw + xx];
      bg[y * gw + x] = m;
    }
  }
  const sorted = Float32Array.from(bg).sort();
  const floor = Math.max(1, (sorted[Math.floor(sorted.length * 0.9)] || 255) * 0.55);
  for (let i = 0; i < bg.length; i++) if (bg[i] < floor) bg[i] = floor;
  boxBlur(bg, gw, gh, 2);
  boxBlur(bg, gw, gh, 2);

  const X = gridLookup(w, block, gw), Y = gridLookup(h, block, gh);
  const row = new Float32Array(gw);
  for (let y = 0; y < h; y++) {
    const r0 = Y.i0[y] * gw, r1 = Y.i1[y] * gw, fy = Y.f[y];
    for (let gx = 0; gx < gw; gx++) row[gx] = bg[r0 + gx] + (bg[r1 + gx] - bg[r0 + gx]) * fy;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const a = X.i0[x];
      d[base + x] = d[base + x] * 255 / (row[a] + (row[X.i1[x]] - row[a]) * X.f[x]);
    }
  }
  return g;
}

/** 흑백 (in-place) */
export function grayDocument(g: Gray): Gray {
  normalizeIllumination(g);
  const s = scaleOf(g);
  unsharp(g, Math.max(6, Math.round(40 * s)), 0.35); // 부분 대비: 넓은 범위에서 글자와 종이의 차이를 키움
  unsharp(g, Math.max(1, Math.round(1.5 * s)), 0.7); // 선명화: 글자 가장자리
  // 톤: 종이는 흰색으로, 글자는 더 진하게
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(Math.min(1, Math.max(0, (v - 20) / 215)), 1.25);
  const d = g.data;
  for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
  whitenBorder(g, Math.round(0.008 * Math.max(g.width, g.height))); // 약 2mm
  return g;
}

/** Sauvola 민감도: 작을수록 연한 글씨까지 검정으로 잡음 */
const SAUVOLA_K = 0.1;

/**
 * 스캔 (in-place, 결과는 0 또는 255).
 * 전체 공통 기준 대신 주변(약 6mm 창)의 평균·표준편차와 비교하는 적응형 이진화라
 * 종이보다 살짝만 어두운 연한 글씨·가는 선도 남음.
 */
export function scanDocument(g: Gray): Gray {
  normalizeIllumination(g);
  const { data: d, width: w, height: h } = g;
  const s = scaleOf(g);
  unsharp(g, Math.max(1, Math.round(2 * s)), 1.0);

  // 창 안 평균·제곱평균: 1/4 해상도 격자에서 계산해 메모리 절약 (창 ≈ 51px @200dpi)
  const f = 4, sw = Math.ceil(w / f), sh = Math.ceil(h / f);
  const m1 = new Float32Array(sw * sh), m2 = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = ((y / f) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const si = sy + ((x / f) | 0), v = d[y * w + x];
      m1[si] += v; m2[si] += v * v; cnt[si]++;
    }
  }
  for (let i = 0; i < m1.length; i++) { m1[i] /= cnt[i]; m2[i] /= cnt[i]; }
  const r = Math.max(2, Math.round(25 * s / f));
  boxBlur(m1, sw, sh, r);
  boxBlur(m2, sw, sh, r);

  const out = new Uint8ClampedArray(w * h);
  const X = gridLookup(w, f, sw), Y = gridLookup(h, f, sh);
  const row1 = new Float32Array(sw), row2 = new Float32Array(sw);
  for (let y = 0; y < h; y++) {
    // 격자를 먼저 세로로 보간해 한 행으로 만든 뒤 가로로 보간
    const r0 = Y.i0[y] * sw, r1 = Y.i1[y] * sw, fy = Y.f[y];
    for (let gx = 0; gx < sw; gx++) {
      row1[gx] = m1[r0 + gx] + (m1[r1 + gx] - m1[r0 + gx]) * fy;
      row2[gx] = m2[r0 + gx] + (m2[r1 + gx] - m2[r0 + gx]) * fy;
    }
    for (let x = 0; x < w; x++) {
      const a = X.i0[x], b = X.i1[x], fx = X.f[x];
      const m = row1[a] + (row1[b] - row1[a]) * fx, mm = row2[a] + (row2[b] - row2[a]) * fx;
      const sd = Math.sqrt(Math.max(0, mm - m * m));
      const T = m * (1 + SAUVOLA_K * (sd / 128 - 1));
      const v = d[y * w + x];
      // 굵은 글씨 안쪽(주변이 대부분 어두움)은 반사로 밝아진 곳도 채움 — 종이만큼 밝아야 흰색
      const ink = v < T || v < 110 || (m < 140 && v < 200);
      out[y * w + x] = ink ? 0 : 255;
    }
  }
  despeckle(out, w, h);
  clearBorder(out, w, h, Math.round(0.02 * Math.max(w, h)));
  d.set(out);
  return g;
}

/**
 * 가장자리 정리(스캔): 페이지 테두리에 닿은 검정 영역을 테두리에서 band px 안쪽까지만 지움.
 * 사각형이 문서보다 살짝 바깥(책상)까지 잡혀 생기는 검은 띠를 없애고,
 * 테두리에 닿지 않은 가장자리 근처 글씨는 그대로 둠
 */
function clearBorder(bin: Uint8ClampedArray, w: number, h: number, band: number) {
  const stack: number[] = [];
  const visit = (i: number) => {
    if (bin[i] === 0) { bin[i] = 255; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i / w) | 0;
    const near = (nx: number, ny: number) =>
      nx >= 0 && ny >= 0 && nx < w && ny < h &&
      (nx < band || ny < band || nx >= w - band || ny >= h - band);
    if (near(x - 1, y)) visit(i - 1);
    if (near(x + 1, y)) visit(i + 1);
    if (near(x, y - 1)) visit(i - w);
    if (near(x, y + 1)) visit(i + w);
  }
}

/** 가장자리 정리(흑백): 테두리 band px를 종이색으로 */
function whitenBorder(g: Gray, band: number) {
  const { data: d, width: w, height: h } = g;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (edgeRow || x < band || x >= w - band) d[y * w + x] = 255;
    }
  }
}

/**
 * 외톨이 점 제거·바늘구멍 메우기: 3×3 이웃 다수결 (0/255 이진 이미지, in-place).
 * 행마다 가로 3칸 검정 수를 한 번만 세고 위·가운데·아래 행을 더함 — 각 행의 합은
 * 그 행을 고치기 전에 계산되므로 원본 복사 없이도 결과가 같음
 */
function despeckle(bin: Uint8ClampedArray, w: number, h: number) {
  if (w < 3 || h < 3) return;
  let prev = new Uint8Array(w), cur = new Uint8Array(w), next = new Uint8Array(w);
  const rowSums = (y: number, dst: Uint8Array) => {
    const b = y * w;
    for (let x = 1; x < w - 1; x++) {
      dst[x] = (bin[b + x - 1] === 0 ? 1 : 0) + (bin[b + x] === 0 ? 1 : 0) + (bin[b + x + 1] === 0 ? 1 : 0);
    }
  };
  rowSums(0, prev);
  rowSums(1, cur);
  for (let y = 1; y < h - 1; y++) {
    rowSums(y + 1, next);
    const b = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = b + x, self = bin[i] === 0 ? 1 : 0;
      const black = prev[x] + cur[x] + next[x] - self;
      if (self && black <= 1) bin[i] = 255;
      else if (!self && black >= 7) bin[i] = 0;
    }
    [prev, cur, next] = [cur, next, prev];
  }
}

/** 90° 단위 회전 (새 이미지) */
export function rotateGray(g: Gray, deg: number): Gray {
  const k = ((Math.round(deg / 90) % 4) + 4) % 4;
  if (!k) return g;
  const { width: w, height: h, data: s } = g;
  const ow = k === 2 ? w : h, oh = k === 2 ? h : w;
  const out = new Uint8ClampedArray(ow * oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = s[y * w + x];
      if (k === 1) out[x * ow + (h - 1 - y)] = v;
      else if (k === 2) out[(h - 1 - y) * ow + (w - 1 - x)] = v;
      else out[(w - 1 - x) * ow + y] = v;
    }
  }
  return { data: out, width: ow, height: oh };
}

/** 1비트 행 단위 압축 (PDF DeviceGray 1bpc: 1 = 흰색, 앞 비트부터) */
export function packBits(g: Gray): Uint8Array {
  const { width: w, height: h, data: d } = g;
  const stride = Math.ceil(w / 8), out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[y * w + x] >= 128) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** 썸네일: 긴 변 maxSide로 면적 평균 축소 */
export function thumbnailRGBA(g: Gray, maxSide: number): RGBA {
  const s = Math.min(1, maxSide / Math.max(g.width, g.height));
  const W = Math.max(1, Math.round(g.width * s)), H = Math.max(1, Math.round(g.height * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const fx = g.width / W, fy = g.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let acc = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) acc += g.data[yy * g.width + xx];
      const o = (y * W + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = acc / ((y1 - y0) * (x1 - x0));
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}
