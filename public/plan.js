/*
 * plan.js: a published track, drawn as a plan.
 *
 * Every track on the board already ships a plan in the list payload: the
 * field size, the things that stand on it, and the flown line in flying
 * order. That is enough to draw the thing, and drawing it is free. The
 * alternative, which is what this page used to do, was to iframe the
 * simulator once per card and have it build an entire world to record a
 * thumbnail. Twelve tracks meant twelve worlds.
 *
 * The drawing speaks the track builder's own language, so a track looks
 * the same on the board as it does in the editor that made it: a cool
 * blueprint plate, a slate grid, the flown line, pale apertures across
 * the direction of travel, cream turn markers, a mint start. Waypoints
 * are omitted. They pin the line and nothing stands there.
 *
 * Local axes inside a mark, after translate and rotate(-yaw): local x is
 * the direction of travel through the element, local y is its width. That
 * falls out of the screen mapping, where world +y runs up the page, and it
 * is why a gate is drawn as a bar across local y rather than along it.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

/* The mount is darker than the plate on purpose. A track is drawn to its
 * own proportions, so a deep narrow field leaves margins, and those
 * margins have to read as the edge of a drawing rather than as an empty
 * part of the field. */
const C = {
  ground: '#080d12',
  plateTop: '#17232f',
  plateBottom: '#0d161e',
  gridMinor: 'rgba(157, 179, 200, 0.09)',
  gridMajor: 'rgba(157, 179, 200, 0.19)',
  bound: 'rgba(247, 232, 205, 0.5)',
  gate: '#dbe8f3',
  dive: '#7dffb4',
  diveFill: 'rgba(125, 255, 180, 0.14)',
  marker: 'rgba(247, 232, 205, 0.62)',
  cone: '#ffd45c',
  barrier: 'rgba(255, 125, 125, 0.45)',
  barrierEdge: 'rgba(255, 154, 154, 0.85)',
  start: '#7dffb4',
  path: 'rgba(255, 212, 92, 0.28)',
  pathCore: 'rgba(255, 212, 92, 0.88)',
  number: '#101a26',
  numberBg: '#f7e8cd',
  scale: 'rgba(157, 179, 200, 0.55)',
};

/* Metres. A thumbnail fattens a 5 ft opening so it still reads on a
 * hundred metre field. Types the drawer does not know stay off the
 * plate; the flown line is what makes two tracks look different. */
const GATE_W = 1.524;      /* 5 ft clear opening, the chapter standard */
const GATE_D = 0.36;       /* frame depth, enough to read as a solid */
const DIVE_W = 2.13;       /* 7 ft, flown through from above */
const BARRIER_W = 4;
const BARRIER_D = 1;
const PAD_ROW = 4.5;       /* four stands at 1.5 m spacing */

const LEVELS = {
  gate: 1,
  flaggedGate: 1,
  doubleStack: 2,
  flaggedDoubleStack: 2,
  ladder: 3,
  tower: 2,
};

const GRID_STEPS = [1, 2, 5, 10, 25, 50, 100];
const BAR_STEPS = [5, 10, 20, 25, 50, 100];

function pick(steps, minPx, perMetre) {
  for (const step of steps) {
    if (step * perMetre >= minPx) {
      return step;
    }
  }
  return steps[steps.length - 1];
}

/* A track reads as a shape long before anyone counts its gates, so the
 * fit keeps the field's own proportions and centres it in whatever box
 * the card gives it. */
function fit(plan, w, h, pad) {
  const fw = Math.max(1, Number(plan && plan.width) || 60);
  const fd = Math.max(1, Number(plan && plan.depth) || 40);
  const s = Math.min((w - pad * 2) / fw, (h - pad * 2) / fd);
  return {
    s,
    fw,
    fd,
    ox: (w - fw * s) / 2,
    oy: (h - fd * s) / 2,
  };
}

function plate(ctx, w, h, box) {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, box.oy, 0, box.oy + box.fd * box.s);
  g.addColorStop(0, C.plateTop);
  g.addColorStop(1, C.plateBottom);
  ctx.fillStyle = g;
  ctx.fillRect(box.ox, box.oy, box.fw * box.s, box.fd * box.s);
}

function grid(ctx, box) {
  const minor = pick(GRID_STEPS, 9, box.s);
  const major = minor * 5;
  const right = box.ox + box.fw * box.s;
  const bottom = box.oy + box.fd * box.s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.ox, box.oy, box.fw * box.s, box.fd * box.s);
  ctx.clip();
  for (let pass = 0; pass < 2; pass += 1) {
    const step = pass === 0 ? minor : major;
    ctx.strokeStyle = pass === 0 ? C.gridMinor : C.gridMajor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= box.fw + 0.001; x += step) {
      const px = Math.round(box.ox + x * box.s) + 0.5;
      ctx.moveTo(px, box.oy);
      ctx.lineTo(px, bottom);
    }
    for (let y = 0; y <= box.fd + 0.001; y += step) {
      const py = Math.round(bottom - y * box.s) + 0.5;
      ctx.moveTo(box.ox, py);
      ctx.lineTo(right, py);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = C.bound;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(box.ox) + 0.5,
    Math.round(box.oy) + 0.5,
    Math.round(box.fw * box.s) - 1,
    Math.round(box.fd * box.s) - 1,
  );
}

/*
 * A gate in plan is a bar across the direction of travel. It carries a
 * floor size because a championship field is over a hundred metres wide
 * and a true to scale 1.5 m opening would be two pixels of nothing. A
 * stack gets a deeper bar and, where there is room, one arc per level, so
 * a ladder is not a gate even in a thumbnail.
 */
function aperture(ctx, s, levels) {
  const half = Math.max(3.2, (GATE_W * 0.5) * s);
  const depth = Math.max(1.8, GATE_D * s) * (levels > 1 ? 1.8 : 1);
  ctx.beginPath();
  ctx.rect(-depth * 0.5, -half, depth, half * 2);
  ctx.fillStyle = C.gate;
  ctx.fill();
  if (levels > 1 && half > 8) {
    ctx.strokeStyle = C.gate;
    ctx.lineWidth = 1;
    for (let i = 1; i < levels; i += 1) {
      const r = depth * 0.5 + i * Math.max(2.5, s * 0.22);
      ctx.beginPath();
      ctx.arc(0, 0, r, -0.9, 0.9);
      ctx.stroke();
    }
  }
}

function diveGate(ctx, s) {
  const half = Math.max(3.5, (DIVE_W * 0.5) * s);
  ctx.beginPath();
  ctx.rect(-half, -half, half * 2, half * 2);
  ctx.fillStyle = C.diveFill;
  ctx.fill();
  ctx.strokeStyle = C.dive;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, half * 0.28), 0, Math.PI * 2);
  ctx.fillStyle = C.dive;
  ctx.fill();
}

/* Local +x is the barrier's heading, and its long side runs along it. The
 * axes used to be the other way round here, which stood every barrier on the
 * board a quarter turn out of the one the builder and the simulator draw:
 * scene.js lays the collider along (cos yaw, -sin yaw) and view2d.js gives
 * boxCorners the width as its along-yaw argument. */
function barrier(ctx, s, dims) {
  const w = Math.max(4, (dims && dims.w > 0 ? dims.w : BARRIER_W) * s);
  const h = Math.max(2, (dims && dims.d > 0 ? dims.d : BARRIER_D) * s);
  ctx.beginPath();
  ctx.rect(-w * 0.5, -h * 0.5, w, h);
  ctx.fillStyle = C.barrier;
  ctx.fill();
  ctx.strokeStyle = C.barrierEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function marker(ctx, s, cone) {
  const r = Math.max(1.6, s * 0.18);
  ctx.beginPath();
  if (cone) {
    ctx.moveTo(0, -r * 1.3);
    ctx.lineTo(r * 1.15, r * 0.9);
    ctx.lineTo(-r * 1.15, r * 0.9);
    ctx.closePath();
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = cone ? C.cone : C.marker;
  ctx.fill();
}

/* The start line, and which way the pack faces. Local +x is the launch
 * heading, so the chevron points down the first straight. */
function startPads(ctx, s) {
  const half = Math.max(5, (PAD_ROW * 0.5) * s);
  ctx.strokeStyle = C.start;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -half);
  ctx.lineTo(0, half);
  ctx.stroke();
  const tip = Math.max(6, s * 1.9);
  const wing = Math.max(4, s * 1.2);
  ctx.beginPath();
  ctx.moveTo(tip, 0);
  ctx.lineTo(tip - wing, -wing * 0.78);
  ctx.lineTo(tip - wing, wing * 0.78);
  ctx.closePath();
  ctx.fillStyle = C.start;
  ctx.fill();
}

function toScreen(box, x, y) {
  return {
    x: box.ox + (Number(x) || 0) * box.s,
    y: box.oy + (box.fd - (Number(y) || 0)) * box.s,
  };
}

function strokePoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
}

/*
 * The flown line, in flying order. Straight segments between the knots
 * the sequence already named: enough to read the lap as a shape, which
 * a scatter of gates never was. Consecutive knots that share a point
 * (a stack flown twice) are already collapsed in the payload. A circuit
 * closes back to the first gate when the last knot is not already there.
 */
function raceLine(ctx, box, path) {
  if (!path || path.length < 2) {
    return;
  }
  const pts = path.map((p) => toScreen(box, p.x, p.y));
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (Math.hypot(a.x - b.x, a.y - b.y) > Math.max(8, box.s * 2)) {
    pts.push(a);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.ox, box.oy, box.fw * box.s, box.fd * box.s);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const core = Math.max(1.4, Math.min(2.8, box.s * 0.38));
  ctx.strokeStyle = C.path;
  ctx.lineWidth = core + 2.4;
  strokePoly(ctx, pts);
  ctx.strokeStyle = C.pathCore;
  ctx.lineWidth = core;
  strokePoly(ctx, pts);
  ctx.restore();
}

function gateNumbers(ctx, box, numbers) {
  if (!numbers || !numbers.length) {
    return;
  }
  const r = Math.max(6, Math.min(9, box.s * 0.55));
  ctx.font = `600 ${Math.round(r * 1.15)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const mark of numbers) {
    const p = toScreen(box, mark.x, mark.y);
    /* Stacked upward when one structure is flown more than once, so a
     * ladder taken twice shows both of its numbers instead of hiding one
     * badge exactly behind the other. The builder stacks the same way. */
    const y = p.y - (Number(mark.stack) || 0) * (r * 2.1);
    ctx.beginPath();
    ctx.arc(p.x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = C.numberBg;
    ctx.fill();
    ctx.fillStyle = C.number;
    ctx.fillText(String(mark.n), p.x, y + 0.5);
  }
}

function scaleBar(ctx, box, w, h) {
  const metres = pick(BAR_STEPS, 44, box.s);
  const len = metres * box.s;
  if (len > w * 0.42) {
    return;
  }
  const x = w - 14 - len;
  const y = h - 16;
  ctx.strokeStyle = C.scale;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y - 3.5);
  ctx.lineTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + len + 0.5, y + 0.5);
  ctx.lineTo(x + len + 0.5, y - 3.5);
  ctx.stroke();
  ctx.fillStyle = C.scale;
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${metres} m`, x + len, y - 6);
}

/* Obstacles first, then markers, then the gates and the start, so the
 * things a pilot actually flies through are never underneath a flag. */
function order(type) {
  if (type === 'barrier') {
    return 0;
  }
  if (type === 'flag' || type === 'cone') {
    return 1;
  }
  if (type === 'startPads') {
    return 3;
  }
  return 2;
}

export function drawPlan(canvas, plan, options = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width || canvas.clientWidth || 0);
  const h = Math.round(rect.height || canvas.clientHeight || 0);
  if (w < 8 || h < 8) {
    return false;
  }
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return false;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const box = fit(plan, w, h, options.pad == null ? Math.max(6, w * 0.022) : options.pad);
  plate(ctx, w, h, box);
  grid(ctx, box);
  if (!plan) {
    return true;
  }
  raceLine(ctx, box, plan.path);
  const marks = [...(plan.marks || [])].sort((a, b) => order(a.type) - order(b.type));
  for (const mark of marks) {
    const type = String(mark.type || '');
    /* Waypoints used to fall through to aperture() and stand in as
     * gates. Anything we do not have a drawing for stays off the plate. */
    if (!type || type === 'waypoint' || type === 'label') {
      continue;
    }
    const known = type === 'startPads' || type === 'barrier' || type === 'flag'
      || type === 'cone' || type === 'diveGate' || LEVELS[type];
    if (!known) {
      continue;
    }
    const p = toScreen(box, mark.x, mark.y);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-(Number(mark.yaw) || 0));
    if ((type === 'flag' || type === 'cone') && mark.seq === false) {
      ctx.globalAlpha = 0.38;
    }
    if (type === 'startPads') {
      startPads(ctx, box.s);
    } else if (type === 'barrier') {
      barrier(ctx, box.s, mark);
    } else if (type === 'flag' || type === 'cone') {
      marker(ctx, box.s, type === 'cone');
    } else if (type === 'diveGate') {
      diveGate(ctx, box.s);
    } else {
      /* The authored level count when the plan carries one, the type
       * default when it is an older stored plan that does not. */
      aperture(ctx, box.s, mark.levels > 0 ? mark.levels : LEVELS[type]);
    }
    ctx.restore();
  }
  if (options.scaleBar) {
    gateNumbers(ctx, box, plan.numbers);
    scaleBar(ctx, box, w, h);
  }
  return true;
}

/*
 * Draw every plan canvas under `root` that is on screen and sized. A
 * canvas is measured, not assumed, so the same code serves a card tile
 * and the full width drawing in the track sheet. Canvases that are still
 * hidden report no size and are left for the next pass.
 */
export function paintPlans(root = document) {
  for (const canvas of root.querySelectorAll('canvas.plan')) {
    if (!canvas.planData) {
      continue;
    }
    drawPlan(canvas, canvas.planData, canvas.planOptions || {});
  }
}

export function planCanvas(plan, label, options) {
  const canvas = document.createElement('canvas');
  canvas.className = 'plan';
  canvas.planData = plan || null;
  canvas.planOptions = options || {};
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label || 'Track plan');
  return canvas;
}

export function planLabel(track) {
  const plan = track.plan || {};
  const w = Math.round(Number(plan.width) || 0);
  const d = Math.round(Number(plan.depth) || 0);
  const gates = track.gates === 1 ? '1 gate' : `${track.gates} gates`;
  return `Plan of ${track.name}, ${gates} on a ${w} by ${d} metre field.`;
}

export function fieldSize(track) {
  const plan = track.plan || {};
  const w = Math.round(Number(plan.width) || 0);
  const d = Math.round(Number(plan.depth) || 0);
  if (!w || !d) {
    return '';
  }
  return `${w} by ${d} m`;
}
