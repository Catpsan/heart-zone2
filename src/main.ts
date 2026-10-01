// Zone 2 heart rate monitor using the standard Bluetooth Heart Rate service.
const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;
const TICK_MS = 5000;
const HISTORY_POINTS = 360; // 30 minutes at 5s per point
const SETTINGS_KEY = "hrZone2Settings";

type ZoneState = "below" | "in" | "above";

interface Settings {
  age: number;
  sex: "male" | "female";
  weightKg: number;
  maxHr: number | null; // null = derive from age
  lowPct: number;
  highPct: number;
  beep: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  conn: $("conn"),
  unsupported: $("unsupported"),
  card: $("card"),
  bpm: $("bpm"),
  zoneLabel: $("zoneLabel"),
  band: $("band"),
  marker: $("marker"),
  lowLabel: $("lowLabel"),
  highLabel: $("highLabel"),
  connectBtn: $<HTMLButtonElement>("connectBtn"),
  demoBtn: $<HTMLButtonElement>("demoBtn"),
  resetBtn: $<HTMLButtonElement>("resetBtn"),
  sessionTime: $("sessionTime"),
  zoneTime: $("zoneTime"),
  zonePct: $("zonePct"),
  avgBpm: $("avgBpm"),
  kcal: $("kcal"),
  sex: $<HTMLSelectElement>("sex"),
  weight: $<HTMLInputElement>("weight"),
  chart: $<HTMLCanvasElement>("chart"),
  age: $<HTMLInputElement>("age"),
  maxHr: $<HTMLInputElement>("maxHr"),
  lowPct: $<HTMLInputElement>("lowPct"),
  highPct: $<HTMLInputElement>("highPct"),
  beep: $<HTMLInputElement>("beep"),
  showAll: $<HTMLInputElement>("showAll"),
  knownWrap: $("knownWrap"),
  knownList: $("knownList"),
};

// ---------- settings ----------

function loadSettings(): Settings {
  const defaults: Settings = { age: 29, sex: "male", weightKg: 79, maxHr: null, lowPct: 60, highPct: 70, beep: false };
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

function effectiveMaxHr() {
  return settings.maxHr ?? 220 - settings.age;
}

function zoneBounds() {
  const max = effectiveMaxHr();
  return {
    low: Math.round((max * settings.lowPct) / 100),
    high: Math.round((max * settings.highPct) / 100),
  };
}

function zoneOf(bpm: number): ZoneState {
  const { low, high } = zoneBounds();
  if (bpm < low) return "below";
  if (bpm > high) return "above";
  return "in";
}

function syncSettingsForm() {
  els.age.value = String(settings.age);
  els.sex.value = settings.sex;
  els.weight.value = String(settings.weightKg);
  els.maxHr.value = settings.maxHr ? String(settings.maxHr) : "";
  els.maxHr.placeholder = String(220 - settings.age);
  els.lowPct.value = String(settings.lowPct);
  els.highPct.value = String(settings.highPct);
  els.beep.checked = settings.beep;
}

function onSettingsChange() {
  const age = parseInt(els.age.value, 10);
  const maxHr = parseInt(els.maxHr.value, 10);
  const lowPct = parseInt(els.lowPct.value, 10);
  const highPct = parseInt(els.highPct.value, 10);
  if (age >= 10 && age <= 100) settings.age = age;
  const weight = parseFloat(els.weight.value);
  if (weight >= 30 && weight <= 250) settings.weightKg = weight;
  settings.sex = els.sex.value === "female" ? "female" : "male";
  settings.maxHr = maxHr >= 100 && maxHr <= 230 ? maxHr : null;
  if (lowPct > 0 && highPct > lowPct) {
    settings.lowPct = lowPct;
    settings.highPct = highPct;
  }
  settings.beep = els.beep.checked;
  els.maxHr.placeholder = String(220 - settings.age);
  saveSettings();
  renderZoneBar();
  if (lastShown !== null) renderReading(lastShown);
  drawChart();
}

// ---------- session state ----------

let windowReadings: number[] = []; // raw readings since the last 5s tick
let lastShown: number | null = null;
let lastZone: ZoneState | null = null;
let hrHistory: number[] = [];
let sessionSec = 0;
let zoneSec = 0;
let bpmSum = 0;
let bpmCount = 0;
let kcalTotal = 0;
let lastReadingAt = 0;

function resetSession() {
  windowReadings = [];
  hrHistory = [];
  sessionSec = 0;
  zoneSec = 0;
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
  if (zoneOf(value) === "in") zoneSec += TICK_MS / 1000;
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

// The bar spans 40%..100% of max HR.
function barPct(bpm: number) {
  const max = effectiveMaxHr();
  const min = max * 0.4;
  return Math.max(0, Math.min(100, ((bpm - min) / (max - min)) * 100));
}

function renderZoneBar() {
  const { low, high } = zoneBounds();
  els.band.style.left = `${barPct(low)}%`;
  els.band.style.width = `${barPct(high) - barPct(low)}%`;
  els.lowLabel.textContent = `${low}`;
  els.highLabel.textContent = `${high}`;
}

function renderReading(bpm: number) {
  lastShown = bpm;
  const zone = zoneOf(bpm);
  const { low, high } = zoneBounds();
  els.bpm.textContent = String(bpm);
  els.card.className = `card ${zone}`;
  els.marker.hidden = false;
  els.marker.style.left = `${barPct(bpm)}%`;
  els.zoneLabel.textContent =
    zone === "in"
      ? "In zone 2"
      : zone === "below"
        ? `Below zone 2, speed up (+${low - bpm})`
        : `Above zone 2, ease off (-${bpm - high})`;

  if (settings.beep && lastZone === "in" && zone !== "in") beep(zone);
  lastZone = zone;
}

function showNoSignal() {
  els.bpm.textContent = "--";
  els.card.className = "card idle";
  els.marker.hidden = true;
  els.zoneLabel.textContent = "No signal from sensor";
  lastShown = null;
  lastZone = null;
}

function renderStats() {
  els.sessionTime.textContent = fmtTime(sessionSec);
  els.zoneTime.textContent = fmtTime(zoneSec);
  els.zonePct.textContent = sessionSec ? `${Math.round((zoneSec / sessionSec) * 100)}%` : "0%";
  els.avgBpm.textContent = bpmCount ? String(Math.round(bpmSum / bpmCount)) : "--";
  els.kcal.textContent = String(Math.round(kcalTotal));
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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

  const { low, high } = zoneBounds();
  const values = hrHistory.length ? hrHistory : [low, high];
  const yMin = Math.min(...values, low) - 10;
  const yMax = Math.max(...values, high) + 10;
  const y = (v: number) => h - ((v - yMin) / (yMax - yMin)) * h;

  // zone 2 band
  ctx.fillStyle = cssVar("--in");
  ctx.globalAlpha = 0.15;
  ctx.fillRect(0, y(high), w, y(low) - y(high));
  ctx.globalAlpha = 1;

  ctx.fillStyle = cssVar("--muted");
  ctx.font = "11px system-ui";
  ctx.fillText(String(high), 4, y(high) - 3);
  ctx.fillText(String(low), 4, y(low) + 12);

  if (hrHistory.length < 2) {
    ctx.fillText("Heart rate history (last 30 min) appears here", w / 2 - 130, h / 2);
    return;
  }

  const step = w / (HISTORY_POINTS - 1);
  const x0 = w - (hrHistory.length - 1) * step;
  ctx.lineWidth = 2;
  for (let i = 1; i < hrHistory.length; i++) {
    const zone = zoneOf(hrHistory[i]);
    ctx.strokeStyle = cssVar(zone === "in" ? "--in" : zone === "below" ? "--below" : "--above");
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
  let bpm = zoneBounds().low - 15;
  let t = 0;
  demoTimer = window.setInterval(() => {
    t += 1;
    const { low, high } = zoneBounds();
    const target = t < 40 ? low - 10 : t < 200 ? (low + high) / 2 : t < 260 ? high + 8 : (low + high) / 2;
    bpm += (target - bpm) * 0.05 + (Math.random() - 0.5) * 3;
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
for (const input of [els.age, els.sex, els.weight, els.maxHr, els.lowPct, els.highPct, els.beep]) {
  input.addEventListener("change", onSettingsChange);
}
window.addEventListener("resize", drawChart);

syncSettingsForm();
renderKnownDevices();
renderZoneBar();
renderStats();
drawChart();
setInterval(tick, TICK_MS);
