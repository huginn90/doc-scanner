import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { type EdgeField, aspectFactor, detectByEdges, quadSupport } from '../src/lib/cvdetect';
import { type Quad, orderQuad } from '../src/lib/geometry';
import { type RGBA, cloneRGBA, detectByRegion } from '../src/lib/imgproc';
import type { CV } from '../src/lib/opencv';
import {
  cornerError, rect, synthFingerCorner, synthFormWithTable, synthHeldBook, synthLapBook,
  synthPhoto, synthWhiteOnLight,
} from './synth';

let cv: CV;
beforeAll(async () => {
  // 패키지가 Promise를 export해서 Vitest의 ESM 로더로는 불러올 수 없음 → CommonJS require 사용
  const mod = createRequire(import.meta.url)('@techstark/opencv-js');
  const ready = mod instanceof Promise ? await mod : mod;
  if (!ready.Mat) await new Promise<void>(resolve => { ready.onRuntimeInitialized = () => resolve(); });
  cv = ready;
}, 60000);

/** 워커와 같은 방식: 영역 기반 결과를 후보로 넣고 경계 기준으로 검증 */
function detect(img: RGBA) {
  const region = detectByRegion(cloneRGBA(img));
  return detectByEdges(cv, img, region ? [region.quad] : []);
}

function expectCorners(img: RGBA, corners: Quad, maxErr: number) {
  const det = detect(img);
  expect(det, '문서를 찾지 못함').not.toBeNull();
  const err = cornerError(orderQuad(det!.quad), corners);
  expect(err, `모서리 오차 ${err.toFixed(1)}px`).toBeLessThan(maxErr);
  return err;
}

describe('quadSupport', () => {
  // 20~80 정사각형 테두리, 기울기는 테두리에 수직
  const w = 100, h = 100;
  const field: EdgeField = { w, h, edges: new Uint8Array(w * h), gx: new Float32Array(w * h), gy: new Float32Array(w * h) };
  for (let i = 20; i <= 80; i++) {
    for (const [x, y, gx, gy] of [[i, 20, 0, 1], [i, 80, 0, 1], [20, i, 1, 0], [80, i, 1, 0]]) {
      field.edges[y * w + x] = 1; field.gx[y * w + x] = gx; field.gy[y * w + x] = gy;
    }
  }

  it('경계와 겹치는 사각형은 1에 가깝다', () => {
    expect(quadSupport(field, rect(20, 20, 80, 80))).toBeGreaterThan(0.95);
  });

  it('한 변이 허공에 뜨면 점수가 크게 떨어진다', () => {
    expect(quadSupport(field, rect(20, 20, 95, 80))).toBeLessThan(0.5);
  });

  it('경계가 있어도 방향이 다르면 인정하지 않는다', () => {
    const crossed: EdgeField = { ...field, gx: field.gy, gy: field.gx };
    expect(quadSupport(crossed, rect(20, 20, 80, 80))).toBeLessThan(0.2);
  });
});

describe('aspectFactor', () => {
  it('A4 비율을 선호한다', () => {
    expect(aspectFactor(rect(0, 0, 210, 297))).toBeCloseTo(1, 2);
    expect(aspectFactor(rect(0, 0, 297, 210))).toBeCloseTo(1, 2);
    expect(aspectFactor(rect(0, 0, 300, 300))).toBeLessThan(0.8);
  });
});

describe('detectByEdges', () => {
  it('어두운 책상 위 문서', () => {
    const { img, corners } = synthPhoto();
    expectCorners(img, corners, 5);
  });

  it('피부가 맞닿은 손에 든 책 (털·잡음 포함)', () => {
    const { img, corners } = synthHeldBook();
    expectCorners(img, corners, 8);
  });

  it('무릎 위 책: 털 있는 팔 + 어두운 셔츠 + 굵은 제목', () => {
    const { img, corners } = synthLapBook();
    expectCorners(img, corners, 8);
  });

  it('밝은 책상 위 흰 A4 (명암 차이 작음 + 그림자)', () => {
    const { img, corners } = synthWhiteOnLight();
    expectCorners(img, corners, 8);
  });

  it('양식 안쪽 표 테두리가 아니라 종이 외곽을 찾는다', () => {
    const { img, corners } = synthFormWithTable();
    expectCorners(img, corners, 8);
  });

  it('손가락에 가려진 모서리도 두 변의 교차점으로 찾는다', () => {
    const { img, corners } = synthFingerCorner();
    expectCorners(img, corners, 10);
  });

  it('문서가 없는 사진에서는 엉뚱한 사각형을 내지 않는다', () => {
    const { img } = synthLapBook();
    // 문서 영역을 셔츠 색으로 덮어 문서를 없앰
    for (let i = 0; i < img.data.length; i += 4) {
      const y = Math.floor(i / 4 / img.width);
      if (y > 260) { img.data[i] = 34; img.data[i + 1] = 40; img.data[i + 2] = 66; }
    }
    const det = detect(img);
    if (det) expect(det.score).toBeLessThan(0.2);
  });
});
