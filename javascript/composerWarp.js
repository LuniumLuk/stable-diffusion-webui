/*
 * Composer image warp engine.
 *
 * Three deformers share one normalized coordinate space ([0,1], y down) so a
 * warp survives layer scaling, rotation and mirroring:
 *   - grid   : Catmull-Rom control grid (mesh warp)
 *   - points : radial control points with a smooth falloff
 *   - local  : brush driven displacement field (push / vertical stretch)
 *
 * The deformed mesh is rasterized on the GPU (WebGL) so dragging stays
 * interactive even for large layers. Callers that only need the math can use
 * sample()/buildMesh() without a renderer.
 */
(function () {
  "use strict";

  const MESH_RES = 48;
  const LOCAL_RES = 32;

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function identityGrid(cols, rows) {
    const grid = [];
    for (let r = 0; r <= rows; r++) {
      const row = [];
      for (let c = 0; c <= cols; c++) {
        row.push({ x: c / cols, y: r / rows });
      }
      grid.push(row);
    }
    return grid;
  }

  function createWarpState(opts) {
    opts = opts || {};
    const cols = Math.round(clamp(num(opts.cols, 4), 1, 16));
    const rows = Math.round(clamp(num(opts.rows, 4), 1, 16));
    const res = LOCAL_RES;
    return {
      version: 1,
      mode: opts.mode === "points" || opts.mode === "local" ? opts.mode : "grid",
      cols: cols,
      rows: rows,
      grid: identityGrid(cols, rows),
      points: [],
      pointRadius: clamp(num(opts.pointRadius, 0.3), 0.02, 1),
      radius: clamp(num(opts.radius, 0.18), 0.01, 1),
      strength: clamp(num(opts.strength, 1), 0.05, 3),
      localMode: opts.localMode === "stretchY" ? "stretchY" : "push",
      res: res,
      disp: new Float32Array((res + 1) * (res + 1) * 2),
      rev: 0,
    };
  }

  function cloneWarp(warp) {
    if (!warp) return null;
    return {
      version: 1,
      mode: warp.mode,
      cols: warp.cols,
      rows: warp.rows,
      grid: (warp.grid || []).map(function (row) {
        return row.map(function (p) { return { x: p.x, y: p.y }; });
      }),
      points: (warp.points || []).map(function (p) {
        return { id: p.id, x0: p.x0, y0: p.y0, x: p.x, y: p.y };
      }),
      pointRadius: warp.pointRadius,
      radius: warp.radius,
      strength: warp.strength,
      localMode: warp.localMode,
      res: warp.res || LOCAL_RES,
      disp: new Float32Array(warp.disp || 0),
      rev: warp.rev || 0,
    };
  }

  function resetWarp(warp) {
    if (!warp) return;
    const res = warp.res || LOCAL_RES;
    warp.grid = identityGrid(warp.cols, warp.rows);
    warp.points = [];
    warp.disp = new Float32Array((res + 1) * (res + 1) * 2);
    warp.rev = (warp.rev || 0) + 1;
  }

  function warpIsIdentity(warp) {
    if (!warp) return true;
    if (warp.mode === "grid") {
      const cols = warp.cols;
      const rows = warp.rows;
      const grid = warp.grid;
      if (!grid || grid.length !== rows + 1) return true;
      for (let r = 0; r <= rows; r++) {
        const row = grid[r];
        if (!row || row.length !== cols + 1) return true;
        for (let c = 0; c <= cols; c++) {
          if (Math.abs(row[c].x - c / cols) > 1e-5 || Math.abs(row[c].y - r / rows) > 1e-5) {
            return false;
          }
        }
      }
      return true;
    }
    if (warp.mode === "points") {
      return !(warp.points || []).some(function (p) {
        return Math.abs(p.x - p.x0) > 1e-5 || Math.abs(p.y - p.y0) > 1e-5;
      });
    }
    if (warp.mode === "local") {
      const disp = warp.disp;
      if (!disp) return true;
      for (let i = 0; i < disp.length; i++) {
        if (Math.abs(disp[i]) > 1e-5) return false;
      }
      return true;
    }
    return true;
  }

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  function sampleGrid(warp, u, v) {
    const cols = Math.max(1, warp.cols | 0);
    const rows = Math.max(1, warp.rows | 0);
    const grid = warp.grid;
    if (!grid || grid.length !== rows + 1) return { x: u, y: v };

    const gx = clamp01(u) * cols;
    const gy = clamp01(v) * rows;
    const cx = Math.min(cols - 1, Math.floor(gx));
    const cy = Math.min(rows - 1, Math.floor(gy));
    const tx = gx - cx;
    const ty = gy - cy;

    const c0 = Math.max(0, cx - 1);
    const c1 = cx;
    const c2 = Math.min(cols, cx + 1);
    const c3 = Math.min(cols, cx + 2);
    const r0 = Math.max(0, cy - 1);
    const r1 = cy;
    const r2 = Math.min(rows, cy + 1);
    const r3 = Math.min(rows, cy + 2);

    const row0 = grid[r0];
    const row1 = grid[r1];
    const row2 = grid[r2];
    const row3 = grid[r3];

    const x0 = catmullRom(row0[c0].x, row0[c1].x, row0[c2].x, row0[c3].x, tx);
    const x1 = catmullRom(row1[c0].x, row1[c1].x, row1[c2].x, row1[c3].x, tx);
    const x2 = catmullRom(row2[c0].x, row2[c1].x, row2[c2].x, row2[c3].x, tx);
    const x3 = catmullRom(row3[c0].x, row3[c1].x, row3[c2].x, row3[c3].x, tx);
    const y0 = catmullRom(row0[c0].y, row0[c1].y, row0[c2].y, row0[c3].y, tx);
    const y1 = catmullRom(row1[c0].y, row1[c1].y, row1[c2].y, row1[c3].y, tx);
    const y2 = catmullRom(row2[c0].y, row2[c1].y, row2[c2].y, row2[c3].y, tx);
    const y3 = catmullRom(row3[c0].y, row3[c1].y, row3[c2].y, row3[c3].y, tx);

    return {
      x: catmullRom(x0, x1, x2, x3, ty),
      y: catmullRom(y0, y1, y2, y3, ty),
    };
  }

  function samplePoints(warp, u, v, wpx, hpx) {
    const points = warp.points || [];
    if (points.length === 0) return { x: u, y: v };

    const diagonal = Math.hypot(wpx, hpx) || 1;
    const radiusPx = Math.max(0.02, num(warp.pointRadius, 0.3)) * diagonal;
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const d = Math.hypot((u - p.x0) * wpx, (v - p.y0) * hpx);
      if (d >= radiusPx) continue;
      const t = d / radiusPx;
      const f = 1 - t * t;
      const w = f * f;
      sumX += (p.x - p.x0) * w;
      sumY += (p.y - p.y0) * w;
      sumW += w;
    }

    if (sumW <= 1e-6) return { x: u, y: v };
    const denom = Math.max(1, sumW);
    return { x: u + sumX / denom, y: v + sumY / denom };
  }

  function sampleLocal(warp, u, v) {
    const res = Math.max(1, warp.res || LOCAL_RES);
    const disp = warp.disp;
    if (!disp || disp.length < (res + 1) * (res + 1) * 2) return { x: u, y: v };

    const gx = clamp01(u) * res;
    const gy = clamp01(v) * res;
    const x0 = Math.min(res - 1, Math.floor(gx));
    const y0 = Math.min(res - 1, Math.floor(gy));
    const tx = gx - x0;
    const ty = gy - y0;

    const stride = (res + 1) * 2;
    const i00 = y0 * stride + x0 * 2;
    const i10 = i00 + 2;
    const i01 = i00 + stride;
    const i11 = i01 + 2;

    const ax = disp[i00];
    const ay = disp[i00 + 1];
    const bx = disp[i10];
    const by = disp[i10 + 1];
    const cx = disp[i01];
    const cy = disp[i01 + 1];
    const dx = disp[i11];
    const dy = disp[i11 + 1];

    const topX = ax + (bx - ax) * tx;
    const topY = ay + (by - ay) * tx;
    const botX = cx + (dx - cx) * tx;
    const botY = cy + (dy - cy) * tx;

    return {
      x: u + topX + (botX - topX) * ty,
      y: v + topY + (botY - topY) * ty,
    };
  }

  function sample(warp, u, v, wpx, hpx) {
    if (!warp) return { x: u, y: v };
    if (warp.mode === "points") return samplePoints(warp, u, v, wpx, hpx);
    if (warp.mode === "local") return sampleLocal(warp, u, v);
    return sampleGrid(warp, u, v);
  }

  function buildMesh(warp, wpx, hpx, res) {
    const n = Math.max(2, res || MESH_RES);
    const data = new Float32Array((n + 1) * (n + 1) * 4);
    let i = 0;
    for (let iy = 0; iy <= n; iy++) {
      const v = iy / n;
      for (let ix = 0; ix <= n; ix++) {
        const u = ix / n;
        const p = sample(warp, u, v, wpx, hpx);
        data[i++] = p.x;
        data[i++] = p.y;
        data[i++] = u;
        data[i++] = v;
      }
    }
    return data;
  }

  function addPoint(warp, u, v) {
    let nextId = 1;
    for (let i = 0; i < warp.points.length; i++) {
      nextId = Math.max(nextId, (warp.points[i].id | 0) + 1);
    }
    const point = {
      id: nextId,
      x0: clamp01(u),
      y0: clamp01(v),
      x: clamp01(u),
      y: clamp01(v),
    };
    warp.points.push(point);
    warp.rev = (warp.rev || 0) + 1;
    return point;
  }

  function findPointNear(warp, u, v, wpx, hpx, tolPx) {
    const points = warp.points || [];
    const tol = Math.max(1, tolPx || 10);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const d = Math.hypot((u - p.x) * wpx, (v - p.y) * hpx);
      if (d <= tol && d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  }

  function removePoint(warp, index) {
    if (index < 0 || index >= warp.points.length) return false;
    warp.points.splice(index, 1);
    warp.rev = (warp.rev || 0) + 1;
    return true;
  }

  /*
   * Apply one brush move to the local displacement field. Large pointer jumps
   * are split into sub-steps of at most a quarter brush radius so strokes
   * stay continuous at low frame rates.
   */
  function applyLocalDab(warp, from, to, anchor, wpx, hpx) {
    if (!warp || !warp.disp) return false;
    const res = Math.max(1, warp.res || LOCAL_RES);
    const radiusPx = Math.max(1, warp.radius * Math.min(wpx, hpx));
    const strength = clamp(warp.strength, 0.05, 3);
    const start = anchor || from;
    const dxPx = (to.u - from.u) * wpx;
    const dyPx = (to.v - from.v) * hpx;
    const distPx = Math.hypot(dxPx, dyPx);
    if (distPx < 0.01) return false;

    const steps = Math.max(1, Math.min(64, Math.ceil(distPx / (radiusPx * 0.25))));
    const stride = (res + 1) * 2;
    const disp = warp.disp;
    const stretch = warp.localMode === "stretchY";
    const duNorm = (to.u - from.u) / steps;
    const dvNorm = (to.v - from.v) / steps;
    // Stretch amount for each sub-step (drag up stretches, drag down squashes).
    const stretchK = stretch
      ? (-(dyPx / steps) / radiusPx) * 0.5 * strength
      : 0;
    let changed = false;

    for (let step = 1; step <= steps; step++) {
      const k = step / steps;
      const cu = from.u + (to.u - from.u) * k;
      const cv = from.v + (to.v - from.v) * k;

      for (let iy = 0; iy <= res; iy++) {
        const v = iy / res;
        const dy = (v - cv) * hpx;
        for (let ix = 0; ix <= res; ix++) {
          const u = ix / res;
          const dx = (u - cu) * wpx;
          const d = Math.hypot(dx, dy);
          if (d >= radiusPx) continue;
          const t = d / radiusPx;
          const f = 1 - t * t;
          const falloff = f * f;

          const idx = iy * stride + ix * 2;
          if (stretch) {
            // Scale vertical distance from the stroke anchor; no horizontal change.
            const anchorDy = (v - start.v) * hpx;
            disp[idx + 1] += (anchorDy * stretchK * falloff) / hpx;
          } else {
            disp[idx] += duNorm * falloff * strength;
            disp[idx + 1] += dvNorm * falloff * strength;
          }
          changed = true;
        }
      }
    }

    if (changed) warp.rev = (warp.rev || 0) + 1;
    return changed;
  }

  function createRenderer() {
    if (typeof document === "undefined") return null;

    let canvas;
    let gl;
    try {
      canvas = document.createElement("canvas");
      gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        antialias: true,
        depth: false,
        stencil: false,
      });
    } catch (e) {
      gl = null;
    }
    if (!gl) return null;

    const vertexSource = [
      "attribute vec2 a_pos;",
      "attribute vec2 a_uv;",
      "varying vec2 v_uv;",
      "void main() {",
      "  v_uv = a_uv;",
      "  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);",
      "}",
    ].join("\n");
    const fragmentSource = [
      "precision mediump float;",
      "uniform sampler2D u_tex;",
      "varying vec2 v_uv;",
      "void main() {",
      "  gl_FragColor = texture2D(u_tex, v_uv);",
      "}",
    ].join("\n");

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(log || "shader compile failed");
      }
      return shader;
    }

    let program;
    try {
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "program link failed");
      }
    } catch (e) {
      return null;
    }

    gl.useProgram(program);
    const aPos = gl.getAttribLocation(program, "a_pos");
    const aUv = gl.getAttribLocation(program, "a_uv");
    const uTex = gl.getUniformLocation(program, "u_tex");

    const posBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const indices = new Uint16Array(MESH_RES * MESH_RES * 6);
    let idx = 0;
    for (let iy = 0; iy < MESH_RES; iy++) {
      for (let ix = 0; ix < MESH_RES; ix++) {
        const a = iy * (MESH_RES + 1) + ix;
        const b = a + 1;
        const c = a + (MESH_RES + 1);
        const d = c + 1;
        indices[idx++] = a;
        indices[idx++] = b;
        indices[idx++] = d;
        indices[idx++] = a;
        indices[idx++] = d;
        indices[idx++] = c;
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // One texture per source image, keyed weakly so deleted layers can be
    // collected. The token invalidates the texture when the layer pixels are
    // modified in place (painting, cropping, ...).
    const textureCache = new WeakMap();
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

    function getTexture(img, token) {
      let entry = textureCache.get(img);
      if (!entry) {
        entry = { texture: gl.createTexture(), token: null };
        textureCache.set(img, entry);
      }
      if (entry.token !== token) {
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry.token = token;
      }
      return entry.texture;
    }

    function render(img, mesh, token) {
      if (!img) return null;
      const srcW = img.width || img.naturalWidth || 0;
      const srcH = img.height || img.naturalHeight || 0;
      if (!srcW || !srcH) return null;

      const scale = Math.min(1, maxTexture / Math.max(srcW, srcH));
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
      }

      gl.useProgram(program);
      gl.viewport(0, 0, outW, outH);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, getTexture(img, token));
      gl.uniform1i(uTex, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
      return canvas;
    }

    return {
      canvas: canvas,
      maxTexture: maxTexture,
      render: render,
    };
  }

  function renderWarped(renderer, img, warp, imageToken) {
    if (!renderer || !img || !warp || warpIsIdentity(warp)) return null;
    const wpx = img.width || img.naturalWidth || 1;
    const hpx = img.height || img.naturalHeight || 1;
    return renderer.render(img, buildMesh(warp, wpx, hpx), imageToken || 0);
  }

  window.ComposerWarp = {
    MESH_RES: MESH_RES,
    LOCAL_RES: LOCAL_RES,
    clamp01: clamp01,
    identityGrid: identityGrid,
    createWarpState: createWarpState,
    cloneWarp: cloneWarp,
    resetWarp: resetWarp,
    warpIsIdentity: warpIsIdentity,
    sample: sample,
    sampleGrid: sampleGrid,
    samplePoints: samplePoints,
    sampleLocal: sampleLocal,
    buildMesh: buildMesh,
    addPoint: addPoint,
    findPointNear: findPointNear,
    removePoint: removePoint,
    applyLocalDab: applyLocalDab,
    createRenderer: createRenderer,
    renderWarped: renderWarped,
  };
})();
