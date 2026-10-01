// Heart rate zone monitor for indoor/stationary bike training, using the standard Bluetooth Heart Rate service.
const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;
const TICK_MS = 5000;
const HISTORY_POINTS = 360; // 30 minutes at 5s per point
const SETTINGS_KEY = "hrZonesSettings.v2";
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
  resetBtn: $<HTMLButtonElement>("resetBtn"),
  sessionTime: $("sessionTime"),
  zoneTime: $("zoneTime"),
  zonePct: $("zonePct"),
  avgBpm: $("avgBpm"),
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
let kcalTotal = 0;
let lastReadingAt = 0;

function resetSession() {
  windowReadings = [];
  hrHistory = [];
  sessionSec = 0;
  zoneSecs = [0, 0, 0, 0, 0, 0];
  bpmSum = 0;
  bpmCount = 0;
  kcalTotal = 0;
  renderStats();
  drawChart();
}

function onReading(bpm: number) {
  if (bpm <= 0) return; // sensor reports 0 when it has no skin contact
  windowReadings.push(bpm);
  lastReadingAt = Date.now();
  // Show the first value immediately instead of waiting for the first tick.
  if (lastShown === null) renderReading(bpm);
}

function tick() {
  let value: number | null = null;
  if (windowReadings.length > 0) {
    value = Math.round(windowReadings.reduce((a, b) => a + b, 0) / windowReadings.length);
  } else if (lastShown !== null && Date.now() - lastReadingAt < 15000) {
    value = lastShown; // sensors can skip a beat of notifications; hold briefly
  }
  windowReadings = [];

  if (value === null) {
    if (lastShown !== null && !demoTimer && !device?.gatt?.connected) showNoSignal();
    return;
  }

  sessionSec += TICK_MS / 1000;
  zoneSecs[zoneNumber(value)] += TICK_MS / 1000;
  bpmSum += value;
  bpmCount += 1;
  kcalTotal += kcalPerMinute(value) * (TICK_MS / 60000);
  hrHistory.push(value);
  if (hrHistory.length > HISTORY_POINTS) hrHistory.shift();

  renderReading(value);
  renderStats();
  drawChart();
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
  els.kcal.textContent = String(Math.round(kcalTotal));

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

  const ranges = zoneRanges();
  const yMin = Math.min(ranges[0].low, ...hrHistory) - 5;
  const yMax = Math.max(ranges[4].high, ...hrHistory) + 5;
  const y = (v: number) => h - ((v - yMin) / (yMax - yMin)) * h;

  // zone bands
  for (const z of ranges) {
    ctx.fillStyle = cssVar(z.color);
    ctx.globalAlpha = z.n === settings.target ? 0.22 : 0.08;
    ctx.fillRect(0, y(z.high), w, y(z.low) - y(z.high));
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = cssVar("--muted");
  ctx.font = "11px system-ui";
  for (const z of ranges) ctx.fillText(`Z${z.n}`, 4, (y(z.low) + y(z.high)) / 2 + 4);

  if (hrHistory.length < 2) {
    ctx.textAlign = "center";
    ctx.fillText("Your heart rate line appears here", w / 2, h / 2);
    ctx.textAlign = "start";
    return;
  }

  const step = w / (HISTORY_POINTS - 1);
  const x0 = w - (hrHistory.length - 1) * step;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  for (let i = 1; i < hrHistory.length; i++) {
    const zn = zoneNumber(hrHistory[i]);
    ctx.strokeStyle = zn ? cssVar(ZONES[zn - 1].color) : cssVar("--muted");
    ctx.beginPath();
    ctx.moveTo(x0 + (i - 1) * step, y(hrHistory[i - 1]));
    ctx.lineTo(x0 + i * step, y(hrHistory[i]));
    ctx.stroke();
  }
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
els.resetBtn.addEventListener("click", resetSession);
for (const input of [els.age, els.sex, els.weight, els.restHr, els.maxMethod, els.maxHr, els.target, els.beep]) {
  input.addEventListener("change", onSettingsChange);
}
window.addEventListener("resize", drawChart);

syncSettingsForm();
renderKnownDevices();
renderZones();
renderStats();
drawChart();
setInterval(tick, TICK_MS);
