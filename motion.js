(() => {
  const ICONS = {
    "map-pin": '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    "calendar-check": '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "list-ordered": '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/>',
    sigma: '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
    timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
    "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "check-circle": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    "shield-check": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    "layout-grid": '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    presentation: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
    "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    "circle-help": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  };

  function fillIcons(root) {
    root.querySelectorAll("svg[data-i]").forEach((svg) => {
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = ICONS[svg.dataset.i] || "";
    });
  }

  const slides = [...document.querySelectorAll(".deck > .slide")];
  const total = slides.length;
  const pad = (n) => String(n).padStart(2, "0");

  function decorate(slide, index) {
    if (!slide.classList.contains("cover")) {
      const num = document.createElement("span");
      num.className = "chrome-num";
      num.textContent = `${pad(index + 1)} / ${pad(total)}`;
      slide.appendChild(num);
    }
    if (!slide.classList.contains("cover") && !slide.classList.contains("conclusion")) {
      const logo = document.createElement("img");
      logo.className = "chrome-logo";
      logo.src = "assets/unb-logo.jpg";
      logo.alt = "UnB";
      slide.appendChild(logo);
    }
    slide.querySelectorAll("[data-split]").forEach((el) => {
      const text = el.textContent;
      el.innerHTML = [...text].map((ch, i) => `<span class="ch" style="--i:${i}" aria-hidden="true">${ch}</span>`).join("") + '<span class="ch dot" style="--i:' + text.length + '" aria-hidden="true">.</span>';
    });
    slide.querySelectorAll(".code[data-type]").forEach((pre) => {
      const tag = pre.querySelector(".code-tag");
      tag?.remove();
      const lines = pre.innerHTML.split("\n");
      pre.innerHTML = lines.map((line, i) => `<span class="ln" style="--i:${i}">${line || " "}</span>`).join("");
      if (tag) pre.prepend(tag);
    });
  }

  // Realça os tipos de valor sem alterar o conteúdo dos exemplos.
  function highlightCode(root) {
    root.querySelectorAll("pre[data-language]").forEach((pre) => {
      const language = pre.dataset.language;
      const source = pre.textContent;
      const code = document.createElement("code");
      const pattern = language === "python"
        ? /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:return|True|False|None|self)\b|\b[A-Z][A-Z_]+\b|\b\d+(?:\.\d+)?\b/g
        : language === "json"
          ? /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
          : /^[^=\n]+(?==)|[^=\n]+$/gm;
      let offset = 0;
      for (const match of source.matchAll(pattern)) {
        code.append(document.createTextNode(source.slice(offset, match.index)));
        const token = document.createElement("span");
        const value = match[0];
        const rest = source.slice(match.index + value.length);
        const kind = language === "http"
          ? (rest.startsWith("=") ? "key" : "string")
          : value.startsWith("#") ? "comment"
          : /^["']/.test(value) ? (language === "json" && /^\s*:/.test(rest) ? "key" : "string")
          : /^-?\d/.test(value) ? "number" : "keyword";
        token.className = `syntax-${kind}`;
        token.textContent = value;
        code.append(token);
        offset = match.index + value.length;
      }
      code.append(document.createTextNode(source.slice(offset)));
      const markup = code.innerHTML.split("\n");
      const lines = source.split("\n");
      code.replaceChildren();
      markup.forEach((line, index) => {
        const row = document.createElement("span");
        const indentation = lines[index].match(/^ */)[0].length;
        row.className = "syntax-line";
        row.style.paddingLeft = `${indentation + 2}ch`;
        row.style.textIndent = `-${indentation + 2}ch`;
        row.innerHTML = line || " ";
        if (index) code.append(document.createTextNode("\n"));
        code.append(row);
      });
      pre.replaceChildren(code);
    });
  }

  const fmtCache = {};
  function formatNumber(value, dec) {
    const key = dec;
    fmtCache[key] ??= new Intl.NumberFormat("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return fmtCache[key].format(value);
  }
  function runCounts(slide) {
    slide.querySelectorAll("[data-count]").forEach((el) => {
      el.textContent = formatNumber(Number(el.dataset.count), Number(el.dataset.dec || 0)) + (el.dataset.suffix || "");
    });
  }

  function measureDraws(root) {
    root.querySelectorAll(".draw").forEach((path) => {
      if (path.style.getPropertyValue("--len")) return;
      if (typeof path.getTotalLength !== "function") return;
      const len = Math.ceil(path.getTotalLength());
      path.style.setProperty("--len", len);
    });
  }

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const deck = document.getElementById("deck");
  const params = new URLSearchParams(location.search);
  const isPresenter = params.get("presenter") === "1";
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("interlude-tcc2-motion") : null;
  const Scenes = (window.Scenes = window.Scenes || {});
  const buildLevel = new Array(total).fill(0);
  let current = -1;
  let buildTimer = null;
  let startTimer = null;

  const sceneOf = (i) => Scenes[slides[i]?.dataset.scene];

  function maxBuild(i) {
    return [...slides[i].querySelectorAll("[data-build]")].reduce((m, el) => Math.max(m, Number(el.dataset.build) || 0), 0);
  }

  function applyBuild(i, instant = false) {
    const slide = slides[i];
    const level = buildLevel[i];
    slide.querySelectorAll("[data-build]").forEach((el) => el.classList.toggle("built", (Number(el.dataset.build) || 0) <= level));
    slide.dataset.buildLevel = String(level);
    sceneOf(i)?.build?.(slide, level, instant);
  }

  function stopPlayback() {
    clearTimeout(buildTimer);
    clearTimeout(startTimer);
    buildTimer = startTimer = null;
  }

  function setLevel(i, level, instant = false) {
    buildLevel[i] = level;
    applyBuild(i, instant);
    renderPresenter();
    if (channel) channel.postMessage({ type: "build", index: i, level });
  }

  // Um avanço revela a sequência inteira, um passo por intervalo. Um segundo
  // avanço durante a reprodução completa tudo, para quem apresenta nunca ficar
  // refém da animação.
  function schedulePlayback() {
    stopPlayback();
    const totalSteps = maxBuild(current);
    if (!totalSteps || buildLevel[current] >= totalSteps) return;
    if (reduced) { setLevel(current, totalSteps, true); return; }
    const slideIndex = current;
    const stepMs = Number(slides[slideIndex].dataset.stepMs) || 1000;
    const step = () => {
      if (current !== slideIndex) return;
      setLevel(slideIndex, buildLevel[slideIndex] + 1);
      if (buildLevel[slideIndex] < totalSteps) buildTimer = setTimeout(step, stepMs);
    };
    startTimer = setTimeout(step, Number(slides[slideIndex].dataset.startDelay) || 850);
  }

  function play(slide) {
    slide.classList.remove("play");
    void slide.offsetWidth;
    slide.classList.add("play");
  }

  function show(index, { broadcast = true, instant = false } = {}) {
    index = Math.max(0, Math.min(total - 1, index));
    if (index !== current && current >= 0) {
      sceneOf(current)?.leave?.(slides[current]);
      slides[current].classList.remove("active", "play");
    }
    stopPlayback();
    current = index;
    const slide = slides[current];
    slide.classList.add("active");
    if (!isPresenter) {
      if (instant) slide.classList.add("play");
      else play(slide);
      if (instant) slide.querySelectorAll("[data-a], .code .ln, .ch").forEach((el) => { el.style.animationDuration = "0s"; el.style.animationDelay = "0s"; });
      else slide.querySelectorAll("[data-a], .code .ln, .ch").forEach((el) => { el.style.animationDuration = ""; el.style.animationDelay = ""; });
      applyBuild(current, instant);
      sceneOf(current)?.enter?.(slide, instant);
      runCounts(slide);
      schedulePlayback();
    }
    history.replaceState(null, "", `#${current + 1}`);
    document.getElementById("counter").textContent = `${pad(current + 1)} / ${pad(total)}`;
    document.getElementById("progress").style.width = `${((current + 1) / total) * 100}%`;
    document.title = `${pad(current + 1)} — ${slide.dataset.title} — Interlude`;
    renderPresenter();
    if (scriptDialog.open) openScript();
    if (broadcast && channel) channel.postMessage({ type: "slide", index: current });
  }

  function next() {
    if (isPresenter) { show(current + 1); return; }
    const scene = sceneOf(current);
    if (scene?.busy?.()) { scene.finish(slides[current]); return; }
    const totalSteps = maxBuild(current);
    if (buildLevel[current] < totalSteps) { stopPlayback(); setLevel(current, totalSteps, true); return; }
    if (current >= total - 1) return;
    buildLevel[current + 1] = 0;
    show(current + 1);
  }

  function previous() {
    if (current <= 0) return;
    const target = current - 1;
    buildLevel[target] = maxBuild(target);
    show(target, { instant: true });
    if (!isPresenter) sceneOf(target)?.finish?.(slides[target]);
  }

  function replay() {
    buildLevel[current] = 0;
    show(current);
  }

  function fit() {
    if (isPresenter) return;
    const scale = Math.min(innerWidth / 1600, innerHeight / 900);
    deck.style.left = `${Math.max(0, (innerWidth - 1600 * scale) / 2)}px`;
    deck.style.top = `${Math.max(0, (innerHeight - 900 * scale) / 2)}px`;
    deck.style.transform = `scale(${scale})`;
  }

  // Notas de fala
  const scriptDialog = document.getElementById("scriptDialog");
  function openScript() {
    const notes = slides[current].querySelector(".speaker-notes");
    document.getElementById("scriptSlide").textContent = `Slide ${pad(current + 1)} — roteiro de fala`;
    document.getElementById("scriptTitle").textContent = slides[current].dataset.title;
    document.getElementById("scriptBody").innerHTML = notes ? notes.innerHTML : "<p>Sem roteiro para este slide.</p>";
    if (!scriptDialog.open) scriptDialog.showModal();
  }

  // Visão geral: os clones são feitos na abertura, depois que as cenas desenharam.
  const overviewDialog = document.getElementById("overviewDialog");
  function openOverview() {
    const grid = document.getElementById("overviewGrid");
    grid.replaceChildren();
    slides.forEach((slide, i) => {
      const item = document.createElement("button");
      item.className = "ov-item" + (i === current ? " current" : "");
      const clone = slide.cloneNode(true);
      clone.removeAttribute("id");
      clone.classList.add("active", "play");
      clone.querySelectorAll("[data-build]").forEach((el) => el.classList.add("built"));
      clone.querySelector(".speaker-notes")?.remove();
      item.appendChild(clone);
      const label = document.createElement("span");
      label.className = "ov-label";
      label.textContent = `${pad(i + 1)} — ${slide.dataset.title}`;
      item.appendChild(label);
      item.addEventListener("click", () => { overviewDialog.close(); buildLevel[i] = 0; show(i); });
      grid.appendChild(item);
    });
    overviewDialog.showModal();
    requestAnimationFrame(() => grid.querySelectorAll(".ov-item").forEach((item) => item.querySelector(".slide").style.setProperty("--thumb-scale", item.clientWidth / 1600)));
  }

  // Apresentador
  const presenter = document.getElementById("presenter");
  const presenterSlides = new Map();
  let presenterIndex = -1;

  // Prepara cada cena uma vez, já completa. As prévias não acompanham os
  // passos da animação da banca nem recriam o roteiro durante sua leitura.
  function presenterSlide(index, frameId) {
    if (!presenterSlides.has(index)) {
      const source = slides[index];
      source.classList.add("active", "play");
      buildLevel[index] = maxBuild(index);
      applyBuild(index, true);
      sceneOf(index)?.enter?.(source, true);
      runCounts(source);
      presenterSlides.set(index, source.cloneNode(true));
      if (index !== current) source.classList.remove("active", "play");
    }
    const clone = presenterSlides.get(index).cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("active", "play");
    clone.querySelectorAll("animate, animateMotion, animateTransform, set, .pkt").forEach((el) => el.remove());

    // Cada prévia tem seus próprios identificadores SVG, sem disputar
    // marcadores e referências com o slide original ou com a outra prévia.
    const ids = new Map();
    clone.querySelectorAll("[id]").forEach((el) => {
      const old = el.id;
      el.id = `${frameId}-${old}`;
      ids.set(old, el.id);
    });
    clone.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        let value = attr.value.replace(/url\(#([^)]*)\)/g, (match, id) => ids.has(id) ? `url(#${ids.get(id)})` : match);
        if (["href", "xlink:href"].includes(attr.name) && value.startsWith("#") && ids.has(value.slice(1))) value = `#${ids.get(value.slice(1))}`;
        if (["aria-labelledby", "aria-describedby"].includes(attr.name)) value = value.split(/\s+/).map((id) => ids.get(id) || id).join(" ");
        if (value !== attr.value) el.setAttribute(attr.name, value);
      }
    });
    return clone;
  }

  function fitFrame(frame) {
    const clone = frame.querySelector(".slide");
    if (clone) clone.style.transform = `scale(${frame.clientWidth / 1600})`;
  }
  function renderPresenter() {
    if (!isPresenter || current === presenterIndex) return;
    presenterIndex = current;
    document.getElementById("pCounter").textContent = `${pad(current + 1)} / ${pad(total)}`;
    const frames = [["pCurrent", current], ["pNextFrame", Math.min(current + 1, total - 1)]];
    frames.forEach(([id, i]) => {
      const frame = document.getElementById(id);
      frame.replaceChildren(presenterSlide(i, id));
      fitFrame(frame);
    });
    const notes = slides[current].querySelector(".speaker-notes");
    document.getElementById("pNotes").innerHTML = notes ? notes.innerHTML : "<p>Sem notas para este slide.</p>";
    document.getElementById("pNotes").scrollTop = 0;
  }

  function openPresenter() {
    const url = new URL(location.href);
    url.searchParams.set("presenter", "1");
    url.hash = `#${current + 1}`;
    window.open(url.href, "interlude-motion-presenter", "popup,width=1440,height=900");
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  let hideTimer = null;
  function showControls() {
    document.body.classList.remove("controls-hidden");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.add("controls-hidden"), 2400);
  }

  function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const open = [scriptDialog, overviewDialog, document.getElementById("helpDialog")].find((d) => d.open);
    if (open) { if (event.key === "Escape") open.close(); return; }
    const k = event.key;
    if (["ArrowRight", "PageDown", " "].includes(k)) { event.preventDefault(); next(); }
    else if (["ArrowLeft", "PageUp"].includes(k)) { event.preventDefault(); previous(); }
    else if (k === "Home") show(0);
    else if (k === "End") show(total - 1, { instant: true });
    else if (k.toLowerCase() === "f") toggleFullscreen();
    else if (k.toLowerCase() === "r") replay();
    else if (isPresenter) return;
    else if (k.toLowerCase() === "o") openOverview();
    else if (k.toLowerCase() === "p") openPresenter();
    else if (k.toLowerCase() === "n") openScript();
    else if (k.toLowerCase() === "h") document.getElementById("helpDialog").showModal();
  }

  function bind(id, fn) {
    document.getElementById(id).addEventListener("click", (e) => { fn(); e.currentTarget.blur(); });
  }

  function start() {
    fillIcons(document);
    slides.forEach(decorate);
    highlightCode(document);
    fillIcons(document);
    slides.forEach((slide) => Scenes[slide.dataset.scene]?.init?.(slide));
    measureDraws(document);

    bind("prevBtn", previous);
    bind("nextBtn", next);
    bind("scriptBtn", openScript);
    bind("overviewBtn", openOverview);
    bind("presenterBtn", openPresenter);
    bind("fullscreenBtn", toggleFullscreen);
    bind("helpBtn", () => document.getElementById("helpDialog").showModal());
    bind("closeScript", () => scriptDialog.close());
    bind("closeHelp", () => document.getElementById("helpDialog").close());
    bind("closeOverview", () => overviewDialog.close());
    bind("pPrev", previous);
    bind("pNext", next);
    bind("pAudience", () => { const u = new URL(location.href); u.searchParams.delete("presenter"); window.open(u.href, "interlude-motion-audience"); });

    addEventListener("resize", () => {
      fit();
      if (isPresenter) ["pCurrent", "pNextFrame"].forEach((id) => fitFrame(document.getElementById(id)));
    });
    addEventListener("keydown", onKey);
    addEventListener("hashchange", () => {
      const n = Number(location.hash.replace(/\D/g, ""));
      if (n >= 1 && n <= total && n - 1 !== current) { buildLevel[n - 1] = 0; show(n - 1, { broadcast: false }); }
    });
    addEventListener("mousemove", showControls);
    let tx = null, ty = null;
    addEventListener("touchstart", (e) => { tx = e.changedTouches[0].clientX; ty = e.changedTouches[0].clientY; }, { passive: true });
    addEventListener("touchend", (e) => {
      if (tx == null) return;
      const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) (dx < 0 ? next : previous)();
      tx = ty = null;
    }, { passive: true });

    channel?.addEventListener("message", (e) => {
      const d = e.data;
      if (d?.type === "slide") { buildLevel[d.index] = 0; show(d.index, { broadcast: false }); }
      else if (!isPresenter && d?.type === "build" && d.index === current) { buildLevel[d.index] = d.level; applyBuild(d.index); }
    });

    if (isPresenter) {
      document.body.classList.add("presenter-mode");
      document.querySelector(".viewport").setAttribute("aria-hidden", "true");
      document.querySelector(".viewport").inert = true;
      presenter.hidden = false;
      const clock = () => { document.getElementById("pClock").textContent = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()); };
      clock();
      setInterval(clock, 1000);
    }

    fit();
    const fromHash = Number(location.hash.replace(/\D/g, ""));
    document.fonts?.ready.then(() => show(fromHash >= 1 && fromHash <= total ? fromHash - 1 : 0, { broadcast: false }));
    showControls();
  }

  window.Deck = { fillIcons, formatNumber, get current() { return current; }, slides, reduced };
  addEventListener("DOMContentLoaded", start);
})();
