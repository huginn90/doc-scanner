import { describe, expect, it } from 'vitest';
import {
  type Quad,
  applyHomography, homography, isConvex, orderQuad, outputSize, pageSizePt,
} from '../src/lib/geometry';
import { applyFilter, createRGBA, detectByRegion, warp } from '../src/lib/imgproc';
import { buildPdf } from '../src/lib/pdf';
import { UNIT, cornerError, px, synthPhoto } from './synth';

// ---------------------------------------------------------------- 기하

describe('geometry', () => {
  it('호모그래피가 네 점을 정확히 옮긴다', () => {
    const dst: Quad = [{ x: 10, y: 20 }, { x: 200, y: 5 }, { x: 220, y: 300 }, { x: 0, y: 280 }];
    const H = homography(UNIT, dst);
    UNIT.forEach((p, i) => {
      const q = applyHomography(H, p);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('섞인 꼭짓점을 좌상·우상·우하·좌하로 정렬한다', () => {
    const q = orderQuad([{ x: 100, y: 90 }, { x: 0, y: 0 }, { x: 0, y: 100 }, { x: 110, y: 5 }]);
    expect(q).toEqual([{ x: 0, y: 0 }, { x: 110, y: 5 }, { x: 100, y: 90 }, { x: 0, y: 100 }]);
  });

  it('꼬인 사각형은 볼록하지 않다', () => {
    expect(isConvex(UNIT)).toBe(true);
    expect(isConvex([UNIT[0], UNIT[2], UNIT[1], UNIT[3]])).toBe(false);
  });

  it('A4 출력 크기와 PDF 페이지 크기', () => {
    const portrait: Quad = [{ x: 0, y: 0 }, { x: 210, y: 0 }, { x: 210, y: 297 }, { x: 0, y: 297 }];
    expect(outputSize(portrait, 'a4', 200)).toEqual({ w: 1654, h: 2339 });
    const landscape: Quad = [{ x: 0, y: 0 }, { x: 297, y: 0 }, { x: 297, y: 210 }, { x: 0, y: 210 }];
    expect(outputSize(landscape, 'a4', 200)).toEqual({ w: 2339, h: 1654 });
    expect(pageSizePt(1654, 2339, 'a4')).toEqual([595.28, 841.89]);
  });
});

// ---------------------------------------------------------------- 감지·보정·필터

describe('imgproc', () => {
  it('어두운 배경 위 문서의 네 모서리를 찾는다', () => {
    const { img, corners } = synthPhoto();
    const det = detectByRegion(img);
    expect(det).not.toBeNull();
    expect(cornerError(orderQuad(det!.quad), corners)).toBeLessThan(5);
  });

  it('원근 보정 후 문서가 화면을 채우고 글자 줄이 수평이 된다', () => {
    const { img, corners } = synthPhoto();
    const out = warp(img, corners, 210, 297);
    for (const [x, y] of [[4, 4], [205, 4], [205, 292], [4, 292], [105, 20]]) {
      expect(px(out, x, y)[0]).toBeGreaterThan(200); // 배경색이 섞이지 않음
    }
    const lineY = (0.15 + 0.01) * 297;
    for (const x of [40, 105, 170]) expect(px(out, x, lineY)[0]).toBeLessThan(80);
  });

  it('선명하게: 그림자진 종이가 균일한 흰색이 된다', () => {
    const img = createRGBA(400, 400);
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) {
        const shade = 0.6 + 0.4 * (x / 399); // 왼쪽이 어두움
        const j = (y * 400 + x) * 4;
        const ink = y > 195 && y < 205 && x > 50 && x < 350;
        img.data[j] = (ink ? 30 : 235) * shade;
        img.data[j + 1] = (ink ? 30 : 225) * shade;
        img.data[j + 2] = (ink ? 30 : 205) * shade; // 누런 조명
        img.data[j + 3] = 255;
      }
    }
    applyFilter(img, 'enhance');
    for (const x of [10, 200, 390]) {
      const [r, g, b] = px(img, x, 100);
      expect(Math.min(r, g, b)).toBeGreaterThan(240);
    }
    expect(px(img, 200, 200)[0]).toBeLessThan(40);
  });

  it('스캔 B&W: 배경은 흰색, 글자는 검정', () => {
    const { img, corners } = synthPhoto();
    const out = applyFilter(warp(img, corners, 420, 594), 'bw');
    expect(px(out, 210, 40)[0]).toBe(255);
    expect(px(out, 210, (0.15 + 0.01) * 594)[0]).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------- PDF

describe('pdf', () => {
  it('xref 오프셋이 각 객체 시작을 가리킨다', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0x00, 0x11, 0x22, 0xff, 0xd9]);
    const page = { jpeg, w: 10, h: 14, pw: 595.28, ph: 841.89 };
    const blob = buildPdf([page, page], '테스트 문서');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1]));
    expect(offsets).toHaveLength(9);
    offsets.forEach((o, i) => expect(text.slice(o)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});
