// 테스트용 합성 이미지 도우미
import { type Point, type Quad, applyHomography, homography } from '../src/lib/geometry';
import { type RGBA, createRGBA } from '../src/lib/imgproc';

export const UNIT: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

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

export const PAPER = [240, 236, 228];
export const INK = [30, 30, 30];

/** 어두운 책상 위에 비스듬히 놓인 문서(글자 줄 포함) */
export function synthPhoto() {
  const img = createRGBA(480, 360);
  fillPoly(img, rect(0, 0, 480, 360), [70, 50, 35]);
  const corners: Quad = [{ x: 120, y: 50 }, { x: 330, y: 30 }, { x: 370, y: 320 }, { x: 140, y: 335 }];
  fillPoly(img, corners, PAPER);
  for (let t = 0.15; t < 0.85; t += 0.07) fillOnDoc(img, corners, rect(0.1, t, 0.9, t + 0.02), INK);
  return { img, corners };
}

/**
 * 손에 든 책: 위는 나무 벽, 아래는 어두운 옷, 책 옆에 밝은 피부(팔·손)가 맞닿아 있음.
 * 밝기만으로는 책과 피부가 한 덩어리로 잡히는 상황.
 */
export function synthHeldBook() {
  const img = createRGBA(600, 800);
  fillPoly(img, rect(0, 0, 600, 800), [40, 40, 52]);          // 어두운 옷
  fillPoly(img, rect(0, 0, 600, 260), [150, 108, 70]);        // 나무 벽
  fillPoly(img, ellipse(60, 330, 170, 120), [214, 170, 148]); // 왼쪽 팔
  fillPoly(img, ellipse(560, 520, 110, 200), [206, 162, 140]); // 오른쪽 팔
  const corners: Quad = [{ x: 125, y: 95 }, { x: 480, y: 118 }, { x: 460, y: 700 }, { x: 140, y: 690 }];
  fillPoly(img, corners, [214, 228, 222]);                     // 민트색 표지
  fillOnDoc(img, corners, rect(0.15, 0.18, 0.85, 0.24), [50, 55, 60]); // 제목
  fillOnDoc(img, corners, rect(0.2, 0.3, 0.8, 0.34), [60, 60, 70]);
  fillOnDoc(img, corners, rect(0.2, 0.5, 0.8, 0.75), [120, 110, 170]); // 표지 그림
  fillPoly(img, ellipse(470, 640, 45, 30), [206, 162, 140]);  // 모서리를 쥔 손가락
  return { img, corners };
}

export const px = (img: RGBA, x: number, y: number) => {
  const j = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[j], img.data[j + 1], img.data[j + 2]];
};

export const cornerError = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
