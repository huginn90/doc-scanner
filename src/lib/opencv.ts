// OpenCV.js 로딩 (약 13MB). 이 파일은 감지 워커에서만 import하므로 메인 화면 로딩에는 영향 없음.
// 패키지가 Promise를 export해서 동적 import()를 쓰면 네임스페이스가 thenable로 취급되어 실패 → 정적 import 사용
import cvModule from '@techstark/opencv-js';

export type CV = typeof import('@techstark/opencv-js');

let loading: Promise<{ cv: CV }> | null = null;

/** 모듈 객체가 thenable일 수 있어 { cv }로 감싸서 반환 */
export function loadOpenCv(): Promise<{ cv: CV }> {
  loading ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let m: any = cvModule;
    if (m instanceof Promise) m = await m;
    else if (!m.Mat) await new Promise<void>(resolve => { m.onRuntimeInitialized = () => resolve(); });
    return { cv: m as CV };
  })();
  return loading;
}
