import { planRoute, minutesFrom, clock, LOAD_LABEL, LOAD_TITLE, CROWD_LABEL, isTrain, trainKey } from "./timing.js";

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
let arrivals = {}; // bus stop code -> arrivals
let trains = {}; // trainKey(leg) -> scheduled departures + station crowd
let status = null; // train disruptions + bus advisories (null without LTA data)
let lastFetch = null;
let refreshTimer = null;

async function getJson(url) {
  try {
    const r = await fetch(url);
    const body = await r.json();
    return r.ok ? body : { error: body.error || "unavailable" };
  } catch {
    return { error: "offline" };
  }
}

async function refresh() {
  if (routes.length === 0) return renderHome();
  $("#refresh").disabled = true;
  const legs = routes.flatMap((r) => r.legs);
  const busCodes = [...new Set(legs.filter((l) => !isTrain(l)).map((l) => l.board.code))];
  const trainLegs = [...new Map(legs.filter(isTrain).map((l) => [trainKey(l), l])).values()];
  const trainUrl = (l) =>
    `/api/train-leg?${new URLSearchParams({ from: l.board.code, to: l.alight.code, line: l.line, crowdLine: l.crowdLine || "" })}`;
  const [busResults, trainResults, statusBody] = await Promise.all([
    Promise.all(busCodes.map(async (code) => [code, await getJson(`/api/arrivals/${code}`)])),
    Promise.all(trainLegs.map(async (l) => [trainKey(l), await getJson(trainUrl(l))])),
    getJson("/api/status"),
  ]);
  arrivals = Object.fromEntries(busResults);
  trains = Object.fromEntries(trainResults);
  status = statusBody.error ? null : statusBody;
  lastFetch = new Date();
  $("#refresh").disabled = false;
  renderHome();
}

function renderHome() {
  $("#decide-wrap").hidden = routes.length < 2;
  renderDecision();
  const list = $("#routes");
  list.replaceChildren();
  $("#empty").hidden = routes.length > 0;
  $("#updated").textContent = lastFetch ? `Updated ${clock(lastFetch)}` : "";
  const now = new Date();
  routes.forEach((route, idx) => list.append(routeCard(route, idx, planRoute(route, arrivals, now, { trains, status }), now)));
}

// "11/11/2026 14:25-Bus services 5 and 23 are delayed…" -> "Bus services 5 and 23 are delayed…"
const tidy = (text) => String(text || "").replace(/^\s*\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*-\s*/, "").replace(/^\d{4}hrs:\s*/i, "");

function alertBanner(alert, leg) {
  if (alert.kind === "disruption") {
    const at = alert.atYourStations?.length ? ` (affects ${alert.atYourStations.join(", ")})` : "";
    const bus = alert.freeBus && !/free/i.test(alert.text || "") ? " Free bus rides are available." : "";
    return el("p", { class: "alert bad", role: "status" }, el("strong", {}, `${leg.line} disrupted${at}: `), tidy(alert.text), bus);
  }
  return el("p", { class: "alert warn", role: "status" }, el("strong", {}, `Bus ${leg.service}: `), tidy(alert.text));
}

function routeCard(route, idx, plan, now) {
  const first = route.legs[0];
  const loading = !lastFetch;
  const picked = decision && !decision.error && decision.choice === idx;
  const card = el("article", { class: `card ${loading ? "" : plan.status}${picked ? " suggested" : ""}` });
  if (picked) card.append(el("span", { class: "ai-badge" }, "AI pick"));

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
        el("strong", {}, first.service), ` in ${minutesFrom(now, l0.bus)} min`,
        isTrain(first) ? el("span", { class: "sched", title: "LTA timetable: LTA publishes no live train arrivals" }, " (timetable)") : null,
        " · ",
        leaveIn <= 0 ? el("span", { class: "tag tight" }, "leave now") : `leave in ${leaveIn} min`,
      ),
    );
  } else {
    card.append(el("p", { class: "headline" }, el("span", { class: "tag bad" }, problemText(l0, route.legs[0]))));
  }

  const shown = new Set();
  for (const a of plan.alerts || []) {
    if (shown.has(a.text)) continue;
    shown.add(a.text);
    card.append(alertBanner(a, route.legs[a.leg]));
  }

  const ol = el("ol", { class: "legs-list" });
  route.legs.forEach((leg, i) => {
    const p = plan.legs[i];
    const train = isTrain(leg);
    const where = i === 0 ? `${leg.board.name || leg.board.code}` : `walk ${leg.walkBeforeMin} min → ${leg.board.name || leg.board.code}`;
    const towards = train && (p?.towards || leg.towards) ? el("span", { class: "muted" }, ` (towards ${p?.towards || leg.towards})`) : null;
    let detail;
    if (!p) detail = el("span", { class: "muted" }, "—");
    else if (p.bus) {
      const what = train ? "train" : "bus";
      const extra = i === 0
        ? (p.missedEarlier ? ` (${p.missedEarlier} earlier ${what}${p.missedEarlier > 1 ? (train ? "s" : "es") : ""} too soon to catch)` : "")
        : "";
      detail = [
        `${what} at ${clock(p.bus)}`,
        train
          ? el("span", { class: "sched", title: "LTA timetable: LTA publishes no live train arrivals" }, " timetable")
          : p.live === false ? el("span", { class: "sched", title: "Operator's timetable estimate, not live GPS" }, " sched.") : null,
        i > 0 ? el("span", { class: `tag ${p.state === "tight" ? "tight" : "ok"}` }, ` · ${p.waitMin} min spare`) : extra,
        p.load ? el("span", { class: `load load-${p.load.toLowerCase()}`, title: LOAD_TITLE[p.load] }, LOAD_LABEL[p.load]) : null,
        p.crowd
          ? el("span", {
              class: `load crowd-${p.crowd.level}`,
              title: `${leg.board.name || leg.board.code} station crowd: ${p.crowd.level} (LTA ${p.crowd.source === "now" ? "real-time" : "forecast"})`,
            }, CROWD_LABEL[p.crowd.level])
          : null,
      ];
    } else detail = el("span", { class: "tag bad" }, problemText(p, leg));
    ol.append(
      el("li", {},
        el("span", { class: `svc${train ? " train" : ""}` }, leg.service),
        el("div", {}, el("div", {}, where, ` → ${leg.alight.name || leg.alight.code}`, towards), el("div", { class: "muted" }, detail)),
      ),
    );
  });
  card.append(ol);

  if (plan.arriveAt) card.append(el("p", { class: "arrive" }, `Arrive around ${clock(plan.arriveAt)} (if you leave now)`));
  const note = decision && !decision.error ? decision.notes?.[idx] : null;
  if (note) card.append(el("p", { class: "ai-note" }, note));
  return card;
}

function problemText(p, leg) {
  if (isTrain(leg)) {
    switch (p?.state) {
      case "unavailable": return "Train timetable unavailable (needs LTA data on the server)";
      case "no-service": return `No scheduled ${leg.line} trains this way in the next 2 hours`;
      case "beyond-data": return `No scheduled ${leg.line} train known after you reach the platform`;
      default: return "No timing";
    }
  }
  switch (p?.state) {
    case "unavailable": return "Service unavailable: check this stop manually";
    case "no-service": return `No ${leg.service} reported at this stop right now`;
    case "beyond-data": return `You'd miss the buses shown; next ${leg.service} not known yet`;
    default: return "No timing";
  }
}

// ---------- Help me decide (AI) ----------
let decision = null;

async function helpMeDecide() {
  const btn = $("#decide");
  btn.disabled = true;
  btn.textContent = "Comparing your routes…";
  try {
    const r = await fetch("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routes }),
    });
    decision = await r.json();
  } catch {
    decision = { error: "Couldn't reach the server." };
  } finally {
    btn.disabled = false;
    btn.textContent = "Help me decide";
  }
  renderHome();
}

function renderDecision() {
  const box = $("#decision");
  if (!decision) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("err", Boolean(decision.error));
  const close = el("button", { class: "icon-btn small", "aria-label": "Dismiss suggestion", onclick: () => { decision = null; renderHome(); } }, "×");
  if (decision.error) {
    box.replaceChildren(el("div", { class: "decision-head" }, el("p", {}, decision.error), close));
    return;
  }
  const route = routes[decision.choice];
  const kids = [
    el("div", { class: "decision-head" },
      el("div", {},
        el("p", { class: "decision-label" }, "AI suggestion"),
        el("p", { class: "decision-headline" }, decision.headline || `Take ${route?.name}`),
      ),
      close,
    ),
    el("p", { class: "decision-reason" }, decision.reason),
  ];
  if (decision.weather?.areas?.length) {
    kids.push(el("p", { class: "decision-weather" },
      `Rain forecast${decision.weather.validFor ? ` (${decision.weather.validFor})` : ""}: `,
      decision.weather.areas.map((a) => `${a.area} ${a.forecast}`).join(" · "),
    ));
  } else {
    kids.push(el("p", { class: "decision-weather" }, "Weather forecast unavailable; based on timings only."));
  }
  const at = decision.decidedAt ? clock(new Date(decision.decidedAt)) : "";
  kids.push(el("p", { class: "decision-meta" }, `${decision.model} at ${at}. Timings keep changing; tap again to re-check.`));
  box.replaceChildren(...kids);
}

$("#decide").addEventListener("click", helpMeDecide);

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
  if (leg && isTrain(leg)) {
    f("mode").value = "train";
    f("tFrom").value = leg.board.name || leg.board.code;
    f("tTo").value = leg.alight.name || leg.alight.code;
    f("tRide").value = leg.rideMin;
    f("walkBeforeMin").value = leg.walkBeforeMin || 0;
    setTrainOptions(fs, { board: leg.board.name || leg.board.code, alight: leg.alight.name || leg.alight.code, options: [optionFromLeg(leg)] });
  } else if (leg) {
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
  f("mode").addEventListener("change", () => setMode(fs, f("mode").value));
  for (const name of ["tFrom", "tTo"]) f(name).addEventListener("change", () => checkTrain(fs));
  f("tOption").addEventListener("change", () => {
    const o = selectedTrainOption(fs);
    if (o) f("tRide").value = o.ride_min;
  });
  fs.querySelector(".remove-leg").addEventListener("click", () => {
    fs.remove();
    relabelLegs();
  });
  setMode(fs, f("mode").value);
  $("#legs").append(fs);
  relabelLegs();
}

// Show the bus or train inputs; hidden inputs are disabled so they don't block form validation.
function setMode(fs, mode) {
  for (const [sel, on] of [[".bus-fields", mode === "bus"], [".train-fields", mode === "train"]]) {
    const group = fs.querySelector(sel);
    group.hidden = !on;
    for (const input of group.querySelectorAll("input, select")) input.disabled = !on;
  }
}

// A saved train leg, shaped like one option from /api/trains/check.
function optionFromLeg(leg) {
  return {
    line: leg.line,
    line_name: leg.lineName || leg.line,
    crowd_line: leg.crowdLine || null,
    towards: leg.towards || null,
    board_code: leg.board.code,
    alight_code: leg.alight.code,
    ride_min: leg.rideMin,
  };
}

function setTrainOptions(fs, check) {
  fs.trainCheck = check;
  const options = check?.options || [];
  fs.querySelector("[name=tOption]").replaceChildren(
    ...options.map((o, i) => {
      const stops = o.stops_travelled ? ` · ${o.stops_travelled} stop${o.stops_travelled > 1 ? "s" : ""}` : "";
      return el("option", { value: String(i) }, `${o.line_name || o.line}${o.towards ? ` towards ${o.towards}` : ""}${stops} · ~${o.ride_min} min`);
    }),
  );
  const o = options[0];
  setTrainStatus(fs, o ? `${check.board} (${o.board_code}) → ${check.alight} (${o.alight_code})` : "");
}

function setTrainStatus(fs, text, bad = false) {
  const n = fs.querySelector(".train-status");
  n.textContent = text;
  n.classList.toggle("bad", bad);
}

function selectedTrainOption(fs) {
  return fs.trainCheck?.options?.[Number(fs.querySelector("[name=tOption]").value)] || null;
}

// Ask the server which lines run directly between the two stations typed in.
async function checkTrain(fs) {
  const from = fs.querySelector("[name=tFrom]").value.trim();
  const to = fs.querySelector("[name=tTo]").value.trim();
  setTrainOptions(fs, null);
  if (!from || !to) return;
  setTrainStatus(fs, "Checking the timetable…");
  const body = await getJson(`/api/trains/check?${new URLSearchParams({ from, to })}`);
  if (body.error) return setTrainStatus(fs, body.error, true);
  setTrainOptions(fs, body);
  const o = selectedTrainOption(fs);
  if (o) fs.querySelector("[name=tRide]").value = o.ride_min;
}

function relabelLegs() {
  const sets = [...document.querySelectorAll("#legs .leg")];
  sets.forEach((fs, i) => {
    fs.querySelector("legend").textContent = i === 0 ? "First leg" : `Transfer ${i}`;
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
    const walkBeforeMin = i === 0 ? 0 : Math.max(0, parseInt(v("walkBeforeMin"), 10) || 0);
    if (v("mode") === "train") {
      const o = selectedTrainOption(fs);
      if (!o) return { invalid: "train" };
      return {
        mode: "train",
        service: o.line,
        line: o.line,
        lineName: o.line_name || o.line,
        crowdLine: o.crowd_line || null,
        towards: o.towards || null,
        board: { code: o.board_code, name: fs.trainCheck.board },
        alight: { code: o.alight_code, name: fs.trainCheck.alight },
        rideMin: Math.max(1, parseInt(v("tRide"), 10) || o.ride_min || 1),
        walkBeforeMin,
      };
    }
    return {
      service: v("service").toUpperCase(),
      board: { code: v("board"), name: name("board") },
      alight: { code: v("alight"), name: name("alight") },
      rideMin: Math.max(1, parseInt(v("rideMin"), 10) || 1),
      walkBeforeMin,
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
  if (route.legs.some((l) => l.invalid)) return showEditorError("For each train leg, enter both stations and pick a line and direction.");
  if (!saveRoutesWith(route)) return showEditorError("Couldn't save on this device (storage is blocked).");
  show("home");
  refresh();
});

function saveRoutesWith(route) {
  decision = null; // route list changed, old suggestion no longer applies
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
  decision = null;
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
