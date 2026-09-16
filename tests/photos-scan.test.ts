// 실사진 스캔 회귀 테스트 — test-photos/ 가 없으면(CI 등) 건너뜀
import { describe, expect, it } from 'vitest';
import { luminance, scanDocument } from '../src/lib/filters';
import type { Quad } from '../src/lib/geometry';
import { type Gray, warpGray } from '../src/lib/imgproc';
import { loadJpeg, photoFiles } from './photos';

const FILE = 'KakaoTalk_20260916_012401905_01.jpg';
const has = photoFiles().includes(FILE);

function inkRatio(g: Gray, x0: number, y0: number, x1: number, y1: number) {
  let ink = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (g.data[y * g.width + x] < 128) ink++;
  return ink / ((x1 - x0) * (y1 - y0));
}

describe.skipIf(!has)('실사진 스캔 (책 표지, 300dpi)', () => {
  const quad: Quad = [{ x: 281, y: 429 }, { x: 757, y: 423 }, { x: 928, y: 1136 }, { x: 43, y: 1124 }];
  const out = has ? scanDocument(warpGray(luminance(loadJpeg(FILE)), quad, 2480, 3508)) : null;

  it('연한 부제목("프로그래밍 상상력을 키워주는…")이 사라지지 않는다', () => {
    const r = inkRatio(out!, 455, 478, 1995, 528);
    expect(r, `부제목 줄 검정 비율 ${r.toFixed(3)}`).toBeGreaterThan(0.15);
  });

  it('제목 위 빈 표지는 흰색', () => {
    expect(inkRatio(out!, 300, 250, 2200, 420)).toBeLessThan(0.01);
  });

  it('가장자리에 검은 띠가 남지 않는다', () => {
    const { width: w, height: h } = out!;
    expect(inkRatio(out!, 0, 0, w, 20), '위').toBeLessThan(0.01);
    expect(inkRatio(out!, 0, h - 20, w, h), '아래').toBeLessThan(0.05);
    expect(inkRatio(out!, w - 20, 0, w, h), '오른쪽').toBeLessThan(0.05);
  });
});
