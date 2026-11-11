import { planRoute, minutesFrom, clock } from "./timing.js";

const STORAGE_KEY = "kakiroute.routes.v1";
const REFRESH_MS = 20_000;

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
};

// ---------- Storage ----------
function loadRoutes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveRoutes(routes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(routes));
    return true;
  } catch {
    return false;
  }
}
let routes = loadRoutes();

// ---------- Home: live timings ----------
let arrivals = {};
let lastFetch = null;
let refreshTimer = null;

async function refresh() {
  if (routes.length === 0) return renderHome();
  $("#refresh").disabled = true;
  const codes = [...new Set(routes.flatMap((r) => r.legs.map((l) => l.board.code)))];
  const results = await Promise.all(
    codes.map(async (code) => {
      try {
        const r = await fetch(`/api/arrivals/${code}`);
        const body = await r.json();
        return [code, r.ok ? body : { error: body.error || "unavailable" }];
      } catch {
        return [code, { error: "offline" }];
      }
    }),
  );
  arrivals = Object.fromEntries(results);
  lastFetch = new Date();
  $("#refresh").disabled = false;
  renderHome();
}

function renderHome() {
  const list = $("#routes");
  list.replaceChildren();
  $("#empty").hidden = routes.length > 0;
  $("#updated").textContent = lastFetch ? `Updated ${clock(lastFetch)}` : "";
  const now = new Date();
  routes.forEach((route, idx) => list.append(routeCard(route, idx, planRoute(route, arrivals, now), now)));
}

function routeCard(route, idx, plan, now) {
  const first = route.legs[0];
  const loading = !lastFetch;
  const card = el("article", { class: `card ${loading ? "" : plan.status}` });

  card.append(
    el("div", { class: "card-head" },
      el("p", { class: "route-name" }, route.name),
      el("button", { class: "link-btn edit-link", onclick: () => openEditor(idx) }, "Edit"),
    ),
    el("p", { class: "walk-to" }, `Walk to ${first.board.name || first.board.code} `, el("small", {}, first.board.code)),
  );

  if (loading) {
    card.append(el("p", { class: "headline muted" }, "Loading timings…"));
    return card;
  }

  const l0 = plan.legs[0];
  if (l0?.bus) {
    const leaveIn = minutesFrom(now, plan.leaveBy);
    card.append(
      el("p", { class: "headline" },
        el("strong", {}, first.service), ` in ${minutesFrom(now, l0.bus)} min · `,
        leaveIn <= 0 ? el("span", { class: "tag tight" }, "leave now") : `leave in ${leaveIn} min`,
      ),
    );
  } else {
    card.append(el("p", { class: "headline" }, el("span", { class: "tag bad" }, problemText(l0, route.legs[0]))));
  }

  const ol = el("ol", { class: "legs-list" });
  route.legs.forEach((leg, i) => {
    const p = plan.legs[i];
    const where = i === 0 ? `${leg.board.name || leg.board.code}` : `walk ${leg.walkBeforeMin} min → ${leg.board.name || leg.board.code}`;
    let detail;
    if (!p) detail = el("span", { class: "muted" }, "—");
    else if (p.bus) {
      const extra = i === 0
        ? (p.missedEarlier ? ` (${p.missedEarlier} earlier bus${p.missedEarlier > 1 ? "es" : ""} too soon to catch)` : "")
        : "";
      detail = [
        `bus at ${clock(p.bus)}`,
        i > 0 ? el("span", { class: `tag ${p.state === "tight" ? "tight" : "ok"}` }, ` · ${p.waitMin} min spare`) : extra,
      ];
    } else detail = el("span", { class: "tag bad" }, problemText(p, leg));
    ol.append(
      el("li", {},
        el("span", { class: "svc" }, leg.service),
        el("div", {}, el("div", {}, where, ` → ${leg.alight.name || leg.alight.code}`), el("div", { class: "muted" }, detail)),
      ),
    );
  });
  card.append(ol);

  if (plan.arriveAt) card.append(el("p", { class: "arrive" }, `Arrive around ${clock(plan.arriveAt)} (if you leave now)`));
  return card;
}

function problemText(p, leg) {
  switch (p?.state) {
    case "unavailable": return "Service unavailable: check this stop manually";
    case "no-service": return `No ${leg.service} reported at this stop right now`;
    case "beyond-data": return `You'd miss the buses shown; next ${leg.service} not known yet`;
    default: return "No timing";
  }
}

// ---------- Add / edit ----------
let editingIdx = null;
let setupSession = null;

function show(view) {
  $("#view-home").hidden = view !== "home";
  $("#view-edit").hidden = view !== "edit";
  window.scrollTo(0, 0);
}

function openEditor(idx = null) {
  editingIdx = idx;
  setupSession = null;
  $("#chat").replaceChildren();
  $("#answer-form").hidden = true;
  $("#describe").value = "";
  $("#ai-notes").hidden = true;
  $("#editor-error").hidden = true;
  $("#delete-route").hidden = idx == null;
  $("#edit-title").textContent = idx == null ? "Add a route" : "Edit route";
  if (idx == null) {
    $("#ai-panel").hidden = false;
    $("#editor").hidden = true;
  } else {
    $("#ai-panel").hidden = true;
    fillEditor(routes[idx]);
  }
  show("edit");
}

function fillEditor(route) {
  $("#r-name").value = route?.name || "";
  $("#r-walk").value = route?.walkFromHomeMin ?? 3;
  $("#legs").replaceChildren();
  const legs = route?.legs?.length ? route.legs : [null];
  legs.forEach((leg) => addLegFieldset(leg));
  $("#editor").hidden = false;
}

function addLegFieldset(leg) {
  const frag = $("#leg-template").content.cloneNode(true);
  const fs = frag.querySelector("fieldset");
  const f = (name) => fs.querySelector(`[name=${name}]`);
  if (leg) {
    f("service").value = leg.service;
    f("board").value = leg.board.code;
    f("alight").value = leg.alight.code;
    f("rideMin").value = leg.rideMin;
    f("walkBeforeMin").value = leg.walkBeforeMin || 0;
    setStopName(fs, "board", leg.board.name);
    setStopName(fs, "alight", leg.alight.name);
  }
  for (const name of ["board", "alight"]) {
    f(name).addEventListener("change", () => lookupStop(fs, name));
  }
  fs.querySelector(".remove-leg").addEventListener("click", () => {
    fs.remove();
    relabelLegs();
  });
  $("#legs").append(fs);
  relabelLegs();
}

function relabelLegs() {
  const sets = [...document.querySelectorAll("#legs .leg")];
  sets.forEach((fs, i) => {
    fs.querySelector("legend").textContent = i === 0 ? "First bus" : `Transfer ${i}`;
    fs.querySelector(".walk-before").hidden = i === 0;
    fs.querySelector(".remove-leg").hidden = sets.length === 1;
  });
}

function setStopName(fs, which, name, bad = false) {
  const n = fs.querySelector(`.stopname[data-for=${which}]`);
  n.textContent = name || "";
  n.classList.toggle("bad", bad);
  n.dataset.name = bad ? "" : name || "";
}

async function lookupStop(fs, which) {
  const code = fs.querySelector(`[name=${which}]`).value.trim();
  if (!/^\d{5}$/.test(code)) return setStopName(fs, which, code ? "Stop codes are 5 digits" : "", true);
  try {
    const r = await fetch(`/api/stops/${code}`);
    if (r.status === 404) return setStopName(fs, which, "Unknown stop code", true);
    if (!r.ok) return setStopName(fs, which, "");
    setStopName(fs, which, (await r.json()).name);
  } catch {
    setStopName(fs, which, "");
  }
}

function readEditor() {
  const legs = [...document.querySelectorAll("#legs .leg")].map((fs, i) => {
    const v = (name) => fs.querySelector(`[name=${name}]`).value.trim();
    const name = (which) => fs.querySelector(`.stopname[data-for=${which}]`).dataset.name || "";
    return {
      service: v("service").toUpperCase(),
      board: { code: v("board"), name: name("board") },
      alight: { code: v("alight"), name: name("alight") },
      rideMin: Math.max(1, parseInt(v("rideMin"), 10) || 1),
      walkBeforeMin: i === 0 ? 0 : Math.max(0, parseInt(v("walkBeforeMin"), 10) || 0),
    };
  });
  return {
    name: $("#r-name").value.trim(),
    walkFromHomeMin: Math.max(0, parseInt($("#r-walk").value, 10) || 0),
    legs,
  };
}

$("#editor").addEventListener("submit", (e) => {
  e.preventDefault();
  const route = readEditor();
  if (!route.name) return showEditorError("Give the route a name.");
  if (!saveRoutesWith(route)) return showEditorError("Couldn't save on this device (storage is blocked).");
  show("home");
  refresh();
});

function saveRoutesWith(route) {
  const next = [...routes];
  if (editingIdx == null) next.push(route);
  else next[editingIdx] = route;
  if (!saveRoutes(next)) return false;
  routes = next;
  return true;
}

function showEditorError(msg) {
  const n = $("#editor-error");
  n.textContent = msg;
  n.hidden = false;
}

$("#delete-route").addEventListener("click", () => {
  if (editingIdx == null || !confirm("Delete this route?")) return;
  const next = routes.filter((_, i) => i !== editingIdx);
  if (saveRoutes(next)) routes = next;
  show("home");
  renderHome();
});

$("#add-leg").addEventListener("click", () => addLegFieldset(null));
$("#manual").addEventListener("click", () => fillEditor(null));
$("#back").addEventListener("click", () => {
  show("home");
  renderHome();
});
$("#add-route").addEventListener("click", () => openEditor(null));
$("#refresh").addEventListener("click", refresh);

// ---------- AI route setup ----------
function bubble(text, who) {
  const b = el("div", { class: `bubble ${who}` }, text);
  $("#chat").append(b);
  b.scrollIntoView({ block: "nearest" });
  return b;
}

async function callSetup(path, payload) {
  const thinking = bubble("Looking up stops…", "ai thinking");
  $("#ai-start").disabled = true;
  $("#answer-form").hidden = true;
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json();
  } catch {
    return { type: "error", message: "Couldn't reach the server. You can enter the route manually." };
  } finally {
    thinking.remove();
    $("#ai-start").disabled = false;
  }
}

function handleSetup(res) {
  if (res.sessionId) setupSession = res.sessionId;
  if (res.type === "question") {
    bubble(res.question, "ai");
    const opts = $("#answer-options");
    opts.replaceChildren(...(res.options || []).map((o) => el("button", { type: "button", class: "chip", onclick: () => answer(o) }, o)));
    $("#answer").value = "";
    $("#answer").placeholder = "Your answer";
    $("#answer-form").hidden = false;
    $("#answer").focus();
  } else if (res.type === "proposal") {
    bubble("Here's your route. Check the stops and times below, change anything that's off, then save. You can also type a correction above.", "ai");
    $("#ai-notes").textContent = res.notes || "";
    $("#ai-notes").hidden = !res.notes;
    $("#answer-options").replaceChildren();
    $("#answer").value = "";
    $("#answer").placeholder = "Type a correction (optional)";
    $("#answer-form").hidden = false;
    fillEditor(res.route);
    $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    bubble(res.message || "Something went wrong.", "err");
    if (!$("#editor").hidden) return;
    fillEditor(null);
  }
}

async function answer(text) {
  if (!text.trim() || !setupSession) return;
  bubble(text, "me");
  handleSetup(await callSetup("/api/setup/reply", { sessionId: setupSession, text }));
}

$("#ai-start").addEventListener("click", async () => {
  const text = $("#describe").value.trim();
  if (!text) return $("#describe").focus();
  $("#chat").replaceChildren();
  setupSession = null;
  bubble(text, "me");
  handleSetup(await callSetup("/api/setup/start", { text }));
});

$("#answer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  answer($("#answer").value);
});

// ---------- Boot ----------
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !$("#view-home").hidden) refresh();
  }, REFRESH_MS);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("#view-home").hidden) refresh();
});

renderHome();
refresh();
startAutoRefresh();
