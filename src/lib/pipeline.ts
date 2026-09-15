// 감지 → 원근 보정 → 필터 → 회전 파이프라인
import {
  type PageSettings, type Quad,
  defaultQuad, isConvex, orderQuad, outputSize,
} from './geometry';
import { type RGBA, applyFilter, cloneRGBA, detectByRegion, warp, warpSourceRegion } from './imgproc';
import { type Drawable, type Surface, readRGBA, rotate, toSurface } from './canvas';

const DETECT_SIZE = 480;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function detectDocument(src: Drawable): { quad: Quad; found: boolean } {
  const W = src.width, H = src.height;
  const s = Math.min(1, DETECT_SIZE / Math.max(W, H));
  const img = readRGBA(src, 0, 0, W, H, W * s, H * s);
  const det = detectByRegion(img);
  if (!det) return { quad: defaultQuad(W, H), found: false };
  const sx = W / img.width, sy = H / img.height;
  const quad = orderQuad(det.quad.map(p => ({ x: clamp(p.x * sx, 0, W), y: clamp(p.y * sy, 0, H) })));
  return isConvex(quad) ? { quad, found: true } : { quad: defaultQuad(W, H), found: false };
}

export function warpDocument(src: Drawable, quad: Quad, outW: number, outH: number): RGBA {
  const r = warpSourceRegion(quad, src.width, src.height, outW, outH);
  const img = readRGBA(src, r.x, r.y, r.w, r.h, r.w * r.scale, r.h * r.scale);
  const sx = img.width / r.w, sy = img.height / r.h;
  const local = quad.map(p => ({ x: (p.x - r.x) * sx, y: (p.y - r.y) * sy })) as Quad;
  return warp(img, local, outW, outH);
}

export function renderPage(src: Drawable, quad: Quad, settings: PageSettings, dpi: number): Surface {
  const { w, h } = outputSize(quad, settings.paper, dpi);
  const img = warpDocument(src, quad, w, h);
  applyFilter(img, settings.filter);
  return rotate(toSurface(img), settings.rot);
}

/** 편집기 미리보기: 캐시된 보정 결과에 필터/회전만 적용 */
export function finishPreview(warped: RGBA, settings: PageSettings): Surface {
  return rotate(toSurface(applyFilter(cloneRGBA(warped), settings.filter)), settings.rot);
}
