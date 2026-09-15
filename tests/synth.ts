// 테스트용 합성 이미지 도우미 (실제 사진처럼 잡음·흐림·질감을 넣을 수 있음)
import { type Point, type Quad, applyHomography, homography } from '../src/lib/geometry';
import { type RGBA, createRGBA } from '../src/lib/imgproc';

export const UNIT: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/** 결정적 난수 (테스트 재현용) */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inPoly(p: Point, poly: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function fillPoly(img: RGBA, poly: readonly Point[], [r, g, b]: readonly number[]) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(img.width, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!inPoly({ x: x + 0.5, y: y + 0.5 }, poly)) continue;
      const j = (y * img.width + x) * 4;
      img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = 255;
    }
  }
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Quad =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

export function ellipse(cx: number, cy: number, rx: number, ry: number, n = 48): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}

/** 문서 좌표계(0~1)의 도형을 사진 속 사각형 위치로 옮겨 칠함 */
export function fillOnDoc(img: RGBA, corners: Quad, shape: readonly Point[], color: readonly number[]) {
  const H = homography(UNIT, corners);
  fillPoly(img, shape.map(p => applyHomography(H, p)), color);
}

/** 가는 선(털·질감)을 poly 안에 무작위로 그림 */
export function strokes(img: RGBA, area: readonly Point[], count: number, color: readonly number[], seed: number) {
  const rand = rng(seed);
  const xs = area.map(p => p.x), ys = area.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (let n = 0; n < count; n++) {
    const x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0);
    if (!inPoly({ x, y }, area)) continue;
    const a = rand() * Math.PI, len = 6 + rand() * 14;
    for (let t = 0; t < len; t++) {
      const px = Math.round(x + Math.cos(a) * t), py = Math.round(y + Math.sin(a) * t);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const j = (py * img.width + px) * 4;
      img.data[j] = color[0]; img.data[j + 1] = color[1]; img.data[j + 2] = color[2];
    }
  }
}

/** 조명 기울기(한쪽이 어두움) */
export function shade(img: RGBA, from: number, to: number, horizontal = true) {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const t = horizontal ? x / (img.width - 1) : y / (img.height - 1);
      const f = from + (to - from) * t, j = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[j + c] *= f;
    }
  }
}

/** 카메라처럼 약간 흐리게 (3x3 박스) */
export function soften(img: RGBA) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[((y + dy) * w + x + dx) * 4 + c];
        img.data[(y * w + x) * 4 + c] = s / 9;
      }
    }
  }
}

/** 센서 잡음 */
export function noise(img: RGBA, amount: number, seed: number) {
  const rand = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() + rand() + rand() - 1.5) * amount;
    for (let c = 0; c < 3; c++) img.data[i + c] += n;
  }
}

/** 실제 사진처럼: 흐림 + 잡음 */
export function photoLike(img: RGBA, seed = 1) {
  soften(img);
  noise(img, 14, seed);
  return img;
}

export const PAPER = [240, 236, 228];
export const INK = [30, 30, 30];
const SKIN = [214, 170, 148];
const HAIR = [120, 90, 75];

function textLines(img: RGBA, corners: Quad, from = 0.15, to = 0.85) {
  for (let t = from; t < to; t += 0.07) fillOnDoc(img, corners, rect(0.1, t, 0.9, t + 0.02), INK);
}

/** 어두운 책상 위에 비스듬히 놓인 문서(글자 줄 포함) */
export function synthPhoto() {
  const img = createRGBA(480, 360);
  fillPoly(img, rect(0, 0, 480, 360), [70, 50, 35]);
  const corners: Quad = [{ x: 120, y: 50 }, { x: 330, y: 30 }, { x: 370, y: 320 }, { x: 140, y: 335 }];
  fillPoly(img, corners, PAPER);
  textLines(img, corners);
  return { img, corners };
}

/** 손에 든 책: 위는 나무 벽, 아래는 어두운 옷, 책 옆에 밝은 피부(팔·손)가 맞닿아 있음 */
export function synthHeldBook() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [40, 40, 52]);
  fillPoly(img, rect(0, 0, 600, 260), [150, 108, 70]);
  const leftArm = ellipse(60, 330, 170, 120), rightArm = ellipse(560, 520, 110, 200);
  fillPoly(img, leftArm, SKIN);
  fillPoly(img, rightArm, [206, 162, 140]);
  strokes(img, leftArm, 900, HAIR, 7);
  const corners: Quad = [{ x: 125, y: 95 }, { x: 480, y: 118 }, { x: 460, y: 700 }, { x: 140, y: 690 }];
  fillPoly(img, corners, [214, 228, 222]);
  fillOnDoc(img, corners, rect(0.15, 0.18, 0.85, 0.24), [50, 55, 60]);
  fillOnDoc(img, corners, rect(0.2, 0.3, 0.8, 0.34), [60, 60, 70]);
  fillOnDoc(img, corners, rect(0.2, 0.5, 0.8, 0.75), [120, 110, 170]);
  fillPoly(img, ellipse(470, 640, 45, 30), [206, 162, 140]);
  return { img: photoLike(img, 11), corners };
}

/** 무릎 위의 책(두 번째 사진): 위쪽은 털 있는 팔, 아래쪽은 어두운 셔츠, 굵은 제목이 가로로 */
export function synthLapBook() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [34, 40, 66]);           // 남색 셔츠
  const arm = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 170 }, { x: 420, y: 250 }, { x: 0, y: 230 }];
  fillPoly(img, arm, SKIN);
  strokes(img, arm, 2500, HAIR, 3);
  fillPoly(img, ellipse(80, 330, 90, 60), [190, 150, 132]);    // 옆으로 보이는 팔 일부
  const corners: Quad = [{ x: 115, y: 150 }, { x: 460, y: 160 }, { x: 485, y: 720 }, { x: 100, y: 715 }];
  fillPoly(img, corners, [206, 220, 212]);
  fillOnDoc(img, corners, rect(0.12, 0.2, 0.88, 0.27), [40, 45, 55]);  // 굵은 제목 1
  fillOnDoc(img, corners, rect(0.2, 0.3, 0.8, 0.38), [30, 35, 45]);    // 굵은 제목 2
  fillOnDoc(img, corners, rect(0.25, 0.62, 0.8, 0.72), [120, 110, 170]);
  shade(img, 0.75, 1.0, false);
  return { img: photoLike(img, 5), corners };
}

/** 밝은 회색 책상 위 흰 A4 (명암 차이가 작음), 한쪽 그림자 */
export function synthWhiteOnLight() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [205, 203, 198]);
  const corners: Quad = [{ x: 90, y: 110 }, { x: 500, y: 90 }, { x: 530, y: 690 }, { x: 70, y: 700 }];
  fillPoly(img, corners, [246, 245, 241]);
  textLines(img, corners, 0.12, 0.9);
  shade(img, 0.8, 1.0);
  return { img: photoLike(img, 9), corners };
}

/** 안쪽에 굵은 표 테두리가 있는 A4 양식 — 표가 아니라 종이 외곽을 찾아야 함 */
export function synthFormWithTable() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [95, 72, 50]);
  const corners: Quad = [{ x: 80, y: 70 }, { x: 520, y: 95 }, { x: 510, y: 730 }, { x: 95, y: 720 }];
  fillPoly(img, corners, PAPER);
  const t = 0.012;
  for (const r of [rect(0.08, 0.1, 0.92, 0.1 + t), rect(0.08, 0.9 - t, 0.92, 0.9),
    rect(0.08, 0.1, 0.08 + t, 0.9), rect(0.92 - t, 0.1, 0.92, 0.9)]) {
    fillOnDoc(img, corners, r, INK);
  }
  for (let y = 0.2; y < 0.9; y += 0.1) fillOnDoc(img, corners, rect(0.08, y, 0.92, y + 0.004), INK);
  return { img: photoLike(img, 4), corners };
}

/** 손가락이 오른쪽 아래 모서리를 가린 A4 */
export function synthFingerCorner() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [60, 62, 70]);
  const corners: Quad = [{ x: 100, y: 90 }, { x: 490, y: 110 }, { x: 505, y: 690 }, { x: 85, y: 700 }];
  fillPoly(img, corners, PAPER);
  textLines(img, corners);
  fillPoly(img, ellipse(505, 690, 55, 38), SKIN);
  return { img: photoLike(img, 8), corners };
}

export const px = (img: RGBA, x: number, y: number) => {
  const j = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[j], img.data[j + 1], img.data[j + 2]];
};

export const cornerError = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
