(() => {
  const D = window.INTERLUDE;
  const Scenes = (window.Scenes = window.Scenes || {});
  const NS = "http://www.w3.org/2000/svg";
  const DAY = [1, 2, 3, 4, 5].map((n) => `var(--day-${n})`);
  const intFmt = new Intl.NumberFormat("pt-BR");
  const fmt = (n) => intFmt.format(Math.round(n));
  const dec = (n, d) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const reduced = () => window.Deck?.reduced;

  function svgEl(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style") Object.assign(node.style, v);
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    parent?.appendChild(node);
    return node;
  }

  function tween(duration, onFrame, onDone) {
    const t0 = performance.now();
    let raf = 0;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      onFrame(p);
      if (p < 1) raf = requestAnimationFrame(step);
      else onDone?.();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }

  function measure(root) {
    root.querySelectorAll(".draw, .bdraw").forEach((path) => {
      if (typeof path.getTotalLength === "function") path.style.setProperty("--len", Math.ceil(path.getTotalLength()) + 1);
    });
  }

  const hhmm = (sec) => {
    const total = 6 * 3600 + sec;
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  // ---------- Geografia ----------
  const nodes = D.attractions;
  const nodeIndex = new Map(nodes.map((n, i) => [n.node, i]));
  const byName = new Map(nodes.map((n, i) => [n.name, i]));
  const hotel = nodes.findIndex((n) => n.depot);
  const solutionRoutes = D.days.map((day) => day.steps.filter((s) => !s.meal).map((s) => byName.get(s.name)));

  function project(box, { pad = 30, minDist = 0, subset = null } = {}) {
    const k = Math.cos((40.74 * Math.PI) / 180);
    const pts = nodes.map((n) => ({ x: n.lng * k, y: -n.lat }));
    const ref = subset ? subset.map((i) => pts[i]) : pts;
    const minx = Math.min(...ref.map((p) => p.x)), maxx = Math.max(...ref.map((p) => p.x));
    const miny = Math.min(...ref.map((p) => p.y)), maxy = Math.max(...ref.map((p) => p.y));
    const scale = Math.min((box.w - 2 * pad) / (maxx - minx || 1), (box.h - 2 * pad) / (maxy - miny || 1));
    const ox = box.x + (box.w - (maxx - minx) * scale) / 2;
    const oy = box.y + (box.h - (maxy - miny) * scale) / 2;
    const pos = pts.map((p) => ({ x: ox + (p.x - minx) * scale, y: oy + (p.y - miny) * scale }));
    if (minDist) relax(pos, minDist);
    return pos;
  }

  // Afasta pontos sobrepostos no centro de Manhattan sem alterar a geografia geral.
  function relax(pos, minDist) {
    for (let it = 0; it < 400; it++) {
      let moved = false;
      for (let i = 0; i < pos.length; i++) {
        for (let j = i + 1; j < pos.length; j++) {
          const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
          const dist = Math.hypot(dx, dy) || 0.01;
          if (dist < minDist) {
            const push = (minDist - dist) / 2 + 0.1;
            const ux = dx / dist, uy = dy / dist;
            pos[i].x -= ux * push; pos[i].y -= uy * push;
            pos[j].x += ux * push; pos[j].y += uy * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function routeD(seq, pos, bend = 0.16) {
    if (seq.length < 2) return "";
    let d = `M${pos[seq[0]].x.toFixed(1)},${pos[seq[0]].y.toFixed(1)}`;
    for (let i = 1; i < seq.length; i++) {
      const a = pos[seq[i - 1]], b = pos[seq[i]];
      if (a === b) continue;
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * bend;
      const my = (a.y + b.y) / 2 + (b.x - a.x) * bend;
      d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }
    return d;
  }

  function drawNodes(svg, pos, { r = 12, numbers = true, dark = false, neutral } = {}) {
    const layer = svgEl("g", { class: "nodes" }, svg);
    const els = nodes.map((n, i) => {
      const g = svgEl("g", { class: "map-node", transform: `translate(${pos[i].x.toFixed(1)},${pos[i].y.toFixed(1)})` }, layer);
      if (n.depot) {
        svgEl("rect", { x: -r - 2, y: -r - 2, width: 2 * r + 4, height: 2 * r + 4, rx: 6, style: { fill: dark ? "#fff" : "var(--ink)", stroke: dark ? "var(--night)" : "#fff", strokeWidth: 3 } }, g);
        svgEl("text", { class: "map-num", style: { fill: dark ? "var(--night)" : "#fff" }, text: "H" }, g);
      } else {
        svgEl("circle", { class: "dot", r, style: { fill: neutral || (dark ? "#3B524A" : "#A6B0AB"), stroke: dark ? "var(--night)" : "#fff", strokeWidth: 3, transition: "fill .5s" } }, g);
        if (numbers) svgEl("text", { class: "map-num", text: n.priority }, g);
      }
      return g;
    });
    return { layer, els };
  }

  function colorNodes(els, assignment, dark) {
    els.forEach((g, i) => {
      const dot = g.querySelector(".dot");
      if (!dot) return;
      const day = assignment.get(i);
      dot.style.fill = day == null ? (dark ? "#3B524A" : "#A6B0AB") : DAY[day];
    });
  }

  // ---------- 01 Capa ----------
  function constellation(svg, box, { minDist = 22, r = 7 } = {}) {
    svg.replaceChildren();
    const pos = project(box, { pad: 40, minDist });
    const routes = svgEl("g", {}, svg);
    solutionRoutes.forEach((seq, d) => {
      const path = svgEl("path", { class: "route draw", d: routeD(seq, pos, 0.13), style: { stroke: DAY[d], strokeWidth: 2.6, opacity: 0.9 } }, routes);
      void path;
    });
    const layer = svgEl("g", {}, svg);
    nodes.forEach((n, i) => {
      const g = svgEl("g", { transform: `translate(${pos[i].x},${pos[i].y})` }, layer);
      const inner = svgEl("g", {}, g);
      if (n.depot) {
        svgEl("rect", { x: -9, y: -9, width: 18, height: 18, rx: 4, transform: "rotate(45)", style: { fill: "var(--amber)", stroke: "var(--night)", strokeWidth: 3 } }, inner);
      } else {
                svgEl("circle", { r, style: { fill: "#E9F3EE", stroke: "var(--night)", strokeWidth: 2.5 } }, inner);
      }
    });
    return pos;
  }

  Scenes.cover = {
    init(slide) { constellation(slide.querySelector("#coverMap"), { x: 0, y: 0, w: 640, h: 840 }); measure(slide); },
  };

  // ---------- 02 Problema ----------
  Scenes.problem = {
    init(slide) {
      const svg = slide.querySelector("#problemMap");
      const pos = project({ x: 20, y: 46, w: 600, h: 548 }, { pad: 30, minDist: 42 });
      const routeLayer = svgEl("g", {}, svg);
      this.paths = solutionRoutes.map((seq, d) => svgEl("path", { class: "route problem-route", pathLength: 1, d: routeD(seq, pos, 0.18), style: { stroke: DAY[d], strokeWidth: 3.2, transitionDelay: `${d * 180}ms` } }, routeLayer));
      this.nodes = drawNodes(svg, pos, { r: 13 });
      const labels = svgEl("g", {}, svg);
      nodes.forEach((n, i) => {
        if (n.depot) return;
        const near = nodes.some((_, j) => j !== i && Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y) < 70);
        if (near) return;
        const left = pos[i].x > 420;
        svgEl("text", { class: "map-label", x: pos[i].x + (left ? -20 : 20), y: pos[i].y + 4, "text-anchor": left ? "end" : "start", text: n.name }, labels);
      });
      this.assignment = new Map();
      solutionRoutes.forEach((seq, d) => seq.forEach((i) => { if (i !== hotel) this.assignment.set(i, d); }));
      measure(svg);
    },
    build(slide, level, instant) {
      const out = level >= 1;
      this.paths.forEach((p) => {
        p.style.transition = instant || !out ? "none" : "";
        p.classList.toggle("on", out);
      });
      colorNodes(this.nodes.els, out ? this.assignment : new Map(), false);
    },
  };

  // ---------- 04 Teoria ----------
  const MINI = [[62, 52], [118, 30], [214, 36], [272, 78], [262, 160], [196, 182], [104, 172], [46, 126]];
  const MDEPOT = [160, 106];
  const MMEALS = { A: [168, 31], B: [280, 120] };
  function miniPath(seq) {
    const pt = (i) => (i === "D" ? MDEPOT : MMEALS[i] || MINI[i]);
    let d = `M${pt(seq[0]).join(",")}`;
    for (let i = 1; i < seq.length; i++) {
      const a = pt(seq[i - 1]), b = pt(seq[i]);
      const mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * 0.12, my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * 0.12;
      d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${b.join(",")}`;
    }
    return d;
  }
  Scenes.theory = {
    init(slide) {
      const tours = {
        tsp: { tours: [[0, 1, 2, 3, 4, 5, 6, 7, 0]], depot: false },
        vrp: { tours: [["D", 7, 0, 1, 2, "D"], ["D", 3, 4, 5, 6, "D"]], depot: true },
        vrptw: { tours: [["D", 7, 0, 1, 2, "D"], ["D", 3, 4, 5, 6, "D"]], depot: true, windows: true },
        toptw: { tours: [["D", 0, 1, 2, "D"], ["D", 3, 4, 6, "D"]], depot: true, windows: true, dropped: [5, 7] },
        interlude: { tours: [["D", 0, 1, "A", 2, "D"], ["D", 3, "B", 4, 6, "D"]], depot: true, windows: true, dropped: [5, 7], priorities: true, meals: true },
      };
      slide.querySelectorAll("svg[data-mini]").forEach((svg) => {
        const cfg = tours[svg.dataset.mini];
        cfg.tours.forEach((seq, t) => {
          const d = miniPath(seq);
          svgEl("path", { class: "route bdraw", d, style: { stroke: cfg.tours.length === 1 ? "var(--day-1)" : DAY[t === 0 ? 0 : 2], strokeWidth: 2.4, transitionDelay: `${200 + t * 400}ms` } }, svg);
          void d;
        });
        MINI.forEach(([x, y], i) => {
          const dropped = cfg.dropped?.includes(i);
          if (cfg.windows && !dropped) {
            const start = (i * 47) % 360, span = 110 + ((i * 31) % 90);
            const a0 = ((start - 90) * Math.PI) / 180, a1 = ((start + span - 90) * Math.PI) / 180;
            const R = 13;
            svgEl("circle", { cx: x, cy: y, r: R, style: { fill: "none", stroke: "#E3E2DC", strokeWidth: 3 } }, svg);
            svgEl("path", { d: `M${x + R * Math.cos(a0)},${y + R * Math.sin(a0)} A${R},${R} 0 ${span > 180 ? 1 : 0} 1 ${x + R * Math.cos(a1)},${y + R * Math.sin(a1)}`, style: { fill: "none", stroke: "var(--amber)", strokeWidth: 3, strokeLinecap: "round" } }, svg);
          }
          svgEl("circle", { cx: x, cy: y, r: cfg.priorities && !dropped ? 9 : 7, style: dropped ? { fill: "none", stroke: "#9AA7A1", strokeWidth: 1.6, strokeDasharray: "3 3" } : { fill: "#fff", stroke: "#5C6A64", strokeWidth: 2 } }, svg);
          if (cfg.priorities && !dropped) svgEl("text", { class: "mini-priority", x, y: y + 4, "text-anchor": "middle", text: i + 1 }, svg);
          if (dropped) {
            svgEl("path", { d: `M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}`, style: { stroke: "#E8613F", strokeWidth: 1.8, strokeLinecap: "round" } }, svg);
          }
        });
        if (cfg.depot) svgEl("rect", { x: MDEPOT[0] - 8, y: MDEPOT[1] - 8, width: 16, height: 16, rx: 3, transform: `rotate(45 ${MDEPOT[0]} ${MDEPOT[1]})`, style: { fill: "var(--amber)", stroke: "#fff", strokeWidth: 2 } }, svg);
        if (cfg.meals) Object.values(MMEALS).forEach(([x, y]) => {
          svgEl("rect", { x: x - 11, y: y - 11, width: 22, height: 22, rx: 2, fill: "var(--pine)", stroke: "#fff", "stroke-width": 2 }, svg);
          svgEl("text", { class: "mini-meal", x, y: y + 4, "text-anchor": "middle", text: "A" }, svg);
        });
      });
      measure(slide);
    },
    build(slide) {
      slide.querySelectorAll(".theory article").forEach((a) => a.querySelectorAll(".bdraw").forEach((p) => p.classList.toggle("on", a.classList.contains("built"))));
    },
  };

  // ---------- 06 ER ----------
  Scenes.er = {
    init(slide) {
      const svg = slide.querySelector("#erLinks")
      const defs = svgEl("defs", {}, svg)
      const arrow = svgEl("marker", { id: "dataAssociation", viewBox: "0 0 12 12", refX: 11, refY: 6, markerWidth: 9, markerHeight: 9, orient: "auto" }, defs)
      svgEl("path", { d: "M1,1 L11,6 L1,11", fill: "none", stroke: "#5C6A64", "stroke-width": 1.5 }, arrow)
      const label = (x, y, text, anchor = "start") => svgEl("text", { class: "card-lbl", x, y, text, "text-anchor": anchor }, svg)
      const composition = (x, y, points, targetX, targetY, multiplicity) => {
        svgEl("path", { class: "lnk", d: `M${x + 20},${y} ${points}` }, svg)
        svgEl("path", { d: `M${x},${y} l10,-6 l10,6 l-10,6 Z`, fill: "#2F5D50" }, svg)
        label(x + 10, y + (targetY === y ? 20 : -14), "1", "middle")
        label(targetX - 7, targetY - 10, multiplicity, "end")
      }
      // O losango fica no objeto que contém os dados, e as multiplicidades
      // descrevem os campos opcionais e as listas do documento salvo.
      composition(532, 150, "H568 V40 H600", 600, 40, "0..*")
      composition(532, 205, "H556 V285 H600", 600, 285, "0..1")
      composition(532, 245, "H544 V510 H600", 600, 510, "0..1")
      composition(832, 285, "H900", 900, 285, "0..*")
      composition(1132, 285, "H1170 V150 H1200", 1200, 150, "0..*")
      composition(1132, 350, "H1158 V430 H1200", 1200, 430, "0..*")
      svgEl("path", { class: "lnk association", d: "M300,150 H232", "marker-end": "url(#dataAssociation)" }, svg)
      label(239, 136, "0..1")
      label(293, 168, "0..*", "end")
      label(267, 194, "ownerId", "middle")
    },
  };

  // ---------- 07 Pipeline ----------
  Scenes.pipeline = {
    enter(slide, instant) {
      this.stop?.();
      const stages = [...slide.querySelectorAll(".stage")];
      const fill = slide.querySelector("#pulseFill"), dot = slide.querySelector("#pulseDot");
      const set = (p) => {
        fill.style.width = `${p * 100}%`;
        dot.style.left = `${p * 100}%`;
        stages.forEach((s, i) => s.classList.toggle("lit", p >= (i + 0.5) / stages.length));
      };
      if (instant || reduced()) { set(1); this.running = false; return; }
      set(0);
      this.running = true;
      const t = setTimeout(() => {
        this.stop = tween(5200, (p) => set(easeInOut(p)), () => { this.running = false; });
      }, 1000);
      this.stop = () => clearTimeout(t);
      this.set = set;
    },
    busy() { return this.running; },
    finish() { this.stop?.(); this.set?.(1); this.running = false; },
    leave() { this.stop?.(); this.running = false; },
  };

  // ---------- 10 Média bayesiana ----------
  Scenes.bayes = {
    build(slide, level, instant) {
      const demo = slide.querySelector("#bayesDemo");
      const hyp = slide.querySelector('[data-bd="hyp"]'), cp = slide.querySelector('[data-bd="cp"]');
      const B = (r, n) => (n * r + 500 * 4) / (n + 500);
      const target = [B(5, 1), B(4.8, 301915)];
      if (level < 4) { demo.classList.remove("after"); hyp.textContent = "5,000"; cp.textContent = "4,800"; return; }
      clearTimeout(this.t);
      const run = () => {
        demo.classList.add("after");
        const draw = (p) => {
          const e = easeInOut(p);
          hyp.textContent = dec(5 + (target[0] - 5) * e, 3);
          cp.textContent = dec(4.8 + (target[1] - 4.8) * e, 3);
        };
        if (instant) draw(1); else tween(1200, draw);
      };
      if (instant) run(); else this.t = setTimeout(run, 900);
    },
  };

  // ---------- 11 Evolução da ordenação ----------
  const META = {
    "Central Park": "4,8, 301.915", "Times Square": "4,7, 246.545", "Rockefeller Center": "4,7, 201.962", "Empire State Building": "4,7, 129.004",
    "Estátua da Liberdade": "4,7, 112.723", "Parque Bryant": "4,7, 107.557", "Metropolitan Museum": "4,8, 94.843", "Memorial do 11/9": "4,8, 94.772",
    "Ponte do Brooklyn": "4,8, 93.288", "Catedral S. Patrício": "4,8, 42.771", "Radio City Music Hall": "4,8, 27.658", "Lincoln Center": "4,8, 22.105",
  };
  const COLS = [
    { title: "Produto simples", sub: "nota × avaliações, em milhares", rows: [["Central Park", "1.449"], ["Times Square", "1.159"], ["Rockefeller Center", "949"], ["Empire State Building", "606"], ["Estátua da Liberdade", "530"], ["Parque Bryant", "506"], ["Metropolitan Museum", "455"], ["Memorial do 11/9", "455"], ["Ponte do Brooklyn", "448"], ["Catedral S. Patrício", "205"], ["Radio City Music Hall", "133"], ["Lincoln Center", "106"]] },
    { title: "Média bayesiana", sub: "ajusta notas com poucas avaliações", rows: [["Central Park", "4,799"], ["Metropolitan Museum", "4,796"], ["Memorial do 11/9", "4,796"], ["Ponte do Brooklyn", "4,796"], ["Catedral S. Patrício", "4,791"], ["Radio City Music Hall", "4,786"], ["Lincoln Center", "4,782"], ["Times Square", "4,699"], ["Rockefeller Center", "4,698"], ["Empire State Building", "4,697"], ["Estátua da Liberdade", "4,697"], ["Parque Bryant", "4,697"]] },
    { title: "Escore completo", sub: "+ popularidade relativa", rows: [["Central Park", "5,399"], ["Times Square", "5,252"], ["Rockefeller Center", "5,206"], ["Metropolitan Museum", "5,130"], ["Memorial do 11/9", "5,130"], ["Ponte do Brooklyn", "5,126"], ["Empire State Building", "5,102"], ["Estátua da Liberdade", "5,071"], ["Parque Bryant", "5,060"], ["Catedral S. Patrício", "4,942"], ["Radio City Music Hall", "4,837"], ["Lincoln Center", "4,782"]] },
  ];
  Scenes.bump = {
    init(slide) {
      const svg = slide.querySelector("#bumpChart");
      const X = [20, 600, 1080], WS = [420, 330, 330], Y0 = 84, RH = 42;
      const rank = COLS.map((c) => new Map(c.rows.map(([n], i) => [n, i])));
      const moved = (name) => rank[2].get(name) - rank[0].get(name);
      const tone = (name) => (moved(name) < 0 ? "var(--rise)" : moved(name) > 0 ? "var(--fall)" : null);
      this.groups = [];
      COLS.forEach((col, c) => {
        const g = svgEl("g", { style: { opacity: c === 0 ? 1 : 0, transition: "opacity .7s var(--ease)" } }, svg);
        svgEl("text", { class: "hd", x: X[c], y: 26, text: col.title }, g);
        svgEl("text", { class: "hs", x: X[c], y: 50, text: col.sub }, g);
        col.rows.forEach(([name, value], i) => {
          const y = Y0 + i * RH;
          const highlight = tone(name);
          svgEl("rect", { x: X[c] - 8, y: y - 18, width: WS[c] + 16, height: 34, rx: 10, style: { fill: highlight ? "var(--paper)" : "transparent", stroke: highlight ? highlight : "none", strokeWidth: 1.5 } }, g);
          svgEl("text", { class: "rk", x: X[c] + 14, y: y + 5, "text-anchor": "middle", text: i + 1 }, g);
          svgEl("text", { class: `nm${highlight ? "" : " muted"}`, x: X[c] + 38, y: y + 5, text: name }, g);
          if (c === 0) svgEl("text", { class: "val", x: X[c] + WS[c] - 80, y: y + 5, "text-anchor": "end", style: { fontSize: "12px" }, text: META[name] }, g);
          svgEl("text", { class: "val", x: X[c] + WS[c], y: y + 5, "text-anchor": "end", style: { fill: "var(--ink)" }, text: value }, g);
          if (c === 2) {
            const m = moved(name);
            svgEl("text", { class: "delta", x: X[c] + WS[c] + 46, y: y + 5, "text-anchor": "middle", style: { fill: highlight || "var(--ink-soft)" }, text: m === 0 ? "–" : `${m < 0 ? "▲" : "▼"} ${Math.abs(m)}` }, g);
          }
        });
        this.groups.push(g);
      });
      this.links = [0, 1].map((c) => {
        const g = svgEl("g", {}, svg);
        COLS[c].rows.forEach(([name]) => {
          const y1 = Y0 + rank[c].get(name) * RH, y2 = Y0 + rank[c + 1].get(name) * RH;
          const x1 = X[c] + WS[c] + 12, x2 = X[c + 1] - 12;
          const color = tone(name) || "#CBD2CE";
          const p = svgEl("path", { class: "bdraw", d: `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`, style: { fill: "none", stroke: color, strokeWidth: tone(name) ? 2.6 : 1.4 } }, g);
          p.style.transitionDelay = `${rank[c].get(name) * 40}ms`;
        });
        return g;
      });
      measure(svg);
            svg.setAttribute("viewBox", "0 0 1470 600");
    },
    build(slide, level) {
      this.groups[1].style.opacity = level >= 1 ? 1 : 0;
      this.groups[2].style.opacity = level >= 2 ? 1 : 0;
      this.links[0].querySelectorAll(".bdraw").forEach((p) => p.classList.toggle("on", level >= 1));
      this.links[1].querySelectorAll(".bdraw").forEach((p) => p.classList.toggle("on", level >= 2));
    },
  };

  // ---------- 12 Ordem do usuário ----------
  Scenes.prio = {
    init(slide) {
      const items = nodes.filter((n) => !n.depot).sort((a, b) => a.priority - b.priority);
      const N = items.length;
      slide.querySelector("#prioList").innerHTML = items.map((n, o) => {
        const f = 1 + (4 * (N - o)) / N;
        return `<li style="--i:${o}"><i>${n.priority}</i><span>${n.name}</span><em><u style="--w:${(f / 5) * 100}%"></u></em><b>${dec(f, 2)}</b></li>`;
      }).join("");
    },
  };

  // ---------- 13 Penalidade ----------
  Scenes.penalty = {
    init(slide) {
      const svg = slide.querySelector("#penChart");
      const items = nodes.filter((n) => !n.depot).sort((a, b) => a.priority - b.priority);
      const N = items.length;
      this.rows = items.map((n, order) => {
        const rho = (N - order) / N;
        const iota = Math.max(0, Math.min(1, n.importance));
        const sigma = 0.5 + 0.5 * Math.max(0, Math.min(1, n.suitability));
        return { n, steps: [5e6, 5e6, 5e6 * (1 + 4 * rho), 5e6 * (1 + 4 * rho) * (1 + 0.5 * iota), Math.floor(5e6 * (1 + 4 * rho) * (1 + 0.5 * iota) * sigma)] };
      });
      const L = 170, R = 900 - 110, top = 8, rowH = 33, MAX = 40e6;
      this.sx = (v) => ((R - L) * v) / MAX;
      const grid = svgEl("g", { class: "grid" }, svg);
      [0, 10e6, 20e6, 30e6, 40e6].forEach((v) => {
        svgEl("line", { x1: L + this.sx(v), x2: L + this.sx(v), y1: 0, y2: top + N * rowH }, grid);
        svgEl("text", { class: "ax", x: L + this.sx(v), y: top + N * rowH + 18, "text-anchor": "middle", text: v === 0 ? "0" : `${v / 1e6} mi` }, grid);
      });
      this.bars = this.rows.map((row, i) => {
        const y = top + i * rowH;
        svgEl("text", { class: "bl", x: L - 12, y: y + 21, "text-anchor": "end", text: `${row.n.priority}  ${row.n.name}` }, svg);
        const rect = svgEl("rect", { x: L, y: y + 5, height: rowH - 11, rx: 4, width: 0, style: { fill: "#8FD3B6" } }, svg);
        const label = svgEl("text", { class: "bv", x: L + 8, y: y + 21, text: "" }, svg);
        return { rect, label, value: 0 };
      });
      this.colors = ["var(--day-1)", "var(--day-1)", "var(--day-2)", "var(--day-4)", "var(--day-5)"];
    },
    build(slide, level, instant) {
      slide.querySelectorAll(".pen-step").forEach((s, i) => s.classList.toggle("current", i + 1 === level));
      this.stop?.();
      const from = this.bars.map((b) => b.value);
      const to = this.rows.map((r) => (level === 0 ? 0 : r.steps[Math.min(level, 4)]));
      const color = this.colors[Math.min(level, 4)];
      this.bars.forEach((b) => (b.rect.style.fill = color));
      const draw = (p) => {
        const e = easeInOut(p);
        this.bars.forEach((b, i) => {
          const v = from[i] + (to[i] - from[i]) * e;
          b.value = v;
          const w = this.sx(v);
          b.rect.setAttribute("width", Math.max(0, w));
          b.label.setAttribute("x", 170 + w + 8);
          b.label.textContent = v > 0 ? fmt(v) : "";
        });
      };
      if (instant) draw(1); else this.stop = tween(600, draw);
    },
  };

  // ---------- 14 Instância: uma janela de visita e um recorte da matriz real ----------
  Scenes.instance = {
    init(slide) {
      this.windows(slide);
      this.matrix(slide);
    },
    windows(slide) {
      const svg = slide.querySelector("#winGrid");
      const met = nodes.find((n) => n.name === "Metropolitan");
      const [first, last] = met.windows["1"];
      const close = last + met.service;
      const X0 = 185, X1 = 715, t0 = 3 * 3600, t1 = 12 * 3600;
      const x = (t) => X0 + (t - t0) / (t1 - t0) * (X1 - X0);
      [3, 6, 9, 12].forEach((h) => {
        svgEl("line", { x1: x(h * 3600), x2: x(h * 3600), y1: 58, y2: 345, class: "instance-grid" }, svg);
        svgEl("text", { x: x(h * 3600), y: 37, "text-anchor": "middle", class: "instance-tick", text: `${h + 6}h` }, svg);
      });
      const lanes = [
        { label: "Funcionamento", a: first, b: close, y: 98, fill: "#ABB4AE" },
        { label: "Início permitido", a: first, b: last, y: 203, fill: "var(--pine)" },
        { label: "Último encaixe", a: last, b: close, y: 308, fill: "var(--amber)" },
      ];
      lanes.forEach(({ label, a, b, y, fill }) => {
        svgEl("text", { x: X0 - 18, y: y + 7, "text-anchor": "end", class: "instance-lane", text: label }, svg);
        svgEl("rect", { x: x(a), y: y - 15, width: x(b) - x(a), height: 30, rx: 4, style: { fill } }, svg);
        svgEl("text", { x: x(a), y: y + 43, "text-anchor": "middle", class: "instance-tick", text: hhmm(a) }, svg);
        svgEl("text", { x: x(b), y: y + 43, "text-anchor": "middle", class: "instance-tick", text: hhmm(b) }, svg);
      });
      svgEl("text", { x: (x(last) + x(close)) / 2, y: 314, "text-anchor": "middle", class: "instance-duration", text: "visita de 3h15" }, svg);
    },
    matrix(slide) {
      const order = [nodes[hotel], ...["Central Park", "Metropolitan", "São Patrício"].map((name) => nodes.find((n) => n.name === name))];
      const name = (n) => n.depot ? "Hotel" : n.name;
      const minutes = (a, b) => Math.round(D.timeMatrix[a.node][b.node] / 60);
      slide.querySelector("#instanceMatrix").innerHTML = `<table class="instance-matrix"><thead><tr><th>De / para</th>${order.map((n) => `<th>${name(n)}</th>`).join("")}</tr></thead><tbody>${order.map((a, i) => `<tr><th>${name(a)}</th>${order.map((b, j) => `<td class="${i === 0 && j === 2 ? "matrix-highlight" : ""}">${i === j ? "—" : minutes(a, b)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    },
  };

  // ---------- 16 Propagação temporal (dia 2: São Patrício → Metropolitan) ----------
  Scenes.temporal = {
    init(slide) {
      const svg = slide.querySelector("#tlSvg");
      const cat = nodes.find((n) => n.name === "São Patrício"), met = nodes.find((n) => n.name === "Metropolitan");
      const day = D.days[1].steps;
      const sCat = day.find((s) => s.name === "São Patrício"), sMet = day.find((s) => s.name === "Metropolitan");
      const Ti = sCat.arrival, si = sCat.departure - sCat.arrival, tij = D.timeMatrix[cat.node][met.node];
      const ready = Ti + si + tij, Tj = sMet.arrival, wait = Tj - ready;
      this.values = { Ti, si, tij, ready, Tj, wait };
      const t0 = 11100, t1 = 15600, X0 = 60, X1 = 1380, Y = 150;
      const x = (t) => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
      svgEl("line", { class: "tl-axis", x1: X0, x2: X1, y1: Y, y2: Y }, svg);
      for (let t = 11700; t <= t1; t += 900) {
        svgEl("line", { x1: x(t), x2: x(t), y1: Y - 6, y2: Y + 6, style: { stroke: "var(--ink-soft)", strokeWidth: 1.5 } }, svg);
        svgEl("text", { class: "tl-tick", x: x(t), y: Y + 44, text: hhmm(t) }, svg);
      }
      const defs = svgEl("defs", {}, svg);
      const hatch = svgEl("pattern", { id: "waitHatch", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
      svgEl("rect", { width: 8, height: 8, style: { fill: "#FBF4E4" } }, hatch);
      svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 8, style: { stroke: "#D9A441", strokeWidth: 3 } }, hatch);
      const g = (n) => svgEl("g", { "data-step": n, style: { opacity: 0, transition: "opacity .6s var(--ease), transform .6s var(--ease)", transform: "translateY(10px)" } }, svg);
      this.layers = [];
      const node = (gx, cx, label, sub, color) => {
        svgEl("circle", { cx, cy: Y, r: 20, style: { fill: color, stroke: "#fff", strokeWidth: 3 } }, gx);
        svgEl("text", { x: cx, y: Y + 6, "text-anchor": "middle", style: { font: "italic 400 20px var(--math)", fill: "#fff" }, text: label }, gx);
        svgEl("text", { class: "tl-big", x: cx, y: Y - 86 }, gx).innerHTML = sub[0];
        svgEl("text", { class: "tl-lbl", x: cx, y: Y - 62, text: sub[1] }, gx);
      };
      let L = g(1); this.layers.push(L);
      node(L, x(Ti), "i", [`T<tspan dy="6" font-size="13">i</tspan><tspan dy="-6"> = ${fmt(Ti)} s</tspan>`, `São Patrício, ${hhmm(Ti)}`], "var(--pine)");
      L = g(2); this.layers.push(L);
      const sbar = svgEl("rect", { x: x(Ti) + 22, y: Y - 18, width: Math.max(0, x(Ti + si) - x(Ti) - 22), height: 36, rx: 8, style: { fill: "var(--pine-soft)", stroke: "var(--pine)", strokeWidth: 1.6 } }, L);
      svgEl("text", { class: "tl-math", x: (x(Ti) + x(Ti + si)) / 2 + 10, y: Y + 8, text: "" }, L).innerHTML = `s<tspan font-size="16" dy="6">i</tspan><tspan dy="-6" font-style="normal" font-family="var(--body)" font-size="15"> = ${fmt(si)} s</tspan>`;
      svgEl("text", { class: "tl-lbl", x: (x(Ti) + x(Ti + si)) / 2 + 10, y: Y + 76, text: "visita de 30 min" }, L);
      void sbar;
      L = g(3); this.layers.push(L);
      svgEl("rect", { x: x(Ti + si), y: Y - 18, width: x(ready) - x(Ti + si), height: 36, rx: 8, style: { fill: "#E6EEF7", stroke: "var(--day-3)", strokeWidth: 1.6, strokeDasharray: "6 4" } }, L);
      svgEl("text", { class: "tl-math", x: (x(Ti + si) + x(ready)) / 2, y: Y + 8 }, L).innerHTML = `t<tspan font-size="16" dy="6">ij</tspan>`;
      svgEl("text", { class: "tl-lbl", x: (x(Ti + si) + x(ready)) / 2, y: Y + 76, text: `${fmt(tij)} s de transporte` }, L);
      L = g(4); this.layers.push(L);
      svgEl("rect", { x: x(Tj), y: Y + 96, width: X1 + 40 - x(Tj), height: 34, rx: 8, style: { fill: "var(--amber-soft)", stroke: "var(--amber)", strokeWidth: 1.6 } }, L);
      svgEl("line", { x1: x(Tj), x2: x(Tj), y1: Y + 20, y2: Y + 96, style: { stroke: "var(--amber)", strokeWidth: 1.6, strokeDasharray: "4 4" } }, L);
      svgEl("text", { x: x(Tj) + 14, y: Y + 119, style: { font: "600 15px var(--body)", fill: "var(--amber-ink)" }, text: "janela do Metropolitan no dia 2: 10:00 às 13:45 →" }, L);
      L = g(5); this.layers.push(L);
      if (wait > 0) {
        svgEl("rect", { x: x(ready), y: Y - 18, width: x(Tj) - x(ready), height: 36, rx: 8, style: { fill: "url(#waitHatch)", stroke: "var(--amber)", strokeWidth: 1.4 } }, L);
        svgEl("text", { class: "tl-lbl", x: (x(ready) + x(Tj)) / 2, y: Y - 30, style: { fill: "var(--amber-ink)" }, text: `espera ${fmt(wait)} s` }, L);
      }
      node(L, x(Tj), "j", [`T<tspan dy="6" font-size="13">j</tspan><tspan dy="-6"> = ${fmt(Tj)} s</tspan>`, `Metropolitan, ${hhmm(Tj)}`], "var(--day-3)");
      L = g(6); this.layers.push(L);
      const eq = svgEl("text", { class: "tl-eq", x: 716, y: 320 }, L);
      eq.innerHTML = `x<tspan font-size="22" dy="8">ij</tspan><tspan font-size="22" dy="-18">d</tspan><tspan dy="10" font-style="normal"> = 1  ⇒  </tspan>T<tspan font-size="22" dy="8">j</tspan><tspan dy="-8" font-style="normal"> ≥ </tspan>T<tspan font-size="22" dy="8">i</tspan><tspan dy="-8" font-style="normal"> + </tspan>s<tspan font-size="22" dy="8">i</tspan><tspan dy="-8" font-style="normal"> + </tspan>t<tspan font-size="22" dy="8">ij</tspan>`;
      svgEl("text", { x: 716, y: 365, "text-anchor": "middle", style: { font: "400 22px var(--mono)", fill: "var(--ink-muted)" }, text: `${fmt(Tj)} ≥ ${fmt(Ti)} + ${fmt(si)} + ${fmt(tij)} = ${fmt(ready)}` }, L);
    },
    build(slide, level) {
      this.layers.forEach((L, i) => {
        const on = level >= i + 1;
        L.style.opacity = on ? 1 : 0;
        L.style.transform = on ? "none" : "translateY(10px)";
      });
    },
  };

  // ---------- 19 Construção e melhoria: execução reduzida com tempos reais ----------
  Scenes.solverDemo = {
    init(slide) {
      this.slide = slide;
      this.demo = window.INTERLUDE_SEARCH_DEMO;
      const { names, matrix, construction, search } = this.demo;
      const firstChoices = names.slice(1).map((name, i) => ({ label: name, value: matrix[0][i + 1] + matrix[i + 1][0], chosen: i === 0 })).sort((a, b) => a.value - b.value);
      this.frames = [{ phase: 0, title: "Escolher a primeira visita", route: [0, 0], before: [], current: 0, best: null, focus: 1, choices: firstChoices, choiceTitle: "Acréscimo por visita" }];
      let before = [0, 0];
      construction.forEach((step, i) => {
        const choices = i === 0 ? firstChoices : step.choices.map((c, k) => ({ label: `${names[before[c.position - 1]]} → ${names[before[c.position]]}`, value: c.delta, chosen: k === 0 }));
        this.frames.push({ phase: 0, title: `Inserir ${names[step.insert]}`, route: step.route, before, current: step.cost, best: i === 3 ? step.cost : null, focus: step.insert, choices, choiceTitle: i === 0 ? "Acréscimo por visita" : "Acréscimo por encaixe" });
        before = step.route;
      });
      const initial = search[0], improved = search[1], exploring = search[2];
      const comparison = [{ label: "Ordem inicial", value: initial.cost }, { label: "Outra ordem", value: improved.cost, chosen: true }];
      this.frames.push(
        { phase: 1, title: "Testar outra ordem", route: improved.route, before: initial.route, current: improved.cost, best: initial.cost, choices: comparison, choiceTitle: "Deslocamento total", trial: true },
        { phase: 1, title: "Guardar a melhoria", route: improved.route, before: initial.route, current: improved.cost, best: improved.cost, choices: comparison, choiceTitle: "Deslocamento total", saving: initial.cost - improved.cost },
        { phase: 1, title: "Continuar explorando", route: exploring.route, before: improved.route, current: exploring.cost, best: improved.cost, choices: [{ label: "Rota em exploração", value: exploring.cost }, { label: "Melhor guardada", value: improved.cost, chosen: true }], choiceTitle: "Deslocamento total", trial: true },
        { phase: 1, title: "Devolver a melhor encontrada", route: improved.route, before: [], current: improved.cost, best: improved.cost, choices: [{ label: "Primeira rota completa", value: initial.cost }, { label: "Melhor encontrada", value: improved.cost, chosen: true }], choiceTitle: "Deslocamento total", saving: initial.cost - improved.cost }
      );
      slide.querySelector("#demoReplay").addEventListener("click", () => window.Deck.replay());
      slide.querySelector("#demoNext").addEventListener("click", () => window.Deck.next());
      this.index = this.frames.length - 1;
      this.render();
    },
    get stepCount() { return this.frames.length; },
    setStep(step) {
      this.index = Math.max(0, Math.min(step, this.frames.length - 1));
      this.render();
    },
    enter(slide, instant = false) {
      this.setStep(instant ? this.frames.length - 1 : 0);
    },
    busy() { return this.index < this.frames.length - 1; },
    finish() { this.setStep(this.frames.length - 1); },
    buttons() {
      const final = this.index === this.frames.length - 1;
      this.slide.querySelector("#demoNext").disabled = final;
    },
    render() {
      const slide = this.slide, frame = this.frames[this.index];
      const { names, matrix } = this.demo;
      const svg = slide.querySelector("#solverDemoMap");
      svg.replaceChildren();
      svg.setAttribute("aria-label", `${frame.title}. Rota atual: ${frame.route.map((i) => names[i]).join(", ")}. ${fmt(frame.current)} segundos de deslocamento. Melhor rota completa: ${frame.best === null ? "ainda não construída" : fmt(frame.best) + " segundos"}.`);
      const pos = [[130, 425], [750, 425], [730, 245], [650, 75], [260, 75]];
      const initials = ["H", "E", "S", "M", "C"];
      const defs = svgEl("defs", {}, svg);
      ["route", "trial", "old"].forEach((kind) => {
        const marker = svgEl("marker", { id: `demoArrow-${kind}`, viewBox: "0 0 12 12", refX: 10, refY: 6, markerWidth: 13, markerHeight: 13, markerUnits: "userSpaceOnUse", orient: "auto" }, defs);
        svgEl("path", { d: "M1,1 L10,6 L1,11", fill: "none", class: `demo-arrow demo-arrow-${kind}` }, marker);
      });
      const active = svgEl("g", {}, svg), labels = [];
      const edges = (route) => route.slice(1).map((b, k) => [route[k], b]).filter(([a, b]) => a !== b);
      const currentEdges = new Set(edges(frame.route).map((e) => e.join("-")));
      const draw = (a, b, kind) => {
        const [ax, ay] = pos[a], [bx, by] = pos[b], dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
        const sx = ax + ux * 34, sy = ay + uy * 34, ex = bx - ux * 38, ey = by - uy * 38;
        const cx = (ax + bx) / 2 - dy * .09, cy = (ay + by) / 2 + dx * .09;
        svgEl("path", { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, class: `demo-edge demo-edge-${kind}`, ...(kind !== "old" ? { pathLength: 1 } : {}), "marker-end": `url(#demoArrow-${kind})` }, active);
        if (kind !== "old") {
          const hotelToCathedral = a === 0 && b === 2;
          const t = hotelToCathedral ? .35 : .5, q = 1 - t, offset = hotelToCathedral ? -18 : 13;
          labels.push({ x: q * q * sx + 2 * q * t * cx + t * t * ex - uy * offset, y: q * q * sy + 2 * q * t * cy + t * t * ey + ux * offset, value: matrix[a][b] });
        }
      };
      edges(frame.before).forEach(([a, b]) => { if (!currentEdges.has(`${a}-${b}`)) draw(a, b, "old"); });
      edges(frame.route).forEach(([a, b]) => draw(a, b, frame.trial ? "trial" : "route"));
      labels.forEach((label) => svgEl("text", { x: label.x, y: label.y + 7, class: "demo-edge-time", text: fmt(label.value) }, svg));
      const included = new Set(frame.route);
      pos.forEach(([x, y], i) => {
        const pending = !included.has(i), focus = i === frame.focus;
        const group = svgEl("g", { class: `demo-node${pending ? " pending" : ""}${focus ? " selected" : ""}` }, svg);
        svgEl(i === 0 ? "rect" : "circle", i === 0 ? { x: x - 28, y: y - 28, width: 56, height: 56, rx: 8 } : { cx: x, cy: y, r: 28 }, group);
        svgEl("text", { x, y: y + 8, class: "demo-node-letter", text: initials[i] }, group);
        svgEl("text", { x: i === 2 ? x - 48 : x, y: i === 2 ? y + 8 : i === 0 || i === 1 ? y + 65 : y - 43, class: "demo-node-name", ...(i === 2 ? { style: { textAnchor: "end" } } : {}), text: names[i] }, group);
      });
      slide.querySelector("#demoPhaseBuild").classList.toggle("active", frame.phase === 0);
      slide.querySelector("#demoPhaseSearch").classList.toggle("active", frame.phase === 1);
      slide.querySelector("#demoCurrent").innerHTML = `${fmt(frame.current)} <small>s</small>`;
      slide.querySelector("#demoCurrent").classList.toggle("trial", !!frame.trial);
      slide.querySelector("#demoBest").innerHTML = frame.best === null ? "—" : `${fmt(frame.best)} <small>s</small>`;
      slide.querySelector("#demoStep").textContent = `${String(this.index + 1).padStart(2, "0")} / ${String(this.frames.length).padStart(2, "0")}`;
      slide.querySelector("#demoAction").textContent = frame.title;
      slide.querySelector("#demoChoices").innerHTML = `<h4>${frame.choiceTitle}</h4><ol>${frame.choices.map((choice) => `<li class="${choice.chosen ? "chosen" : ""}"><span>${choice.label}</span><b>${frame.phase === 0 ? "+" : ""}${fmt(choice.value)} <small>s</small></b></li>`).join("")}</ol>${frame.saving ? `<div class="demo-saving">−${fmt(frame.saving)} s <small>em relação à primeira rota</small></div>` : ""}`;
      this.buttons();
    },
  };

  // ---------- 18 Busca ----------
  Scenes.search = {
    init(slide) {
      const svg = slide.querySelector("#searchMap");
      this.pos = project({ x: 10, y: 6, w: 540, h: 628 }, { pad: 26, minDist: 32 });
      this.routeLayer = svgEl("g", {}, svg);
      this.nodes = drawNodes(svg, this.pos, { r: 13 });
      const labels = svgEl("g", {}, svg);
      nodes.forEach((n, i) => {
        if (n.depot) return;
        const p = this.pos[i];
        const near = nodes.some((_, j) => j !== i && Math.hypot(this.pos[j].x - p.x, this.pos[j].y - p.y) < 60);
        if (!near) svgEl("text", { class: "map-label", x: p.x + 20, y: p.y + 4, text: n.name }, labels);
      });
      const legend = svgEl("g", {}, svg);
      const midtown = nodes.map((_, i) => i).filter((i) => !nodes[i].depot && nodes.some((_, j) => j !== i && Math.hypot(this.pos[j].x - this.pos[i].x, this.pos[j].y - this.pos[i].y) < 60));
      midtown.sort((a, b) => nodes[a].priority - nodes[b].priority).forEach((i, k) => {
        svgEl("text", { class: "map-label", x: 552, y: 440 + k * 20, "text-anchor": "end", style: { fontSize: "12.5px" }, text: `${nodes[i].priority} ${nodes[i].name}` }, legend);
      });
      this.frames = D.frames;
      const conv = slide.querySelector("#convChart");
      const W = 860, H = 260, L = 88, B = 197, T = 36, R = 825
      const tmin = Math.log10(0.01), tmax = Math.log10(5), omin = 5, omax = 8
      this.cx = (t) => L + ((Math.log10(t) - tmin) / (tmax - tmin)) * (R - L)
      this.cy = (o) => B - ((Math.log10(o) - omin) / (omax - omin)) * (B - T)
      const grid = svgEl("g", { class: "grid" }, conv)
      const costTicks = [[1e5, "100 mil"], [1e6, "1 milhão"], [1e7, "10 milhões"], [1e8, "100 milhões"]]
      costTicks.forEach(([o, label]) => {
        svgEl("line", { x1: L, x2: R, y1: this.cy(o), y2: this.cy(o) }, grid)
        svgEl("text", { class: "ax", x: L - 10, y: this.cy(o) + 4, "text-anchor": "end", text: label }, grid)
      })
      const timeTicks = [[0.01, "0,01"], [0.1, "0,1"], [1, "1"], [5, "5"]]
      timeTicks.forEach(([t, label]) => {
        svgEl("line", { x1: this.cx(t), x2: this.cx(t), y1: T, y2: B }, grid)
        svgEl("text", { class: "ax", x: this.cx(t), y: B + 21, "text-anchor": "middle", text: label }, grid)
      })
      svgEl("text", { class: "axis-title", x: 0, y: 15, text: "Custo do objetivo (menor é melhor)" }, grid)
      svgEl("text", { class: "axis-title", x: R, y: H - 7, "text-anchor": "end", text: "Tempo do solver em segundos" }, grid)
      svgEl("text", { class: "ax", x: R, y: 15, "text-anchor": "end", text: "Eixos em escala logarítmica" }, grid)
      const last = this.frames[this.frames.length - 1]
      const plateau = svgEl("g", { class: "search-plateau" }, conv)
      svgEl("line", { x1: this.cx(last.t), x2: R, y1: this.cy(last.objective), y2: this.cy(last.objective), stroke: "#2F5D50", "stroke-width": 2, "stroke-dasharray": "6 5" }, plateau)
      svgEl("text", { class: "ax", x: (this.cx(last.t) + R) / 2, y: this.cy(last.objective) - 17, "text-anchor": "middle", text: "Sem nova melhora até o limite" }, plateau)
      this.plateau = plateau
      this.convPath = svgEl("path", { style: { fill: "none", stroke: "var(--pine)", strokeWidth: 2.4, strokeLinejoin: "round" } }, conv);
      this.convDot = svgEl("circle", { r: 6, style: { fill: "#fff", stroke: "var(--pine)", strokeWidth: 3 } }, conv);
      const chips = slide.querySelector("#dayChips");
      chips.innerHTML = DAY.map((c, d) => `<div style="--c:${c}"><small>Dia ${d + 1}</small><b data-day="${d}">0</b><span>atrações</span></div>`).join("");
      this.chipEls = [...chips.querySelectorAll("b")];
      this.odo = slide.querySelector("#odoValue");
      this.odoFrame = slide.querySelector("#odoFrame");
      this.odoTime = slide.querySelector("#odoTime");
      slide.querySelector("#searchReplay").addEventListener("click", (e) => { e.currentTarget.blur(); this.play(slide); });
      this.shown = -1;
      this.value = this.frames[0].objective;
      this.show(this.frames.length - 1, true);
    },
    show(k, instant) {
      const frame = this.frames[k];
      const old = [...this.routeLayer.children];
      old.forEach((p) => { p.style.transition = "opacity .35s"; p.style.opacity = 0; setTimeout(() => p.remove(), 380); });
      const assignment = new Map();
      frame.routes.forEach((route, d) => {
        route.forEach((nodeId) => { const i = nodeIndex.get(nodeId); if (i !== hotel) assignment.set(i, d); });
        const seq = route.map((nodeId) => nodeIndex.get(nodeId));
        if (seq.length < 3) return;
        const path = svgEl("path", { class: "route", d: routeD(seq, this.pos, 0.18), style: { stroke: DAY[d], strokeWidth: 3.4, opacity: 0.95 } }, this.routeLayer);
        if (!instant) {
          const len = path.getTotalLength();
          path.style.strokeDasharray = len;
          path.style.strokeDashoffset = len;
          path.getBoundingClientRect();
          path.style.transition = "stroke-dashoffset .45s var(--ease-io)";
          path.style.strokeDashoffset = 0;
        }
      });
      colorNodes(this.nodes.els, assignment, false);
      this.chipEls.forEach((b, d) => (b.textContent = frame.routes[d].filter((n) => n !== 0).length));
      const from = this.value, to = frame.objective;
      this.stopOdo?.();
      const paint = (p) => { this.value = from + (to - from) * easeOut(p); this.odo.textContent = fmt(this.value); };
      if (instant) paint(1); else this.stopOdo = tween(320, paint);
      this.odoFrame.textContent = k + 1;
      this.odoTime.textContent = `${dec(frame.t, 4)} s`;
      const pts = this.frames.slice(0, k + 1);
      let d = "";
      pts.forEach((f, i) => {
        const x = this.cx(f.t), y = this.cy(f.objective);
        if (i === 0) d = `M${x},${y}`;
        else d += ` H${x} V${y}`;
      });
      this.convPath.setAttribute("d", d);
      this.convDot.setAttribute("cx", this.cx(frame.t));
      this.convDot.setAttribute("cy", this.cy(frame.objective));
      this.plateau.style.opacity = k === this.frames.length - 1 ? 1 : 0;
      this.shown = k;
    },
    // Tempo em escala log com permanência mínima por quadro: as melhorias
    // iniciais são rápidas demais para acompanhar em tempo real.
    play(slide) {
      this.stopAll();
      this.running = true;
      const f = this.frames;
      const lmin = Math.log10(f[0].t), lmax = Math.log10(f[f.length - 1].t);
      let at = 900;
      const timers = [];
      this.value = f[0].objective;
      f.forEach((frame, k) => {
        const target = 900 + ((Math.log10(frame.t) - lmin) / (lmax - lmin)) * 11000;
        at = k === 0 ? 900 : Math.max(at + 340, target);
        timers.push(setTimeout(() => { if (slide.classList.contains("active")) this.show(k, false); if (k === f.length - 1) this.running = false; }, at));
      });
      this.timers = timers;
    },
    stopAll() { (this.timers || []).forEach(clearTimeout); this.timers = []; this.running = false; },
    enter(slide, instant) {
      if (instant || reduced()) { this.stopAll(); this.show(this.frames.length - 1, true); return; }
      this.routeLayer.replaceChildren();
      this.show(0, true);
      this.routeLayer.replaceChildren();
      this.play(slide);
    },
    busy() { return this.running; },
    finish() { this.stopAll(); this.show(this.frames.length - 1, false); },
    leave() { this.stopAll(); },
  };

  // Agenda e mapa usam a mesma sequência da resposta registrada do solver.
  Scenes.dailyResults = {
    init(slide) {
      const grid = slide.querySelector("#dailyResults");
      const names = { "São Patrício": "Catedral de São Patrício", "Memorial 11/9": "Memorial do 11 de Setembro", "Rockefeller": "Rockefeller Center" };
      grid.innerHTML = D.days.map((day, d) => {
        let visit = 0;
        const stops = day.steps.filter((s) => !s.depot).map((s) => {
          const number = s.meal ? "—" : ++visit;
          return `<li class="${s.meal ? "meal" : ""}"><b class="visit-number">${number}</b><div><strong>${names[s.name] || s.name}</strong><span>${hhmm(s.arrival)}–${hhmm(s.departure)}</span></div></li>`;
        }).join("");
        const first = day.steps[0], last = day.steps[day.steps.length - 1];
        return `<article class="daily-result" data-a="up" style="--d:${150 + d * 100}ms;--c:${DAY[d]}"><header><h3>Dia ${d + 1}</h3><span>${14 + d}/09</span></header><svg class="daily-map" viewBox="0 0 260 250" data-day="${d}" role="img" aria-label="Pontos visitados no dia ${d + 1}, numerados na ordem da agenda"></svg><ol>${stops}</ol><footer><b>${dec(day.distance / 1000, 1)} km</b> de deslocamento<span>Hotel: ${hhmm(first.departure)} → ${hhmm(last.arrival)}</span></footer></article>`;
      }).join("");
      // A projeção é comum aos cinco dias para permitir comparar as distâncias.
      const pos = project({ x: 0, y: 0, w: 260, h: 250 }, { pad: 24, minDist: 17 });
      grid.querySelectorAll("svg.daily-map").forEach((svg) => {
        const d = Number(svg.dataset.day), seq = solutionRoutes[d];
        nodes.forEach((n, i) => { if (!n.depot) svgEl("circle", { cx: pos[i].x, cy: pos[i].y, r: 3, fill: "#CDD3CF" }, svg); });
        svgEl("path", { class: "route draw", d: routeD(seq, pos, 0.18), style: { stroke: DAY[d], strokeWidth: 2.5 } }, svg);
        seq.filter((i) => i !== hotel).forEach((i, order) => {
          svgEl("circle", { cx: pos[i].x, cy: pos[i].y, r: 11, style: { fill: DAY[d], stroke: "#fff", strokeWidth: 2 } }, svg);
          svgEl("text", { x: pos[i].x, y: pos[i].y + 4, "text-anchor": "middle", text: order + 1, style: { fill: "#fff", font: "700 12px var(--body)" } }, svg);
        });
        svgEl("rect", { x: pos[hotel].x - 6, y: pos[hotel].y - 6, width: 12, height: 12, rx: 2, style: { fill: "var(--ink)", stroke: "#fff", strokeWidth: 2 } }, svg);
      });
      measure(grid);
    },
  };

})();
