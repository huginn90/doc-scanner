(() => {
  const $ = s => document.querySelector(s);
  const PREVIEW_DPI = 110;
  const JPEG_QUALITY = 0.88;

  const state = {
    pages: [],
    dpi: 200,
    defaults: { paper: 'a4', filter: 'enhance', rot: 0 },
  };
  let nextId = 1;

  // ---------------------------------------------------------------- 공통 유틸

  // 로딩 표시가 그려지도록 한 프레임 양보. 백그라운드 탭에서는 rAF가 멈추므로 타이머로도 보장
  const nextFrame = () => new Promise(resolve => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
  const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

  function busy(text) {
    $('#busyText').textContent = text || '처리 중…';
    $('#busy').hidden = !text;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // EXIF 회전을 반영해 디코딩하고, 메모리 보호를 위해 긴 변 4096px로 제한
  async function decodeImage(blob, maxSide = 4096) {
    let img, cleanup = () => {};
    try {
      img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      cleanup = () => img.close();
    } catch {
      const url = URL.createObjectURL(blob);
      img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error('이미지를 열 수 없습니다'));
        el.src = url;
      });
      cleanup = () => URL.revokeObjectURL(url);
    }
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const c = IP.canvas(w0 * s, h0 * s);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    cleanup();
    return c;
  }

  async function renderPage(page, src) {
    const c = IP.render(src, page.quad, page.settings, state.dpi);
    const w = c.width, h = c.height;
    const [pw, ph] = IP.pageSizePt(w, h, page.settings.paper);
    const blob = await toBlob(c, 'image/jpeg', JPEG_QUALITY);

    const ts = Math.min(1, 320 / Math.max(c.width, c.height));
    const t = IP.canvas(c.width * ts, c.height * ts);
    const tcx = t.getContext('2d');
    tcx.imageSmoothingQuality = 'high';
    tcx.drawImage(c, 0, 0, t.width, t.height);
    const thumbBlob = await toBlob(t, 'image/jpeg', 0.8);
    IP.release(t);
    IP.release(c);

    if (page.thumb) URL.revokeObjectURL(page.thumb);
    page.thumb = URL.createObjectURL(thumbBlob);
    page.out = { blob, w, h, pw, ph };
  }

  // ---------------------------------------------------------------- 사진 추가

  async function addFiles(files) {
    files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) return;

    if (files.length === 1) {
      busy('문서를 찾는 중…');
      await nextFrame();
      try {
        const src = await decodeImage(files[0]);
        const { quad, found } = IP.detect(src);
        const page = { id: nextId++, source: files[0], quad, settings: { ...state.defaults } };
        busy();
        openEditor(page, src, true);
        if (!found) toast('문서를 찾지 못했어요. 모서리를 직접 맞춰 주세요.');
      } catch (e) {
        busy();
        toast(e.message || '이미지를 처리하지 못했습니다');
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
        const { quad, found } = IP.detect(src);
        if (!found) missed++;
        const page = { id: nextId++, source: files[i], quad, settings: { ...state.defaults } };
        await renderPage(page, src);
        IP.release(src);
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

  $('#camInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  $('#fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

  const drop = $('#dropZone');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });

  // ---------------------------------------------------------------- 페이지 목록

  const ICONS = {
    left: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    right: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    rot: '<path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 9a8 8 0 1 0-1.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    del: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICONS[name]}</svg>`;

  function renderList() {
    const n = state.pages.length;
    $('#empty').hidden = n > 0;
    $('#exportBtn').disabled = n === 0;
    $('#exportBtn').textContent = n ? `PDF 만들기 (${n})` : 'PDF 만들기';
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
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('.page');
    const idx = state.pages.findIndex(p => p.id === Number(li.dataset.id));
    const page = state.pages[idx];
    const act = btn.dataset.act;

    if (act === 'left' || act === 'right') {
      const to = act === 'left' ? idx - 1 : idx + 1;
      [state.pages[idx], state.pages[to]] = [state.pages[to], state.pages[idx]];
      renderList();
    } else if (act === 'del') {
      if (!confirm(`${idx + 1}페이지를 삭제할까요?`)) return;
      URL.revokeObjectURL(page.thumb);
      state.pages.splice(idx, 1);
      renderList();
    } else if (act === 'rot') {
      busy('회전 중…');
      await nextFrame();
      const src = await decodeImage(page.source);
      page.settings.rot = (page.settings.rot + 90) % 360;
      await renderPage(page, src);
      IP.release(src);
      busy();
      renderList();
    } else if (act === 'edit') {
      busy('불러오는 중…');
      await nextFrame();
      const src = await decodeImage(page.source);
      busy();
      openEditor(page, src, false);
    }
  });

  $('#dpiSel').addEventListener('change', async e => {
    state.dpi = Number(e.target.value);
    for (let i = 0; i < state.pages.length; i++) {
      busy(`화질 적용 중… ${i + 1} / ${state.pages.length}`);
      await nextFrame();
      const src = await decodeImage(state.pages[i].source);
      await renderPage(state.pages[i], src);
      IP.release(src);
    }
    busy();
    renderList();
  });

  window.addEventListener('beforeunload', e => {
    if (state.pages.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- 편집기

  const stage = $('#stage');
  const edCanvas = $('#edCanvas');
  const overlay = $('#overlay');
  const loupe = $('#loupe');
  const SVGNS = 'http://www.w3.org/2000/svg';

  let ed = null;
  let view = { s: 1, ox: 0, oy: 0 };

  function openEditor(page, src, isNew) {
    ed = {
      page, src, isNew,
      quad: page.quad.map(p => ({ ...p })),
      settings: { ...page.settings },
      step: 1,
      warped: null, warpKey: '', preview: null,
    };
    $('#editor').hidden = false;
    buildOverlay();
    setStep(1);
  }

  function closeEditor() {
    IP.release(ed.src);
    IP.release(ed.warped);
    IP.release(ed.preview);
    ed = null;
    $('#editor').hidden = true;
  }

  function setStep(step) {
    ed.step = step;
    document.querySelectorAll('.ed-tools').forEach(el => (el.hidden = Number(el.dataset.step) !== step));
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
    const cx = edCanvas.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, edCanvas.width, edCanvas.height);
    if (ed.step === 1) drawOverlay();
  }
  window.addEventListener('resize', layoutStage);

  // 오버레이: 바깥 음영, 테두리, 모서리 4개 + 변 중앙 4개 핸들
  function buildOverlay() {
    overlay.innerHTML = '';
    const el = (tag, attrs, parent = overlay) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      parent.appendChild(e);
      return e;
    };
    el('path', { class: 'shade', 'fill-rule': 'evenodd' });
    el('polygon', { class: 'edge' });
    for (let i = 0; i < 4; i++) {
      const g = el('g', { 'data-kind': 'mid', 'data-i': i });
      el('circle', { class: 'hit', r: 20 }, g);
      el('rect', { class: 'bar', rx: 4 }, g);
    }
    for (let i = 0; i < 4; i++) {
      const g = el('g', { 'data-kind': 'corner', 'data-i': i });
      el('circle', { class: 'hit', r: 26 }, g);
      el('circle', { class: 'dot', r: 10 }, g);
    }
  }

  const toView = p => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });

  function drawOverlay() {
    const r = stage.getBoundingClientRect();
    const q = ed.quad.map(toView);
    const pts = q.map(p => `${p.x},${p.y}`).join(' ');
    overlay.querySelector('.shade').setAttribute('d',
      `M0 0H${r.width}V${r.height}H0Z M${q.map(p => `${p.x} ${p.y}`).join(' L')}Z`);
    overlay.querySelector('.edge').setAttribute('points', pts);
    overlay.classList.toggle('invalid', !IP.isConvex(ed.quad));
    overlay.querySelectorAll('[data-kind="corner"]').forEach(g => {
      const p = q[g.dataset.i];
      g.setAttribute('transform', `translate(${p.x} ${p.y})`);
    });
    overlay.querySelectorAll('[data-kind="mid"]').forEach(g => {
      const i = Number(g.dataset.i), a = q[i], b = q[(i + 1) % 4];
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      g.setAttribute('transform', `translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${ang})`);
      const bar = g.querySelector('.bar');
      bar.setAttribute('x', -14); bar.setAttribute('y', -4);
      bar.setAttribute('width', 28); bar.setAttribute('height', 8);
    });
  }

  let drag = null;
  overlay.addEventListener('pointerdown', e => {
    const g = e.target.closest('[data-kind]');
    if (!g || !ed) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    drag = {
      id: e.pointerId, g, kind: g.dataset.kind, i: Number(g.dataset.i),
      sx: e.clientX, sy: e.clientY, start: ed.quad.map(p => ({ ...p })),
    };
    g.classList.add('active');
    onDrag(e);
  });
  overlay.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) onDrag(e); });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.g.classList.remove('active');
    drag = null;
    loupe.hidden = true;
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function onDrag(e) {
    const dx = (e.clientX - drag.sx) / view.s, dy = (e.clientY - drag.sy) / view.s;
    const W = ed.src.width, H = ed.src.height;
    const move = i => {
      ed.quad[i] = {
        x: Math.min(W, Math.max(0, drag.start[i].x + dx)),
        y: Math.min(H, Math.max(0, drag.start[i].y + dy)),
      };
    };
    let focus;
    if (drag.kind === 'corner') {
      move(drag.i);
      focus = ed.quad[drag.i];
    } else {
      const j = (drag.i + 1) % 4;
      move(drag.i); move(j);
      focus = { x: (ed.quad[drag.i].x + ed.quad[j].x) / 2, y: (ed.quad[drag.i].y + ed.quad[j].y) / 2 };
    }
    drawOverlay();
    drawLoupe(focus);
  }

  function drawLoupe(p) {
    const size = 130, dpr = window.devicePixelRatio || 1;
    const px = size * dpr;
    if (loupe.width !== px) { loupe.width = px; loupe.height = px; }
    const vp = toView(p);
    loupe.classList.toggle('right', vp.x < 180 && vp.y < 180);
    loupe.hidden = false;

    const half = size / (view.s * 3) / 2; // 화면 대비 3배 확대
    const cx = loupe.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, px, px);
    cx.drawImage(ed.src, p.x - half, p.y - half, half * 2, half * 2, 0, 0, px, px);
    const map = q => ({ x: (q.x - p.x + half) / (half * 2) * px, y: (q.y - p.y + half) / (half * 2) * px });
    cx.strokeStyle = '#3b82f6';
    cx.lineWidth = 2 * dpr;
    cx.beginPath();
    ed.quad.map(map).forEach((q, i) => (i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y)));
    cx.closePath();
    cx.stroke();
    cx.strokeStyle = 'rgba(255,255,255,.9)';
    cx.lineWidth = 1 * dpr;
    cx.beginPath();
    cx.moveTo(px / 2, px / 2 - 12 * dpr); cx.lineTo(px / 2, px / 2 + 12 * dpr);
    cx.moveTo(px / 2 - 12 * dpr, px / 2); cx.lineTo(px / 2 + 12 * dpr, px / 2);
    cx.stroke();
  }

  $('#autoBtn').addEventListener('click', () => {
    const { quad, found } = IP.detect(ed.src);
    ed.quad = quad;
    drawOverlay();
    if (!found) toast('문서를 찾지 못했어요. 직접 맞춰 주세요.');
  });
  $('#fullBtn').addEventListener('click', () => {
    ed.quad = IP.defaultQuad(ed.src.width, ed.src.height, 0);
    drawOverlay();
  });

  // 2단계 미리보기: 원근 보정 결과를 캐시하고 필터/회전만 다시 적용
  function updatePreview() {
    const key = JSON.stringify([ed.quad, ed.settings.paper]);
    if (key !== ed.warpKey) {
      IP.release(ed.warped);
      const { w, h } = IP.outputSize(ed.quad, ed.settings.paper, PREVIEW_DPI);
      ed.warped = IP.warp(ed.src, ed.quad, w, h);
      ed.warpKey = key;
    }
    const c = IP.canvas(ed.warped.width, ed.warped.height);
    c.getContext('2d').drawImage(ed.warped, 0, 0);
    IP.applyFilter(c, ed.settings.filter);
    IP.release(ed.preview);
    ed.preview = IP.rotate(c, ed.settings.rot);
    layoutStage();
  }

  function syncControls() {
    document.querySelectorAll('#filterRow [data-filter]').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.filter === ed.settings.filter)));
    document.querySelectorAll('#paperSeg [data-paper]').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.paper === ed.settings.paper)));
  }

  $('#filterRow').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    ed.settings.filter = b.dataset.filter;
    syncControls();
    updatePreview();
  });
  $('#paperSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-paper]');
    if (!b) return;
    ed.settings.paper = b.dataset.paper;
    syncControls();
    updatePreview();
  });
  $('#rotL').addEventListener('click', () => { ed.settings.rot = (ed.settings.rot + 270) % 360; updatePreview(); });
  $('#rotR').addEventListener('click', () => { ed.settings.rot = (ed.settings.rot + 90) % 360; updatePreview(); });

  $('#edBack').addEventListener('click', () => {
    if (ed.step === 2) setStep(1);
    else closeEditor();
  });

  $('#edNext').addEventListener('click', async () => {
    if (ed.step === 1) {
      if (!IP.isConvex(ed.quad)) { toast('테두리가 꼬였어요. 모서리 위치를 확인해 주세요.'); return; }
      busy('보정 중…');
      await nextFrame();
      setStep(2);
      busy();
      return;
    }
    busy('페이지 만드는 중…');
    await nextFrame();
    const { page, isNew } = ed;
    page.quad = IP.orderQuad(ed.quad);
    page.settings = { ...ed.settings };
    state.defaults.filter = ed.settings.filter;
    state.defaults.paper = ed.settings.paper;
    await renderPage(page, ed.src);
    if (isNew) state.pages.push(page);
    closeEditor();
    busy();
    renderList();
    if (isNew) $('#dropZone').scrollTo({ top: 1e6, behavior: 'smooth' });
  });

  // ---------------------------------------------------------------- PDF 내보내기

  const dlg = $('#exportDlg');

  function defaultName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `스캔_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  $('#exportBtn').addEventListener('click', () => {
    const bytes = state.pages.reduce((s, p) => s + p.out.blob.size, 0);
    $('#fileName').value = defaultName();
    $('#exportInfo').textContent = `${state.pages.length}페이지 · 약 ${(bytes / 1048576).toFixed(1)}MB`;
    $('#shareBtn').hidden = !(navigator.canShare &&
      navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] }));
    dlg.showModal();
  });

  async function makePdf() {
    let name = ($('#fileName').value.trim() || defaultName()).replace(/[\\/:*?"<>|]/g, '_');
    const title = name.replace(/\.pdf$/i, '');
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    const pages = await Promise.all(state.pages.map(async p => ({
      jpeg: new Uint8Array(await p.out.blob.arrayBuffer()),
      w: p.out.w, h: p.out.h, pw: p.out.pw, ph: p.out.ph,
    })));
    return { name, blob: PDF.build(pages, title) };
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
      if (e.name !== 'AbortError') toast('공유하지 못했습니다');
    }
  });

  renderList();

  // 테스트/디버그용
  window.__scanner = { state, addFiles };
})();
