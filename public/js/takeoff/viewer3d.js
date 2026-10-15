// Interactive 3D Storefront, Curtain Wall & Elevation Viewer for Stellar Glass takeoffs.
// Includes a pure scene-geometry builder (build3DSceneSpec, testable in Node) and a browser WebGL
// viewer powered by Three.js from jsDelivr CDN with orbit/zoom controls and PNG snapshot export.
import { COMMERCIAL_SYSTEMS, storefrontBayBreakdown, openingLinearFeet } from '../calc.js';
import { fmtFtIn } from './dims.js';

export const FINISH_PRESETS = {
  clear: { id: 'clear', name: '#04 Clear Anodized', color: 0xcbd5e1, roughness: 0.32, metalness: 0.78 },
  bronze: { id: 'bronze', name: '#40 Dark Bronze Anodized', color: 0x3b2d26, roughness: 0.36, metalness: 0.72 },
  black: { id: 'black', name: 'Matte Black Anodized', color: 0x18181b, roughness: 0.45, metalness: 0.55 },
  champagne: { id: 'champagne', name: 'Champagne Anodized', color: 0xb8a992, roughness: 0.34, metalness: 0.75 },
};

export const GLASS_PRESETS = {
  clear: { id: 'clear', name: '1/4" Clear Tempered', color: 0xdbeafe, opacity: 0.34, reflectivity: 0.5 },
  lowe: { id: 'lowe', name: '1" Low-E Insulated (Blue-Green)', color: 0x38bdf8, opacity: 0.44, reflectivity: 0.75 },
  grey: { id: 'grey', name: '1" Solar Grey Insulated', color: 0x475569, opacity: 0.54, reflectivity: 0.65 },
  frosted: { id: 'frosted', name: 'Frosted / Acid-Etched Privacy', color: 0xf1f5f9, opacity: 0.78, reflectivity: 0.25 },
};

// Pure function: builds the 3D geometry specification (in real inches, Y up) for a list of takeoff openings.
export function build3DSceneSpec(rows, { system = 'sf175', finish = 'clear', glass = 'lowe', filterLabel = '' } = {}) {
  const sysDefault = COMMERCIAL_SYSTEMS[system] || COMMERCIAL_SYSTEMS.sf175;
  const active = (rows || [])
    .filter((r) => (r.qty > 0 || filterLabel) && r.widthIn > 0 && r.heightIn > 0)
    .filter((r) => !filterLabel || r.label === filterLabel);

  const assemblies = [];
  let cursorX = 0;
  const gapIn = 24; // 24" masonry pier between distinct window types in elevation lineup

  for (const row of active) {
    const sys = COMMERCIAL_SYSTEMS[row.system || sysDefault.id] || sysDefault;
    const bd = storefrontBayBreakdown(row, { system: sys.id });
    if (!bd) continue;

    const fw = bd.frameWidthIn;
    const fh = bd.frameHeightIn;
    const depth = sys.depthIn;
    const jW = sys.jambProfileIn;
    const hW = sys.headProfileIn;
    const sW = sys.sillProfileIn;
    const mW = sys.mullionProfileIn;
    const tW = sys.transomProfileIn;

    const members = [];
    const lites = [];

    // Outer frame members (in local assembly coordinates: x from 0..fw, y from 0..fh, z centered at 0)
    if (sW > 0) {
      members.push({ role: 'sill', x: fw / 2, y: sW / 2, z: 0, w: fw, h: sW, d: depth });
    }
    if (hW > 0) {
      members.push({ role: 'head', x: fw / 2, y: fh - hW / 2, z: 0, w: fw, h: hW, d: depth });
    }
    const innerH = Math.max(1, fh - sW - hW);
    if (jW > 0) {
      members.push({ role: 'left-jamb', x: jW / 2, y: sW + innerH / 2, z: 0, w: jW, h: innerH, d: depth });
      members.push({ role: 'right-jamb', x: fw - jW / 2, y: sW + innerH / 2, z: 0, w: jW, h: innerH, d: depth });
    }

    // Vertical intermediate mullions
    const bayCount = bd.bays;
    const clearW = fw - 2 * jW - (bayCount - 1) * mW;
    const bayW = clearW / bayCount;

    for (let b = 1; b < bayCount; b++) {
      const mx = jW + b * bayW + (b - 0.5) * mW;
      members.push({ role: 'mullion', x: mx, y: sW + innerH / 2, z: 0, w: mW, h: innerH, d: depth });
    }

    // Optional horizontal transom bar
    if (bd.hasTransom && tW > 0) {
      members.push({
        role: 'transom',
        x: fw / 2,
        y: bd.transomHeightIn,
        z: 0,
        w: Math.max(1, fw - 2 * jW),
        h: tW,
        d: depth,
      });
    }

    // Glass lites for each bay
    const glassThickness = sys.id === 'herculite' ? 0.5 : 1.0;
    for (let b = 0; b < bayCount; b++) {
      const lx = jW + b * (bayW + mW) + bayW / 2;
      if (bd.hasTransom) {
        const lowerH = bd.mainDloHeightIn;
        const lowerY = sW + lowerH / 2;
        lites.push({
          role: 'main',
          bay: b + 1,
          x: lx,
          y: lowerY,
          z: 0,
          w: bayW + 2 * sys.glassBiteIn,
          h: bd.glassCutHeightIn,
          dloW: bayW,
          dloH: lowerH,
          thickness: glassThickness,
        });
        const upperH = bd.transomDloHeightIn;
        const upperY = bd.transomHeightIn + tW / 2 + upperH / 2;
        lites.push({
          role: 'transom',
          bay: b + 1,
          x: lx,
          y: upperY,
          z: 0,
          w: bayW + 2 * sys.glassBiteIn,
          h: bd.transomGlassCutHeightIn,
          dloW: bayW,
          dloH: upperH,
          thickness: glassThickness,
        });
      } else {
        lites.push({
          role: 'main',
          bay: b + 1,
          x: lx,
          y: sW + innerH / 2,
          z: 0,
          w: bayW + 2 * sys.glassBiteIn,
          h: bd.glassCutHeightIn,
          dloW: bayW,
          dloH: innerH,
          thickness: glassThickness,
        });
      }
    }

    assemblies.push({
      label: row.label || '?',
      qty: bd.qty,
      offsetX: cursorX,
      offsetY: 0,
      frameWidthIn: fw,
      frameHeightIn: fh,
      depthIn: depth,
      breakdown: bd,
      members,
      lites,
    });

    cursorX += fw + gapIn;
  }

  const totalSpanX = assemblies.length ? cursorX - gapIn : 120;
  const maxHeightY = assemblies.length ? Math.max(...assemblies.map((a) => a.frameHeightIn)) : 96;
  const totals = openingLinearFeet(active, { system: sysDefault.id });

  return {
    system: sysDefault.id,
    finish: FINISH_PRESETS[finish] ? finish : 'clear',
    glass: GLASS_PRESETS[glass] ? glass : 'lowe',
    assemblies,
    totalSpanX,
    maxHeightY,
    totals,
  };
}

let threePromise = null;
function loadThree() {
  if (!threePromise) {
    threePromise = import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js').catch((err) => {
      threePromise = null;
      throw err;
    });
  }
  return threePromise;
}

// Opens an interactive 3D Storefront & Elevation viewer modal inside `hostEl`.
export async function open3DViewerModal(hostEl, { rows = [], system = 'sf175', onUpdateRow = null } = {}) {
  let dlg = hostEl.querySelector('dialog.tk-3d-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'tk-3d-dlg';
    hostEl.append(dlg);
  }

  const validRows = rows.filter((r) => r.widthIn > 0 && r.heightIn > 0);
  if (!validRows.length) {
    // Provide a default sample storefront opening if user clicks 3D before adding sizes
    validRows.push({ label: 'A1', qty: 1, widthIn: 120, heightIn: 96, bays: 3, transomHeightIn: 0, system });
  }

  let curSystem = system || validRows[0]?.system || 'sf175';
  let curFinish = 'clear';
  let curGlass = 'lowe';
  let curFilter = '';

  dlg.innerHTML = `
    <div class="tk-3d-wrap">
      <div class="row between tk-3d-head">
        <div>
          <h2>3D Storefront &amp; Elevation Model</h2>
          <p class="small muted">Drag to orbit · Scroll/pinch to zoom · Shift+drag to pan · Inspect mullions, transoms &amp; glass cut sizes</p>
        </div>
        <div class="row">
          <button type="button" class="btn small" data-3d-reset>Reset view</button>
          <button type="button" class="btn small primary" data-3d-snap>Save PNG snapshot</button>
          <button type="button" class="icon" data-3d-close aria-label="Close">✕</button>
        </div>
      </div>
      <div class="row tk-3d-controls">
        <label class="small">Framing system
          <select data-3d-sys>
            ${Object.values(COMMERCIAL_SYSTEMS).map((s) => `<option value="${s.id}" ${s.id === curSystem ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </label>
        <label class="small">Finish
          <select data-3d-finish>
            ${Object.values(FINISH_PRESETS).map((f) => `<option value="${f.id}" ${f.id === curFinish ? 'selected' : ''}>${f.name}</option>`).join('')}
          </select>
        </label>
        <label class="small">Glass infill
          <select data-3d-glass>
            ${Object.values(GLASS_PRESETS).map((g) => `<option value="${g.id}" ${g.id === curGlass ? 'selected' : ''}>${g.name}</option>`).join('')}
          </select>
        </label>
        <label class="small">Opening
          <select data-3d-filter>
            <option value="">All openings (${validRows.length})</option>
            ${validRows.map((r) => `<option value="${r.label}">${r.label || '?'} (${fmtFtIn(r.widthIn)} × ${fmtFtIn(r.heightIn)})</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="tk-3d-stage" data-3d-stage>
        <div class="tk-3d-loading" data-3d-status>Loading 3D engine…</div>
      </div>
      <div class="tk-3d-summary" data-3d-summary></div>
    </div>
  `;

  if (!dlg.open) dlg.showModal();

  const stage = dlg.querySelector('[data-3d-stage]');
  const statusEl = dlg.querySelector('[data-3d-status]');
  const summaryEl = dlg.querySelector('[data-3d-summary]');

  let THREE;
  try {
    THREE = await loadThree();
  } catch (err) {
    statusEl.textContent = `3D WebGL viewer requires an internet connection to load Three.js (${err?.message || 'offline'}).`;
    dlg.querySelector('[data-3d-close]').onclick = () => dlg.close();
    return;
  }
  statusEl?.remove();

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0f172a, 1);
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 10000);

  // Studio + sun lighting so anodized aluminum and glass reflections read clearly
  const hemi = new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.15);
  scene.add(hemi);
  const dir1 = new THREE.DirectionalLight(0xffffff, 1.35);
  dir1.position.set(180, 260, 320);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x93c5fd, 0.65);
  dir2.position.set(-200, 120, -240);
  scene.add(dir2);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  // Simple spherical orbit + pan camera controller
  const camState = {
    theta: 0.32,
    phi: 1.38,
    distance: 240,
    targetX: 0,
    targetY: 48,
    targetZ: 0,
  };

  function updateCamera() {
    const sinPhi = Math.sin(camState.phi);
    camera.position.set(
      camState.targetX + camState.distance * sinPhi * Math.sin(camState.theta),
      camState.targetY + camState.distance * Math.cos(camState.phi),
      camState.targetZ + camState.distance * sinPhi * Math.cos(camState.theta),
    );
    camera.lookAt(camState.targetX, camState.targetY, camState.targetZ);
  }

  function renderFrame() {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width || 760));
    const h = Math.max(280, Math.round(rect.height || 440));
    if (renderer.domElement.width !== w * renderer.getPixelRatio() || renderer.domElement.height !== h * renderer.getPixelRatio()) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    updateCamera();
    renderer.render(scene, camera);
  }

  function makeLabelSprite(text, bgColor = '#0f172a', borderColor = '#38bdf8') {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 112;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 100, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 34px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 56);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(42, 9.2, 1);
    return sprite;
  }

  function rebuildScene(resetCam = false) {
    while (rootGroup.children.length) rootGroup.remove(rootGroup.children[0]);

    const spec = build3DSceneSpec(validRows, {
      system: curSystem,
      finish: curFinish,
      glass: curGlass,
      filterLabel: curFilter,
    });

    const finPreset = FINISH_PRESETS[spec.finish] || FINISH_PRESETS.clear;
    const glsPreset = GLASS_PRESETS[spec.glass] || GLASS_PRESETS.lowe;

    const frameMat = new THREE.MeshStandardMaterial({
      color: finPreset.color,
      roughness: finPreset.roughness,
      metalness: finPreset.metalness,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.45 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: glsPreset.color,
      transparent: true,
      opacity: glsPreset.opacity,
      roughness: 0.08,
      metalness: 0.1,
      reflectivity: glsPreset.reflectivity,
      side: THREE.DoubleSide,
    });
    const glassEdgeMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 });

    // Ground slab & subtle grid centered under the lineup
    const centerX = spec.totalSpanX / 2;
    const slabW = Math.max(180, spec.totalSpanX + 96);
    const slabGeo = new THREE.BoxGeometry(slabW, 2, 72);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85, metalness: 0.05 });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(centerX, -1, 0);
    rootGroup.add(slab);

    const grid = new THREE.GridHelper(Math.max(240, slabW), Math.round(Math.max(240, slabW) / 12), 0x334155, 0x1e293b);
    grid.position.set(centerX, 0.05, 0);
    rootGroup.add(grid);

    for (const asm of spec.assemblies) {
      const asmGroup = new THREE.Group();
      asmGroup.position.set(asm.offsetX, asm.offsetY, 0);

      for (const m of asm.members) {
        const geo = new THREE.BoxGeometry(m.w, m.h, m.d);
        const mesh = new THREE.Mesh(geo, frameMat);
        mesh.position.set(m.x, m.y, m.z);
        asmGroup.add(mesh);

        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        edges.position.copy(mesh.position);
        asmGroup.add(edges);
      }

      for (const l of asm.lites) {
        const geo = new THREE.BoxGeometry(l.dloW, l.dloH, l.thickness);
        const mesh = new THREE.Mesh(geo, glassMat);
        mesh.position.set(l.x, l.y, l.z);
        asmGroup.add(mesh);

        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), glassEdgeMat);
        edges.position.copy(mesh.position);
        asmGroup.add(edges);
      }

      // Floating overhead callout badge with Mark, Quantity & Frame Size
      const badge = makeLabelSprite(
        `${asm.label} (×${asm.qty}) · ${fmtFtIn(asm.frameWidthIn)} × ${fmtFtIn(asm.frameHeightIn)}`,
      );
      badge.position.set(asm.frameWidthIn / 2, asm.frameHeightIn + 12, 0);
      asmGroup.add(badge);

      rootGroup.add(asmGroup);
    }

    if (resetCam) {
      camState.targetX = centerX;
      camState.targetY = spec.maxHeightY * 0.48;
      camState.targetZ = 0;
      camState.distance = Math.max(140, Math.max(spec.totalSpanX, spec.maxHeightY * 1.4) * 1.25);
      camState.theta = 0.28;
      camState.phi = 1.42;
    }

    // Render live cut-size and stock-length summary table below the 3D stage
    const firstAsm = spec.assemblies[0]?.breakdown;
    summaryEl.innerHTML = `
      <div class="tk-3d-stats">
        <div><span class="muted small">Glass Cut Size (per bay)</span><b>${firstAsm ? `${fmtFtIn(firstAsm.glassCutWidthIn)} × ${fmtFtIn(firstAsm.glassCutHeightIn)}` : '—'}</b></div>
        <div><span class="muted small">Daylight Opening (DLO)</span><b>${firstAsm ? `${fmtFtIn(firstAsm.bayDloWidthIn)} × ${fmtFtIn(firstAsm.mainDloHeightIn)}` : '—'}</b></div>
        <div><span class="muted small">Total Glass Lites</span><b>${spec.totals.totalLites} lites (${spec.totals.totalSqft} sq ft)</b></div>
        <div><span class="muted small">Framing Extrusions</span><b>${spec.totals.framingLf} LF (${spec.totals.stockLengths24Ft} × 24' S/L)</b></div>
        <div><span class="muted small">Perimeter Sealant</span><b>${spec.totals.sealantLf} LF (~${spec.totals.sealantTubes} tubes)</b></div>
      </div>
    `;

    renderFrame();
  }

  rebuildScene(true);

  // Pointer orbit & pan interaction
  let drag = null;
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.cursor = 'grab';

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    drag = {
      x: e.clientX,
      y: e.clientY,
      pan: e.shiftKey || e.button === 2 || e.button === 1,
      theta: camState.theta,
      phi: camState.phi,
      tx: camState.targetX,
      ty: camState.targetY,
    };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.pan) {
      const panScale = camState.distance * 0.0015;
      camState.targetX = drag.tx - dx * panScale;
      camState.targetY = Math.max(0, drag.ty + dy * panScale);
    } else {
      camState.theta = drag.theta - dx * 0.007;
      camState.phi = Math.max(0.2, Math.min(Math.PI - 0.15, drag.phi - dy * 0.007));
    }
    renderFrame();
  });
  const endDrag = () => {
    drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    camState.distance = Math.max(36, Math.min(3500, camState.distance * factor));
    renderFrame();
  }, { passive: false });

  // Controls event listeners
  dlg.querySelector('[data-3d-sys]').onchange = (e) => {
    curSystem = e.target.value;
    if (onUpdateRow) onUpdateRow(curSystem);
    rebuildScene(false);
  };
  dlg.querySelector('[data-3d-finish]').onchange = (e) => {
    curFinish = e.target.value;
    rebuildScene(false);
  };
  dlg.querySelector('[data-3d-glass]').onchange = (e) => {
    curGlass = e.target.value;
    rebuildScene(false);
  };
  dlg.querySelector('[data-3d-filter]').onchange = (e) => {
    curFilter = e.target.value;
    rebuildScene(true);
  };
  dlg.querySelector('[data-3d-reset]').onclick = () => rebuildScene(true);
  dlg.querySelector('[data-3d-snap]').onclick = () => {
    renderFrame();
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `storefront-3d-${curFilter || 'elevation'}.png`;
    a.click();
  };
  dlg.querySelector('[data-3d-close]').onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    renderer.dispose();
  }, { once: true });
}
