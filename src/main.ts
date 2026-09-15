import './style.css';
import {
  type FilterMode, type Paper, type PageSettings, type Point, type Quad,
  defaultQuad, isConvex, orderQuad, outputSize, pageSizePt,
} from './lib/geometry';
import type { RGBA } from './lib/imgproc';
import { type Surface, createSurface, ctx2d, decodeImage, encodeJpeg, release } from './lib/canvas';
import { detectDocument, finishPreview, renderPage, warpDocument } from './lib/pipeline';
import { buildPdf } from './lib/pdf';

const PREVIEW_DPI = 110;
const JPEG_QUALITY = 0.88;

interface PageOut { blob: Blob; w: number; h: number; pw: number; ph: number }
interface Page {
  id: number;
  source: Blob;
  quad: Quad;
  settings: PageSettings;
  out?: PageOut;
  thumb?: string;
}

const state = {
  pages: [] as Page[],
  dpi: 200,
  defaults: { paper: 'a4', filter: 'enhance', rot: 0 } as PageSettings,
};
let nextId = 1;

function $<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}

// ---------------------------------------------------------------- 공통 유틸

/** 로딩 표시가 그려지도록 한 프레임 양보. 백그라운드 탭에서는 rAF가 멈추므로 타이머로도 보장 */
const nextFrame = () => new Promise<void>(resolve => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 100);
});

function busy(text?: string) {
  $('#busyText').textContent = text || '처리 중…';
  $('#busy').hidden = !text;
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

async function renderOutput(page: Page, src: Surface) {
  const c = renderPage(src, page.quad, page.settings, state.dpi);
  const w = c.width, h = c.height;
  const [pw, ph] = pageSizePt(w, h, page.settings.paper);
  const blob = await encodeJpeg(c, JPEG_QUALITY);

  const ts = Math.min(1, 320 / Math.max(w, h));
  const t = createSurface(w * ts, h * ts);
  const tcx = ctx2d(t);
  tcx.imageSmoothingQuality = 'high';
  tcx.drawImage(c, 0, 0, t.width, t.height);
  const thumbBlob = await encodeJpeg(t, 0.8);
  release(t);
  release(c);

  if (page.thumb) URL.revokeObjectURL(page.thumb);
  page.thumb = URL.createObjectURL(thumbBlob);
  page.out = { blob, w, h, pw, ph };
}

// ---------------------------------------------------------------- 사진 추가

async function addFiles(list: FileList | File[]) {
  const files = [...list].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!files.length) return;

  if (files.length === 1) {
    busy('문서를 찾는 중…');
    await nextFrame();
    try {
      const src = await decodeImage(files[0]);
      const { quad, found } = detectDocument(src);
      const page: Page = { id: nextId++, source: files[0], quad, settings: { ...state.defaults } };
      busy();
      openEditor(page, src, true);
      if (!found) toast('문서를 찾지 못했어요. 모서리를 직접 맞춰 주세요.');
    } catch (e) {
      busy();
      toast(e instanceof Error ? e.message : '이미지를 처리하지 못했습니다');
    }
    return;
  }

  // 여러 장은 자동 처리 후 목록에 추가 (필요하면 개별 편집)
  let missed = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`처리 중… ${i + 1} / ${files.length}`);
    await nextFrame();
    try {
      const src = await decodeImage(files[i]);
      const { quad, found } = detectDocument(src);
      if (!found) missed++;
      const page: Page = { id: nextId++, source: files[i], quad, settings: { ...state.defaults } };
      await renderOutput(page, src);
      release(src);
      state.pages.push(page);
      renderList();
    } catch (e) {
      console.error(e);
      missed++;
    }
  }
  busy();
  if (missed) toast(`${missed}장은 영역을 확인해 주세요 (썸네일을 눌러 편집)`);
}

for (const id of ['#camInput', '#fileInput']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    if (input.files) addFiles([...input.files]);
    input.value = '';
  });
}

const drop = $('#dropZone');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('dragover');
  if (e.dataTransfer) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- 페이지 목록

const ICONS = {
  left: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  right: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  rot: '<path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 9a8 8 0 1 0-1.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  del: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};
const icon = (name: keyof typeof ICONS) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICONS[name]}</svg>`;

function renderList() {
  const n = state.pages.length;
  const exportBtn = $<HTMLButtonElement>('#exportBtn');
  $('#empty').hidden = n > 0;
  exportBtn.disabled = n === 0;
  exportBtn.textContent = n ? `PDF 만들기 (${n})` : 'PDF 만들기';
  $('#pages').innerHTML = state.pages.map((p, i) => `
    <li class="page" data-id="${p.id}">
      <button class="thumb" data-act="edit" aria-label="${i + 1}페이지 편집">
        <img src="${p.thumb}" alt="">
        <span class="no">${i + 1}</span>
      </button>
      <div class="page-actions">
        <button data-act="left" aria-label="앞으로" ${i === 0 ? 'disabled' : ''}>${icon('left')}</button>
        <button data-act="rot" aria-label="회전">${icon('rot')}</button>
        <button data-act="del" class="del" aria-label="삭제">${icon('del')}</button>
        <button data-act="right" aria-label="뒤로" ${i === n - 1 ? 'disabled' : ''}>${icon('right')}</button>
      </div>
    </li>`).join('');
}

$('#pages').addEventListener('click', async e => {
  const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
  const li = btn?.closest<HTMLElement>('.page');
  if (!btn || !li) return;
  const idx = state.pages.findIndex(p => p.id === Number(li.dataset.id));
  const page = state.pages[idx];

  switch (btn.dataset.act) {
    case 'left':
    case 'right': {
      const to = btn.dataset.act === 'left' ? idx - 1 : idx + 1;
      [state.pages[idx], state.pages[to]] = [state.pages[to], state.pages[idx]];
      renderList();
      break;
    }
    case 'del':
      if (!confirm(`${idx + 1}페이지를 삭제할까요?`)) return;
      if (page.thumb) URL.revokeObjectURL(page.thumb);
      state.pages.splice(idx, 1);
      renderList();
      break;
    case 'rot': {
      busy('회전 중…');
      await nextFrame();
      const src = await decodeImage(page.source);
      page.settings.rot = (page.settings.rot + 90) % 360;
      await renderOutput(page, src);
      release(src);
      busy();
      renderList();
      break;
    }
    case 'edit': {
      busy('불러오는 중…');
      await nextFrame();
      const src = await decodeImage(page.source);
      busy();
      openEditor(page, src, false);
      break;
    }
  }
});

$<HTMLSelectElement>('#dpiSel').addEventListener('change', async e => {
  state.dpi = Number((e.target as HTMLSelectElement).value);
  for (let i = 0; i < state.pages.length; i++) {
    busy(`화질 적용 중… ${i + 1} / ${state.pages.length}`);
    await nextFrame();
    const src = await decodeImage(state.pages[i].source);
    await renderOutput(state.pages[i], src);
    release(src);
  }
  busy();
  renderList();
});

window.addEventListener('beforeunload', e => {
  if (state.pages.length) e.preventDefault();
});

// ---------------------------------------------------------------- 편집기

interface Editor {
  page: Page;
  src: Surface;
  isNew: boolean;
  quad: Quad;
  settings: PageSettings;
  step: 1 | 2;
  warped: RGBA | null;
  warpKey: string;
  preview: Surface | null;
}

const stage = $('#stage');
const edCanvas = $<HTMLCanvasElement>('#edCanvas');
const overlay = $<SVGSVGElement>('#overlay');
const loupe = $<HTMLCanvasElement>('#loupe');
const SVGNS = 'http://www.w3.org/2000/svg';

let ed: Editor | null = null;
let view = { s: 1, ox: 0, oy: 0 };

function openEditor(page: Page, src: Surface, isNew: boolean) {
  ed = {
    page, src, isNew,
    quad: page.quad.map(p => ({ ...p })) as Quad,
    settings: { ...page.settings },
    step: 1,
    warped: null, warpKey: '', preview: null,
  };
  $('#editor').hidden = false;
  buildOverlay();
  setStep(1);
}

function closeEditor() {
  if (!ed) return;
  release(ed.src);
  release(ed.preview);
  ed = null;
  $('#editor').hidden = true;
}

function setStep(step: 1 | 2) {
  if (!ed) return;
  ed.step = step;
  document.querySelectorAll<HTMLElement>('.ed-tools').forEach(el => (el.hidden = Number(el.dataset.step) !== step));
  overlay.style.display = step === 1 ? '' : 'none';
  $('#edTitle').textContent = step === 1 ? '영역 조정' : '보정';
  $('#edBack').textContent = step === 1 ? '취소' : '← 영역';
  $('#edNext').textContent = step === 1 ? '다음' : (ed.isNew ? '추가' : '완료');
  if (step === 2) updatePreview();
  else layoutStage();
  syncControls();
}

function layoutStage() {
  if (!ed) return;
  const img = ed.step === 1 ? ed.src : ed.preview;
  if (!img) return;
  const r = stage.getBoundingClientRect();
  const pad = ed.step === 1 ? 28 : 16;
  const s = Math.min((r.width - pad * 2) / img.width, (r.height - pad * 2) / img.height);
  const dw = img.width * s, dh = img.height * s;
  view = { s, ox: (r.width - dw) / 2, oy: (r.height - dh) / 2 };
  const dpr = window.devicePixelRatio || 1;
  Object.assign(edCanvas.style, { left: `${view.ox}px`, top: `${view.oy}px`, width: `${dw}px`, height: `${dh}px` });
  edCanvas.width = Math.max(1, Math.round(dw * dpr));
  edCanvas.height = Math.max(1, Math.round(dh * dpr));
  const cx = edCanvas.getContext('2d')!;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, edCanvas.width, edCanvas.height);
  if (ed.step === 1) drawOverlay();
}
window.addEventListener('resize', layoutStage);

/** 오버레이: 바깥 음영, 테두리, 모서리 4개 + 변 중앙 4개 핸들 */
function buildOverlay() {
  overlay.innerHTML = '';
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element = overlay) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent.appendChild(e);
    return e;
  };
  el('path', { class: 'shade', 'fill-rule': 'evenodd' });
  el('polygon', { class: 'edge' });
  for (let i = 0; i < 4; i++) {
    const g = el('g', { 'data-kind': 'mid', 'data-i': i });
    el('circle', { class: 'hit', r: 20 }, g);
    el('rect', { class: 'bar', rx: 4, x: -14, y: -4, width: 28, height: 8 }, g);
  }
  for (let i = 0; i < 4; i++) {
    const g = el('g', { 'data-kind': 'corner', 'data-i': i });
    el('circle', { class: 'hit', r: 26 }, g);
    el('circle', { class: 'dot', r: 10 }, g);
  }
}

const toView = (p: Point): Point => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });

function drawOverlay() {
  if (!ed) return;
  const r = stage.getBoundingClientRect();
  const q = ed.quad.map(toView);
  overlay.querySelector('.shade')!.setAttribute('d',
    `M0 0H${r.width}V${r.height}H0Z M${q.map(p => `${p.x} ${p.y}`).join(' L')}Z`);
  overlay.querySelector('.edge')!.setAttribute('points', q.map(p => `${p.x},${p.y}`).join(' '));
  overlay.classList.toggle('invalid', !isConvex(ed.quad));
  overlay.querySelectorAll<SVGGElement>('[data-kind="corner"]').forEach(g => {
    const p = q[Number(g.dataset.i)];
    g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  });
  overlay.querySelectorAll<SVGGElement>('[data-kind="mid"]').forEach(g => {
    const i = Number(g.dataset.i), a = q[i], b = q[(i + 1) % 4];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    g.setAttribute('transform', `translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${ang})`);
  });
}

interface Drag { id: number; g: SVGGElement; kind: string; i: number; sx: number; sy: number; start: Quad }
let drag: Drag | null = null;

overlay.addEventListener('pointerdown', e => {
  const g = (e.target as Element).closest<SVGGElement>('[data-kind]');
  if (!g || !ed) return;
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  drag = {
    id: e.pointerId, g, kind: g.dataset.kind!, i: Number(g.dataset.i),
    sx: e.clientX, sy: e.clientY, start: ed.quad.map(p => ({ ...p })) as Quad,
  };
  g.classList.add('active');
  onDrag(e);
});
overlay.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) onDrag(e); });
const endDrag = (e: PointerEvent) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.g.classList.remove('active');
  drag = null;
  loupe.hidden = true;
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

function onDrag(e: PointerEvent) {
  if (!ed || !drag) return;
  const d = drag, quad = ed.quad;
  const dx = (e.clientX - d.sx) / view.s, dy = (e.clientY - d.sy) / view.s;
  const W = ed.src.width, H = ed.src.height;
  const move = (i: number) => {
    quad[i] = {
      x: Math.min(W, Math.max(0, d.start[i].x + dx)),
      y: Math.min(H, Math.max(0, d.start[i].y + dy)),
    };
  };
  let focus: Point;
  if (d.kind === 'corner') {
    move(d.i);
    focus = quad[d.i];
  } else {
    const j = (d.i + 1) % 4;
    move(d.i);
    move(j);
    focus = { x: (quad[d.i].x + quad[j].x) / 2, y: (quad[d.i].y + quad[j].y) / 2 };
  }
  drawOverlay();
  drawLoupe(focus);
}

function drawLoupe(p: Point) {
  if (!ed) return;
  const size = 130, dpr = window.devicePixelRatio || 1;
  const px = size * dpr;
  if (loupe.width !== px) { loupe.width = px; loupe.height = px; }
  const vp = toView(p);
  loupe.classList.toggle('right', vp.x < 180 && vp.y < 180);
  loupe.hidden = false;

  const half = size / (view.s * 3) / 2; // 화면 대비 3배 확대
  const cx = loupe.getContext('2d')!;
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, px, px);
  cx.drawImage(ed.src, p.x - half, p.y - half, half * 2, half * 2, 0, 0, px, px);
  const map = (q: Point) => ({ x: (q.x - p.x + half) / (half * 2) * px, y: (q.y - p.y + half) / (half * 2) * px });
  cx.strokeStyle = '#3b82f6';
  cx.lineWidth = 2 * dpr;
  cx.beginPath();
  ed.quad.map(map).forEach((q, i) => (i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y)));
  cx.closePath();
  cx.stroke();
  cx.strokeStyle = 'rgba(255,255,255,.9)';
  cx.lineWidth = dpr;
  cx.beginPath();
  cx.moveTo(px / 2, px / 2 - 12 * dpr); cx.lineTo(px / 2, px / 2 + 12 * dpr);
  cx.moveTo(px / 2 - 12 * dpr, px / 2); cx.lineTo(px / 2 + 12 * dpr, px / 2);
  cx.stroke();
}

$('#autoBtn').addEventListener('click', () => {
  if (!ed) return;
  const { quad, found } = detectDocument(ed.src);
  ed.quad = quad;
  drawOverlay();
  if (!found) toast('문서를 찾지 못했어요. 직접 맞춰 주세요.');
});
$('#fullBtn').addEventListener('click', () => {
  if (!ed) return;
  ed.quad = defaultQuad(ed.src.width, ed.src.height, 0);
  drawOverlay();
});

/** 2단계 미리보기: 원근 보정 결과를 캐시하고 필터/회전만 다시 적용 */
function updatePreview() {
  if (!ed) return;
  const key = JSON.stringify([ed.quad, ed.settings.paper]);
  if (key !== ed.warpKey || !ed.warped) {
    const { w, h } = outputSize(ed.quad, ed.settings.paper, PREVIEW_DPI);
    ed.warped = warpDocument(ed.src, ed.quad, w, h);
    ed.warpKey = key;
  }
  release(ed.preview);
  ed.preview = finishPreview(ed.warped, ed.settings);
  layoutStage();
}

function syncControls() {
  if (!ed) return;
  const { filter, paper } = ed.settings;
  document.querySelectorAll<HTMLElement>('#filterRow [data-filter]').forEach(b =>
    b.setAttribute('aria-checked', String(b.dataset.filter === filter)));
  document.querySelectorAll<HTMLElement>('#paperSeg [data-paper]').forEach(b =>
    b.setAttribute('aria-checked', String(b.dataset.paper === paper)));
}

$('#filterRow').addEventListener('click', e => {
  const b = (e.target as Element).closest<HTMLElement>('[data-filter]');
  if (!b || !ed) return;
  ed.settings.filter = b.dataset.filter as FilterMode;
  syncControls();
  updatePreview();
});
$('#paperSeg').addEventListener('click', e => {
  const b = (e.target as Element).closest<HTMLElement>('[data-paper]');
  if (!b || !ed) return;
  ed.settings.paper = b.dataset.paper as Paper;
  syncControls();
  updatePreview();
});
$('#rotL').addEventListener('click', () => { if (ed) { ed.settings.rot = (ed.settings.rot + 270) % 360; updatePreview(); } });
$('#rotR').addEventListener('click', () => { if (ed) { ed.settings.rot = (ed.settings.rot + 90) % 360; updatePreview(); } });

$('#edBack').addEventListener('click', () => {
  if (ed?.step === 2) setStep(1);
  else closeEditor();
});

$('#edNext').addEventListener('click', async () => {
  if (!ed) return;
  if (ed.step === 1) {
    if (!isConvex(ed.quad)) { toast('테두리가 꼬였어요. 모서리 위치를 확인해 주세요.'); return; }
    busy('보정 중…');
    await nextFrame();
    setStep(2);
    busy();
    return;
  }
  busy('페이지 만드는 중…');
  await nextFrame();
  const { page, isNew, src, settings } = ed;
  page.quad = orderQuad(ed.quad);
  page.settings = { ...settings };
  state.defaults.filter = settings.filter;
  state.defaults.paper = settings.paper;
  await renderOutput(page, src);
  if (isNew) state.pages.push(page);
  closeEditor();
  busy();
  renderList();
  if (isNew) drop.scrollTo({ top: 1e6, behavior: 'smooth' });
});

// ---------------------------------------------------------------- PDF 내보내기

const dlg = $<HTMLDialogElement>('#exportDlg');
const fileNameInput = $<HTMLInputElement>('#fileName');

function defaultName() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `스캔_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

$('#exportBtn').addEventListener('click', () => {
  const bytes = state.pages.reduce((s, p) => s + (p.out?.blob.size ?? 0), 0);
  fileNameInput.value = defaultName();
  $('#exportInfo').textContent = `${state.pages.length}페이지 · 약 ${(bytes / 1048576).toFixed(1)}MB`;
  const probe = new File([''], 'a.pdf', { type: 'application/pdf' });
  $('#shareBtn').hidden = !navigator.canShare?.({ files: [probe] });
  dlg.showModal();
});

async function makePdf() {
  let name = (fileNameInput.value.trim() || defaultName()).replace(/[\\/:*?"<>|]/g, '_');
  const title = name.replace(/\.pdf$/i, '');
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const pages = await Promise.all(state.pages.filter(p => p.out).map(async p => {
    const o = p.out!;
    return { jpeg: new Uint8Array(await o.blob.arrayBuffer()), w: o.w, h: o.h, pw: o.pw, ph: o.ph };
  }));
  return { name, blob: buildPdf(pages, title) };
}

$('#saveBtn').addEventListener('click', async () => {
  const { name, blob } = await makePdf();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  dlg.close();
  toast(`${name} 저장됨`);
});

$('#shareBtn').addEventListener('click', async () => {
  const { name, blob } = await makePdf();
  try {
    await navigator.share({ files: [new File([blob], name, { type: 'application/pdf' })], title: name });
    dlg.close();
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) toast('공유하지 못했습니다');
  }
});

renderList();

if (import.meta.env.DEV) {
  Object.assign(window, { __scanner: { state, addFiles } });
}
