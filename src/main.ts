// Heart rate zone monitor for indoor/stationary bike training, using the standard Bluetooth Heart Rate service.
const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;
// Readings are recorded once per second; the display refreshes at the rate picked in the dropdown.
const SAMPLE_SEC = 1;
const REFRESH_OPTIONS = [1, 2, 3, 5, 10];
const HISTORY_POINTS = 6 * 3600; // whole session, up to 6 hours at 1 point per second
const SETTINGS_KEY = "hrZonesSettings.v2";
const CURRENT_KEY = "hrZonesCurrentRide.v1";
const HISTORY_KEY = "hrZonesRideHistory.v1";
const MAX_SAVED_RIDES = 30;
const WARMUP_SEC = 600; // first 10 min excluded from drift
const MIN_DRIFT_SEC = 1200; // need 20 min after warm-up
// Cycling max HR typically runs ~5 bpm below running max (seated, less muscle mass loaded).
const BIKE_MAX_OFFSET = 5;

// Position relative to the target zone.
type ZoneState = "below" | "in" | "above";
type MaxMethod = "tanaka" | "fox" | "manual";

interface Settings {
  age: number;
  sex: "male" | "female";
  weightKg: number;
  restHr: number | null; // set = Karvonen (heart rate reserve) zones
  maxMethod: MaxMethod;
  maxHr: number | null; // used when maxMethod is "manual"
  target: number; // 1..5
  beep: boolean;
  refreshSec: number;
}

interface ZoneDef {
  n: number;
  name: string;
  lo: number; // fraction of max HR (or of HR reserve with Karvonen)
  hi: number;
  color: string;
  feel: string;
  cadence: string;
  workout: string;
}

const ZONES: ZoneDef[] = [
  {
    n: 1,
    name: "Recovery",
    lo: 0.5,
    hi: 0.6,
    color: "--z1",
    feel: "Very easy spin, chatting freely",
    cadence: "80–90 rpm, very light resistance",
    workout: "10 min warm-up and 5–10 min cool-down every ride, or 30 min recovery spin",
  },
  {
    n: 2,
    name: "Endurance",
    lo: 0.6,
    hi: 0.7,
    color: "--z2",
    feel: "Easy, full sentences, nose breathing",
    cadence: "85–95 rpm, light to moderate resistance",
    workout: "45–90 min steady, 3–4× per week. Lower the resistance when HR drifts up",
  },
  {
    n: 3,
    name: "Tempo",
    lo: 0.7,
    hi: 0.8,
    color: "--z3",
    feel: "Moderate, short sentences only",
    cadence: "85–95 rpm, moderate resistance",
    workout: "2 × 15 min with 5 min easy spin between, at most 1× per week",
  },
  {
    n: 4,
    name: "Threshold",
    lo: 0.8,
    hi: 0.9,
    color: "--z4",
    feel: "Hard, a few words at a time",
    cadence: "85–100 rpm, hard resistance",
    workout: "4 × 8 min with 4 min easy spin between, 1× per week",
  },
  {
    n: 5,
    name: "VO₂ max",
    lo: 0.9,
    hi: 1.0,
    color: "--z5",
    feel: "All-out, can't talk",
    cadence: "95–110 rpm, high resistance",
    workout: "5 × 3 min with 3 min easy spin between, 1× per week after 4–6 weeks of base",
  },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  conn: $("conn"),
  unsupported: $("unsupported"),
  card: $("card"),
  bpm: $("bpm"),
  zoneBadge: $("zoneBadge"),
  zoneLabel: $("zoneLabel"),
  targetName: $("targetName"),
  targetRange: $("targetRange"),
  targetCadence: $("targetCadence"),
  zbar: $("zbar"),
  zbarLegend: $("zbarLegend"),
  connectBtn: $<HTMLButtonElement>("connectBtn"),
  demoBtn: $<HTMLButtonElement>("demoBtn"),
  focusBtn: $<HTMLButtonElement>("focusBtn"),
  exitFocusBtn: $<HTMLButtonElement>("exitFocusBtn"),
  finishBtn: $<HTMLButtonElement>("finishBtn"),
  discardBtn: $<HTMLButtonElement>("discardBtn"),
  restored: $("restored"),
  trend: $("trend"),
  drift: $("drift"),
  fTime: $("fTime"),
  fPct: $("fPct"),
  fAvg: $("fAvg"),
  historyList: $("historyList"),
  historyEmpty: $("historyEmpty"),
  sessionTime: $("sessionTime"),
  zoneTime: $("zoneTime"),
  zonePct: $("zonePct"),
  avgBpm: $("avgBpm"),
  maxBpm: $("maxBpm"),
  chartInfo: $("chartInfo"),
  kcal: $("kcal"),
  zoneTimes: $("zoneTimes"),
  chart: $<HTMLCanvasElement>("chart"),
  profileLine: $("profileLine"),
  zonesTable: $("zonesTable"),
  weekPlan: $("weekPlan"),
  age: $<HTMLInputElement>("age"),
  sex: $<HTMLSelectElement>("sex"),
  weight: $<HTMLInputElement>("weight"),
  restHr: $<HTMLInputElement>("restHr"),
  maxMethod: $<HTMLSelectElement>("maxMethod"),
  maxHr: $<HTMLInputElement>("maxHr"),
  target: $<HTMLSelectElement>("target"),
  beep: $<HTMLInputElement>("beep"),
  refreshSel: $<HTMLSelectElement>("refreshSel"),
  showAll: $<HTMLInputElement>("showAll"),
  knownWrap: $("knownWrap"),
  knownList: $("knownList"),
};

// ---------- settings ----------

function loadSettings(): Settings {
  const defaults: Settings = {
    age: 29,
    sex: "male",
    weightKg: 79,
    restHr: null,
    maxMethod: "tanaka",
    maxHr: null,
    target: 2,
    beep: false,
    refreshSec: 5,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable, settings just won't persist */
  }
}

let settings = loadSettings();

function estimatedMaxHr(method: MaxMethod) {
  const base = method === "fox" ? 220 - settings.age : 208 - 0.7 * settings.age;
  return Math.round(base - BIKE_MAX_OFFSET);
}

function effectiveMaxHr() {
  if (settings.maxMethod === "manual" && settings.maxHr) return settings.maxHr;
  return estimatedMaxHr(settings.maxMethod === "fox" ? "fox" : "tanaka");
}

// bpm at a given intensity fraction, by % of max HR or Karvonen when resting HR is known.
function bpmAt(frac: number) {
  const max = effectiveMaxHr();
  const rest = settings.restHr;
  return Math.round(rest ? rest + frac * (max - rest) : frac * max);
}

function zoneRanges() {
  return ZONES.map((z) => ({ ...z, low: bpmAt(z.lo), high: bpmAt(z.hi) }));
}

// Zone number 0..5 for a bpm (0 = below zone 1).
function zoneNumber(bpm: number) {
  const ranges = zoneRanges();
  for (let i = ranges.length - 1; i >= 0; i--) if (bpm >= ranges[i].low) return ranges[i].n;
  return 0;
}

function targetRange() {
  return zoneRanges()[settings.target - 1];
}

function relationToTarget(bpm: number): ZoneState {
  const { low, high } = targetRange();
  if (bpm < low) return "below";
  if (bpm >= high && settings.target < 5) return "above";
  return "in";
}

function syncSettingsForm() {
  els.age.value = String(settings.age);
  els.sex.value = settings.sex;
  els.weight.value = String(settings.weightKg);
  els.restHr.value = settings.restHr ? String(settings.restHr) : "";
  els.maxMethod.value = settings.maxMethod;
  els.target.value = String(settings.target);
  els.beep.checked = settings.beep;
  syncMaxField();
}

function syncMaxField() {
  const manual = settings.maxMethod === "manual";
  els.maxHr.disabled = !manual;
  els.maxHr.value = String(manual && settings.maxHr ? settings.maxHr : effectiveMaxHr());
}

function onSettingsChange() {
  const age = parseInt(els.age.value, 10);
  if (age >= 10 && age <= 100) settings.age = age;
  const weight = parseFloat(els.weight.value);
  if (weight >= 30 && weight <= 250) settings.weightKg = weight;
  settings.sex = els.sex.value === "female" ? "female" : "male";
  const rest = parseInt(els.restHr.value, 10);
  settings.restHr = rest >= 30 && rest <= 110 ? rest : null;
  settings.maxMethod = els.maxMethod.value as MaxMethod;
  const maxHr = parseInt(els.maxHr.value, 10);
  if (settings.maxMethod === "manual") settings.maxHr = maxHr >= 100 && maxHr <= 230 ? maxHr : settings.maxHr;
  settings.target = Math.min(5, Math.max(1, parseInt(els.target.value, 10) || 2));
  settings.beep = els.beep.checked;
  syncMaxField();
  saveSettings();
  renderZones();
  if (lastShown !== null) renderReading(lastShown);
  renderStats();
  drawChart();
}

// ---------- session state ----------

let windowReadings: number[] = []; // raw readings since the last 5s tick
let lastShown: number | null = null;
let lastRelation: ZoneState | null = null;
let hrHistory: number[] = [];
let sessionSec = 0;
let zoneSecs = [0, 0, 0, 0, 0, 0]; // index 0 = below zone 1
let bpmSum = 0;
let bpmCount = 0;
let peakBpm = 0;
let kcalTotal = 0;
let lastReadingAt = 0;
let sessionStart: number | null = null;

function resetSession() {
  sessionStart = null;
  windowReadings = [];
  hrHistory = [];
  sessionSec = 0;
  zoneSecs = [0, 0, 0, 0, 0, 0];
  bpmSum = 0;
  bpmCount = 0;
  peakBpm = 0;
  kcalTotal = 0;
  clearCurrent();
  renderStats();
  drawChart();
}

// ---------- persistence (current ride survives a refresh; finished rides go to history) ----------

interface SavedRide {
  start: number;
  sessionSec: number;
  zoneSecs: number[];
  bpmSum: number;
  bpmCount: number;
  peakBpm: number;
  kcalTotal: number;
  target: number;
  hr: number[];
  step?: number; // seconds per hr point (older rides used 5)
  savedAt: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

function snapshot(): SavedRide {
  return {
    start: sessionStart ?? Date.now(),
    sessionSec,
    zoneSecs,
    bpmSum,
    bpmCount,
    peakBpm,
    kcalTotal,
    target: settings.target,
    hr: hrHistory,
    step: SAMPLE_SEC,
    savedAt: Date.now(),
  };
}

function saveCurrent() {
  writeJson(CURRENT_KEY, snapshot());
}

function clearCurrent() {
  try {
    localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* ignore */
  }
}

// Restore an unfinished ride from the last 6 hours (e.g. after an accidental refresh).
function restoreCurrent() {
  const r = readJson<SavedRide | null>(CURRENT_KEY, null);
  if (!r || !r.bpmCount || Date.now() - r.savedAt > 6 * 3600 * 1000) return;
  sessionStart = r.start;
  sessionSec = r.sessionSec;
  zoneSecs = r.zoneSecs;
  bpmSum = r.bpmSum;
  bpmCount = r.bpmCount;
  peakBpm = r.peakBpm;
  kcalTotal = r.kcalTotal;
  // Older saves stored one point per 5 s; stretch them to the current resolution.
  const k = Math.max(1, Math.round((r.step ?? 5) / SAMPLE_SEC));
  hrHistory = k === 1 ? r.hr : r.hr.flatMap((v) => Array(k).fill(v));
  els.restored.hidden = false;
  setTimeout(() => (els.restored.hidden = true), 8000);
}

function loadHistory() {
  return readJson<SavedRide[]>(HISTORY_KEY, []);
}

function finishRide() {
  if (sessionSec < 60) {
    resetSession();
    return;
  }
  if (!confirm("Save this ride to your history and start a new one?")) return;
  const rides = [snapshot(), ...loadHistory()].slice(0, MAX_SAVED_RIDES);
  writeJson(HISTORY_KEY, rides);
  resetSession();
  renderHistory();
}

function discardRide() {
  if (sessionSec >= 60 && !confirm("Discard the current ride without saving?")) return;
  resetSession();
}

function downloadCsv(ride: SavedRide) {
  const step = ride.step ?? 5;
  const lines = ["elapsed_seconds,bpm,zone", ...ride.hr.map((b, i) => `${i * step},${b},${zoneNumber(b)}`)];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ride-${new Date(ride.start).toISOString().slice(0, 16).replace(":", "")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderHistory() {
  const rides = loadHistory();
  els.historyEmpty.hidden = rides.length > 0;
  els.historyList.replaceChildren(
    ...rides.map((ride, idx) => {
      const li = document.createElement("li");
      const pct = ride.sessionSec ? Math.round(((ride.zoneSecs[ride.target] ?? 0) / ride.sessionSec) * 100) : 0;
      const d = driftOf(ride.hr, ride.step ?? 5);
      const when = new Date(ride.start).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      li.innerHTML = `
        <div class="h-top"><b>${when}</b><span class="muted">${fmtTime(ride.sessionSec)}</span></div>
        <div class="h-stats">
          <span><b>${pct}%</b> in Z${ride.target}</span>
          <span>avg <b>${Math.round(ride.bpmSum / ride.bpmCount)}</b></span>
          <span>peak <b>${ride.peakBpm}</b></span>
          <span>drift <b class="${d === null ? "" : driftClass(d)}">${d === null ? "--" : fmtDrift(d)}</b></span>
          <span><b>${Math.round(ride.kcalTotal)}</b> kcal</span>
        </div>`;
      const btns = document.createElement("div");
      btns.className = "h-btns";
      const csv = Object.assign(document.createElement("button"), { className: "link", textContent: "Download CSV" });
      csv.addEventListener("click", () => downloadCsv(ride));
      const del = Object.assign(document.createElement("button"), { className: "link danger", textContent: "Delete" });
      del.addEventListener("click", () => {
        if (!confirm("Delete this ride?")) return;
        const all = loadHistory();
        all.splice(idx, 1);
        writeJson(HISTORY_KEY, all);
        renderHistory();
      });
      btns.append(csv, del);
      li.append(btns);
      return li;
    }),
  );
}

// ---------- aerobic drift and trend ----------

// HR drift (%): average of the 2nd half vs the 1st half, after a 10 min warm-up.
// At a steady effort, under 5% suggests a solid aerobic base.
function driftOf(hr: number[], step = SAMPLE_SEC): number | null {
  const body = hr.slice(Math.round(WARMUP_SEC / step));
  if (body.length * step < MIN_DRIFT_SEC) return null;
  const mid = Math.floor(body.length / 2);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return (avg(body.slice(mid)) / avg(body.slice(0, mid)) - 1) * 100;
}

function fmtDrift(d: number) {
  const r = Math.round(d * 10) / 10;
  return `${r > 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)}%`;
}

function driftClass(d: number) {
  return d < 5 ? "d-good" : d < 8 ? "d-warn" : "d-bad";
}

function renderTrend() {
  const n = hrHistory.length;
  const back = Math.round(30 / SAMPLE_SEC);
  if (n <= back) {
    els.trend.textContent = "";
    return;
  }
  const diff = hrHistory[n - 1] - hrHistory[n - 1 - back];
  els.trend.textContent = diff >= 3 ? "↑" : diff <= -3 ? "↓" : "→";
  els.trend.className = `trend ${diff >= 3 ? "up" : diff <= -3 ? "down" : "flat"}`;
}

function onReading(bpm: number) {
  if (bpm <= 0) return; // sensor reports 0 when it has no skin contact
  windowReadings.push(bpm);
  lastReadingAt = Date.now();
  // Show the first value immediately instead of waiting for the first tick.
  if (lastShown === null) renderReading(bpm);
}

let sampleCount = 0;
let displaySamples: number[] = []; // recorded samples since the last display refresh
let displayTimer: number | undefined;

// Records one sample per second: stats, history and auto-save.
function sample() {
  let value: number | null = null;
  if (windowReadings.length > 0) {
    value = Math.round(windowReadings.reduce((a, b) => a + b, 0) / windowReadings.length);
  } else if (hrHistory.length && Date.now() - lastReadingAt < 15000) {
    value = hrHistory[hrHistory.length - 1]; // sensors can skip a few notifications; hold briefly
  }
  windowReadings = [];

  if (value === null) {
    if (lastShown !== null && !demoTimer && !device?.gatt?.connected) showNoSignal();
    return;
  }

  sessionStart ??= Date.now();
  sessionSec += SAMPLE_SEC;
  zoneSecs[zoneNumber(value)] += SAMPLE_SEC;
  bpmSum += value;
  bpmCount += 1;
  peakBpm = Math.max(peakBpm, value);
  kcalTotal += kcalPerMinute(value) * (SAMPLE_SEC / 60);
  hrHistory.push(value);
  if (hrHistory.length > HISTORY_POINTS) hrHistory.shift();
  displaySamples.push(value);

  if (++sampleCount % 5 === 0) saveCurrent();
}

// Refreshes the screen at the chosen rate with the average of the samples in that window.
function refreshDisplay() {
  if (displaySamples.length) {
    renderReading(Math.round(displaySamples.reduce((a, b) => a + b, 0) / displaySamples.length));
    displaySamples = [];
  }
  renderTrend();
  renderStats();
  drawChart();
}

function startDisplayTimer() {
  clearInterval(displayTimer);
  displaySamples = [];
  displayTimer = window.setInterval(refreshDisplay, settings.refreshSec * 1000);
}

// Energy estimate from heart rate, weight, age and sex (Keytel et al. 2005).
// Rough guide only: typically within ~15-20% for steady cardio.
function kcalPerMinute(bpm: number) {
  const { age, weightKg: w, sex } = settings;
  const kj =
    sex === "male"
      ? -55.0969 + 0.6309 * bpm + 0.1988 * w + 0.2017 * age
      : -20.4022 + 0.4472 * bpm - 0.1263 * w + 0.074 * age;
  return Math.max(0, kj / 4.184);
}

// ---------- rendering ----------

function fmtTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The live bar spans from zone 1's floor to max HR; each zone gets its own segment.
function barPct(bpm: number) {
  const ranges = zoneRanges();
  const min = ranges[0].low;
  const max = ranges[4].high;
  return Math.max(0, Math.min(100, ((bpm - min) / (max - min)) * 100));
}

function renderZones() {
  const ranges = zoneRanges();
  const t = targetRange();
  els.targetName.textContent = `Zone ${t.n}`;
  els.targetRange.textContent = `${t.low}–${t.high} bpm`;
  els.targetCadence.textContent = `Aim for ${t.cadence}`;

  els.zbar.replaceChildren(
    ...ranges.map((z) => {
      const seg = document.createElement("div");
      seg.className = `seg${z.n === settings.target ? " target" : ""}`;
      seg.style.background = `var(${z.color})`;
      seg.style.flex = String(z.high - z.low);
      seg.textContent = `Z${z.n}`;
      return seg;
    }),
    Object.assign(document.createElement("div"), { id: "marker", className: "marker", hidden: lastShown === null }),
  );
  els.zbarLegend.replaceChildren(
    ...[ranges[0].low, ...ranges.map((z) => z.high)].map((v) => {
      const s = document.createElement("span");
      s.textContent = String(v);
      s.style.left = `${barPct(v)}%`;
      return s;
    }),
  );

  const max = effectiveMaxHr();
  const maxSource =
    settings.maxMethod === "manual"
      ? "your measured max"
      : `${settings.maxMethod === "fox" ? "220 − age" : "Tanaka"} − ${BIKE_MAX_OFFSET} for cycling`;
  const method = settings.restHr ? `${maxSource}, Karvonen with resting HR ${settings.restHr}` : maxSource;
  els.profileLine.textContent = `Age ${settings.age}, ${settings.sex}, ${settings.weightKg} kg · Max HR ${max} bpm (${method})`;

  els.zonesTable.replaceChildren(
    ...ranges.map((z) => {
      const row = document.createElement("div");
      row.className = `zrow${z.n === settings.target ? " target" : ""}`;
      row.style.setProperty("--c", `var(${z.color})`);
      row.innerHTML = `
        <div class="zhead">
          <span class="zdot"></span>
          <b>Zone ${z.n}</b><span class="zname">${z.name}</span>
          <span class="zbpm">${z.low}–${z.high} <small>bpm</small></span>
        </div>
        <div class="zfeel">${z.feel} · ${z.cadence}</div>
        <div class="zwork">${z.workout}</div>`;
      row.addEventListener("click", () => {
        els.target.value = String(z.n);
        onSettingsChange();
      });
      row.title = "Set as target zone";
      return row;
    }),
  );

  const r = ranges;
  const plan = [
    ["Mon", `Zone 2 · 60 min at ${r[1].low}–${r[1].high} bpm, 85–95 rpm`],
    ["Tue", `Zone 4 intervals · 10 min warm-up, 4 × 8 min at ${r[3].low}–${r[3].high}, 4 min easy spin between`],
    ["Wed", "Zone 2 · 45–60 min"],
    ["Thu", `Zone 1 recovery spin · 30 min under ${r[0].high} bpm, or rest`],
    ["Fri", "Zone 2 · 60 min"],
    ["Sat", `Long Zone 2 · 90 min. Optional once a week: 5 × 3 min Zone 5 (${r[4].low}+ bpm)`],
    ["Sun", "Rest"],
  ];
  els.weekPlan.replaceChildren(
    ...plan.map(([d, txt]) => {
      const li = document.createElement("li");
      li.innerHTML = `<b>${d}</b><span>${txt}</span>`;
      return li;
    }),
  );
}

function renderReading(bpm: number) {
  lastShown = bpm;
  const zn = zoneNumber(bpm);
  const rel = relationToTarget(bpm);
  const t = targetRange();
  const zone = ZONES[Math.max(0, zn - 1)];

  els.bpm.textContent = String(bpm);
  els.card.className = `card live ${rel}`;
  els.card.style.setProperty("--zc", zn ? `var(${zone.color})` : "var(--muted)");
  els.zoneBadge.textContent = zn ? `Zone ${zn} · ${zone.name}` : "Below zone 1";
  const marker = document.getElementById("marker");
  if (marker) {
    marker.hidden = false;
    marker.style.left = `${barPct(bpm)}%`;
  }
  els.zoneLabel.textContent =
    rel === "in"
      ? `In your target zone ${t.n}`
      : rel === "below"
        ? `Below target, add resistance (+${t.low - bpm} bpm)`
        : `Above target, lower resistance (−${bpm - t.high} bpm)`;

  if (settings.beep && lastRelation === "in" && rel !== "in") beep(rel);
  lastRelation = rel;
}

function showNoSignal() {
  els.bpm.textContent = "--";
  els.card.className = "card live idle";
  els.card.style.removeProperty("--zc");
  els.zoneBadge.textContent = "--";
  document.getElementById("marker")?.setAttribute("hidden", "");
  els.zoneLabel.textContent = "No signal from sensor";
  lastShown = null;
  lastRelation = null;
}

function renderStats() {
  const inTarget = zoneSecs[settings.target];
  els.sessionTime.textContent = fmtTime(sessionSec);
  els.zoneTime.textContent = fmtTime(inTarget);
  els.zonePct.textContent = sessionSec ? `${Math.round((inTarget / sessionSec) * 100)}%` : "0%";
  els.avgBpm.textContent = bpmCount ? String(Math.round(bpmSum / bpmCount)) : "--";
  els.maxBpm.textContent = peakBpm ? String(peakBpm) : "--";
  els.kcal.textContent = String(Math.round(kcalTotal));
  const d = driftOf(hrHistory);
  els.drift.textContent = d === null ? "--" : fmtDrift(d);
  els.drift.className = d === null ? "" : driftClass(d);
  els.drift.parentElement!.title =
    d === null
      ? "Shows after 30 min: how much your heart rate crept up in the 2nd half vs the 1st half (after a 10 min warm-up). Under 5% means a solid aerobic base."
      : "Heart rate in the 2nd half vs the 1st half, after a 10 min warm-up. Under 5% good, 5–8% okay, over 8% ease off or fuel/hydrate.";
  els.fTime.textContent = els.sessionTime.textContent;
  els.fPct.textContent = els.zonePct.textContent;
  els.fAvg.textContent = els.avgBpm.textContent;

  els.zoneTimes.replaceChildren(
    ...ZONES.map((z) => {
      const sec = zoneSecs[z.n];
      const pct = sessionSec ? (sec / sessionSec) * 100 : 0;
      const row = document.createElement("div");
      row.className = "ztime";
      row.innerHTML = `<span>Z${z.n}</span><div class="track"><div style="width:${pct}%;background:var(${z.color})"></div></div><span class="num">${fmtTime(sec)}</span>`;
      return row;
    }),
  );
}

// Picks a "nice" tick spacing (in seconds) for the time axis.
function timeStep(totalSec: number) {
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((st) => totalSec / st <= 6) ?? 7200;
}

function drawChart() {
  const canvas = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const padL = 34;
  const padB = 20;
  const pw = w - padL - 4;
  const ph = h - padB - 4;

  const ranges = zoneRanges();
  const yMin = Math.min(ranges[0].low, ...hrHistory) - 5;
  const yMax = Math.max(ranges[4].high, ...hrHistory) + 5;
  const y = (v: number) => 4 + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // Show at least 10 minutes so the line doesn't start stretched across the whole width.
  const stepSec = SAMPLE_SEC;
  const totalSec = Math.max(600, (hrHistory.length - 1) * stepSec);
  const x = (i: number) => padL + ((i * stepSec) / totalSec) * pw;

  // zone bands with bpm boundaries
  ctx.font = "11px system-ui";
  for (const z of ranges) {
    ctx.fillStyle = cssVar(z.color);
    ctx.globalAlpha = z.n === settings.target ? 0.22 : 0.08;
    ctx.fillRect(padL, y(z.high), pw, y(z.low) - y(z.high));
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar("--muted");
    ctx.textAlign = "right";
    ctx.fillText(String(z.low), padL - 6, y(z.low) + 4);
  }
  ctx.fillText(String(ranges[4].high), padL - 6, y(ranges[4].high) + 4);

  // time axis
  ctx.textAlign = "center";
  const tStep = timeStep(totalSec);
  ctx.strokeStyle = cssVar("--border");
  ctx.lineWidth = 1;
  for (let t = 0; t <= totalSec; t += tStep) {
    const tx = padL + (t / totalSec) * pw;
    ctx.beginPath();
    ctx.moveTo(tx, 4);
    ctx.lineTo(tx, 4 + ph);
    ctx.stroke();
    ctx.fillText(fmtTime(t), Math.min(tx, w - 18), h - 5);
  }

  els.chartInfo.textContent = hrHistory.length
    ? `${fmtTime(sessionSec)} · avg ${Math.round(bpmSum / bpmCount)} · peak ${peakBpm} bpm`
    : "";

  if (hrHistory.length < 2) {
    ctx.fillStyle = cssVar("--muted");
    ctx.fillText("Your heart rate for the whole session appears here", padL + pw / 2, 4 + ph / 2);
    ctx.textAlign = "start";
    return;
  }
  ctx.textAlign = "start";

  // average line
  const avg = bpmSum / bpmCount;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = cssVar("--text");
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(padL, y(avg));
  ctx.lineTo(padL + pw, y(avg));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // heart rate line, colored by zone
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Long rides have more points than pixels; skip points so we draw about 2 per pixel.
  const stride = Math.max(1, Math.ceil(hrHistory.length / (pw * 2)));
  for (let i = stride; i < hrHistory.length; i += stride) {
    const zn = zoneNumber(hrHistory[i]);
    ctx.strokeStyle = zn ? cssVar(ZONES[zn - 1].color) : cssVar("--muted");
    ctx.beginPath();
    ctx.moveTo(x(i - stride), y(hrHistory[i - stride]));
    ctx.lineTo(x(i), y(hrHistory[i]));
    ctx.stroke();
  }

  // current point
  const last = hrHistory.length - 1;
  ctx.fillStyle = cssVar("--text");
  ctx.beginPath();
  ctx.arc(x(last), y(hrHistory[last]), 4, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- audio cue ----------

let audio: AudioContext | null = null;

function beep(zone: ZoneState) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = zone === "above" ? 880 : 440;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {
    /* audio not available */
  }
}

// ---------- screen wake lock ----------

let wakeLock: WakeLockSentinel | null = null;

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {
    /* not critical */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (device?.gatt?.connected || demoTimer)) keepScreenOn();
});

// ---------- Bluetooth ----------

const CONNECT_LABEL = "Search devices";
let device: BluetoothDevice | null = null;
let userDisconnected = false;

function setConn(state: "on" | "off" | "wait", text: string) {
  els.conn.className = `conn ${state}`;
  els.conn.textContent = text;
}

function parseHeartRate(value: DataView) {
  const flags = value.getUint8(0);
  return flags & 0x01 ? value.getUint16(1, true) : value.getUint8(1);
}

async function connectGatt(dev: BluetoothDevice) {
  setConn("wait", "Connecting…");
  const server = await dev.gatt!.connect();
  const service = await server.getPrimaryService(HR_SERVICE);
  const ch = await service.getCharacteristic(HR_MEASUREMENT);
  ch.addEventListener("characteristicvaluechanged", (e) => {
    const target = e.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) onReading(parseHeartRate(target.value));
  });
  await ch.startNotifications();
  setConn("on", dev.name ? `Connected: ${dev.name}` : "Connected");
  els.connectBtn.textContent = "Disconnect";
  keepScreenOn();
}

async function reconnect(dev: BluetoothDevice) {
  for (let attempt = 1; attempt <= 5 && !userDisconnected; attempt++) {
    setConn("wait", `Reconnecting (${attempt}/5)…`);
    try {
      await connectGatt(dev);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  if (!userDisconnected) {
    setConn("off", "Disconnected");
    els.connectBtn.textContent = CONNECT_LABEL;
  }
}

const watched = new WeakSet<BluetoothDevice>();

function onDisconnected() {
  if (userDisconnected) {
    setConn("off", "Disconnected");
    els.connectBtn.textContent = CONNECT_LABEL;
    showNoSignal();
  } else if (device) {
    reconnect(device);
  }
  renderKnownDevices();
}

async function useDevice(dev: BluetoothDevice) {
  stopDemo();
  if (device && device !== dev && device.gatt?.connected) {
    userDisconnected = true;
    device.gatt.disconnect();
  }
  device = dev;
  userDisconnected = false;
  if (!watched.has(dev)) {
    dev.addEventListener("gattserverdisconnected", onDisconnected);
    watched.add(dev);
  }
  try {
    await connectGatt(dev);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setConn("off", `Couldn't connect: ${msg}. Is the strap on and nearby?`);
    els.connectBtn.textContent = CONNECT_LABEL;
  }
  renderKnownDevices();
}

// Opens the browser's Bluetooth chooser, which scans and lists nearby devices.
async function searchDevices() {
  if (device?.gatt?.connected) {
    userDisconnected = true;
    device.gatt.disconnect();
    return;
  }
  let dev: BluetoothDevice;
  try {
    dev = els.showAll.checked
      ? await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [HR_SERVICE] })
      : await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // User closing the chooser is not an error worth shouting about.
    setConn("off", /cancel/i.test(msg) ? "Disconnected" : `Error: ${msg}`);
    return;
  }
  await useDevice(dev);
}

// Devices this site was allowed to use before, so they can be reconnected without searching.
async function renderKnownDevices() {
  if (!navigator.bluetooth?.getDevices) return;
  let devices: BluetoothDevice[] = [];
  try {
    devices = await navigator.bluetooth.getDevices();
  } catch {
    return;
  }
  els.knownWrap.hidden = devices.length === 0;
  els.knownList.replaceChildren(
    ...devices.map((dev) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const connected = dev === device && !!dev.gatt?.connected;
      name.textContent = (dev.name || "Unnamed device") + (connected ? " (connected)" : "");
      const btn = document.createElement("button");
      btn.textContent = connected ? "Disconnect" : "Connect";
      btn.addEventListener("click", () => {
        if (connected) {
          userDisconnected = true;
          dev.gatt?.disconnect();
        } else {
          useDevice(dev);
        }
      });
      li.append(name, btn);
      return li;
    }),
  );
}

// ---------- demo mode (for trying the UI without a sensor) ----------

let demoTimer: number | null = null;

function startDemo() {
  const mid = (n: number) => {
    const z = zoneRanges()[n - 1];
    return (z.low + z.high) / 2;
  };
  let bpm = zoneRanges()[0].low - 10;
  let t = 0;
  demoTimer = window.setInterval(() => {
    t += 1;
    // warm-up, steady zone 2, one hard surge, back to zone 2
    const target = t < 30 ? mid(1) : t < 150 ? mid(2) : t < 200 ? mid(4) : t < 230 ? mid(5) : mid(2);
    bpm += (target - bpm) * 0.06 + (Math.random() - 0.5) * 3;
    onReading(Math.round(bpm));
  }, 1000);
  setConn("on", "Demo mode");
  els.demoBtn.textContent = "Stop demo";
  keepScreenOn();
}

function stopDemo() {
  if (demoTimer === null) return;
  clearInterval(demoTimer);
  demoTimer = null;
  setConn("off", "Disconnected");
  els.demoBtn.textContent = "Demo mode";
  showNoSignal();
}

// ---------- wire up ----------

if (!("bluetooth" in navigator)) {
  els.unsupported.hidden = false;
  els.connectBtn.disabled = true;
}

els.connectBtn.addEventListener("click", searchDevices);
els.demoBtn.addEventListener("click", () => (demoTimer ? stopDemo() : startDemo()));
els.finishBtn.addEventListener("click", finishRide);
els.refreshSel.replaceChildren(
  ...REFRESH_OPTIONS.map((sec) => Object.assign(document.createElement("option"), { value: String(sec), textContent: `${sec} s` })),
);
if (!REFRESH_OPTIONS.includes(settings.refreshSec)) settings.refreshSec = 5;
els.refreshSel.value = String(settings.refreshSec);
els.refreshSel.addEventListener("change", () => {
  settings.refreshSec = parseInt(els.refreshSel.value, 10) || 5;
  saveSettings();
  startDisplayTimer();
});
els.discardBtn.addEventListener("click", discardRide);

// Focus mode: just the live card, big, for reading from the bike.
function setFocus(on: boolean) {
  document.body.classList.toggle("focus", on);
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    keepScreenOn();
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}
els.focusBtn.addEventListener("click", () => setFocus(true));
els.exitFocusBtn.addEventListener("click", () => setFocus(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setFocus(false);
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setFocus(false);
});
for (const input of [els.age, els.sex, els.weight, els.restHr, els.maxMethod, els.maxHr, els.target, els.beep]) {
  input.addEventListener("change", onSettingsChange);
}
window.addEventListener("resize", drawChart);

syncSettingsForm();
restoreCurrent();
renderHistory();
renderKnownDevices();
renderZones();
renderStats();
drawChart();
setInterval(sample, SAMPLE_SEC * 1000);
startDisplayTimer();
