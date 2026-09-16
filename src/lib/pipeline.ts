// 감지 → 원근 보정 → 필터 → 회전 파이프라인
import {
  type PageSettings, type Quad,
  defaultQuad, isConvex, orderQuad, outputSize,
} from './geometry';
import { type Gray, type RGBA, warp, warpGray, warpSourceRegion } from './imgproc';
import { grayDocument, grayToRGBA, luminance, rotateGray, scanDocument } from './filters';
import { type Drawable, type Surface, readRGBA, rotate, toSurface } from './canvas';
import { type DetectMethod, detectQuad } from './detector';

const DETECT_SIZE = 600;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface DocumentDetection { quad: Quad; found: boolean; method: DetectMethod; score: number }

/** onWait: 감지 엔진을 처음 내려받는 중일 때 표시할 안내 */
export async function detectDocument(src: Drawable, onWait?: (msg: string) => void): Promise<DocumentDetection> {
  const W = src.width, H = src.height;
  const s = Math.min(1, DETECT_SIZE / Math.max(W, H));
  const img = readRGBA(src, 0, 0, W, H, W * s, H * s);
  const sx = W / img.width, sy = H / img.height; // img 버퍼는 워커로 넘어가므로 먼저 계산
  const { quad: q, method, score } = await detectQuad(img, onWait);
  const miss = { quad: defaultQuad(W, H), found: false, method, score };
  if (!q) return miss;
  const quad = orderQuad(q.map(p => ({ x: clamp(p.x * sx, 0, W), y: clamp(p.y * sy, 0, H) })));
  return isConvex(quad) ? { quad, found: true, method, score } : miss;
}

/** 문서 주변만 잘라(필요하면 축소해) 읽고, 그 안에서의 사각형 좌표 */
function sourceRegion(src: Drawable, quad: Quad, outW: number, outH: number): { img: RGBA; local: Quad } {
  const r = warpSourceRegion(quad, src.width, src.height, outW, outH);
  const img = readRGBA(src, r.x, r.y, r.w, r.h, r.w * r.scale, r.h * r.scale);
  const sx = img.width / r.w, sy = img.height / r.h;
  return { img, local: quad.map(p => ({ x: (p.x - r.x) * sx, y: (p.y - r.y) * sy })) as Quad };
}

export function warpDocument(src: Drawable, quad: Quad, outW: number, outH: number): RGBA {
  const { img, local } = sourceRegion(src, quad, outW, outH);
  return warp(img, local, outW, outH);
}

/** 흑백·스캔용: 밝기 1채널로 보정 (RGBA의 1/4 메모리) */
export function warpDocumentGray(src: Drawable, quad: Quad, outW: number, outH: number): Gray {
  const { img, local } = sourceRegion(src, quad, outW, outH);
  return warpGray(luminance(img), local, outW, outH);
}

export type Rendered =
  /** 원본·흑백 → JPEG로 저장 */
  | { kind: 'color'; surface: Surface }
  /** 스캔 → 1비트 흑백으로 저장 */
  | { kind: 'mono'; img: Gray };

export function renderPage(src: Drawable, quad: Quad, settings: PageSettings, dpi: number): Rendered {
  const { w, h } = outputSize(quad, settings.paper, dpi);
  switch (settings.filter) {
    case 'scan':
      return { kind: 'mono', img: rotateGray(scanDocument(warpDocumentGray(src, quad, w, h)), settings.rot) };
    case 'gray':
      return { kind: 'color', surface: rotate(toSurface(grayToRGBA(grayDocument(warpDocumentGray(src, quad, w, h)))), settings.rot) };
    default:
      return { kind: 'color', surface: rotate(toSurface(warpDocument(src, quad, w, h)), settings.rot) };
  }
}

/** 편집기 미리보기: 캐시된 보정 결과(RGBA)에 필터·회전만 적용 */
export function finishPreview(warped: RGBA, settings: PageSettings): Surface {
  const out = settings.filter === 'scan' ? grayToRGBA(scanDocument(luminance(warped)))
    : settings.filter === 'gray' ? grayToRGBA(grayDocument(luminance(warped)))
    : warped;
  return rotate(toSurface(out), settings.rot);
}
