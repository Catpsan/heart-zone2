# Zone 2 Heart Rate

![Screenshot](docs/screenshot-demo.png)

A small web app that connects to a Bluetooth heart rate sensor (chest strap, armband, or a watch
broadcasting HR) and tells you, every 5 seconds, whether you are below, in, or above zone 2.

- Uses the standard Bluetooth Heart Rate service, so any sensor that pairs with Zwift, Strava, etc. works.
- **Search devices** opens Chrome's Bluetooth scanner listing nearby heart rate sensors (tick "Show all Bluetooth devices" to list everything). Devices you picked before appear under "Your devices" for one-click reconnect.
- Display refreshes every 5 s with the average of the readings in that window.
- Zone 2 = 60–70% of max HR by default. Profile defaults: age 29, male, 79 kg (editable). Max HR = 220 − age unless you type your real one. Settings are saved in the browser.
- Tracks session time, time in zone 2, % in zone, average HR, estimated calories (Keytel formula), and a 30-minute chart.
- Keeps the screen awake, auto-reconnects if the sensor drops, optional beep when you leave zone 2.
- "Demo mode" simulates a sensor so you can try it on a PC without Bluetooth.

## Requirements

Web Bluetooth only works in **Chrome or Edge** (desktop or Android), over **HTTPS** or `localhost`.
It does not work in Firefox or Safari/iOS. Bluetooth must be on in the laptop.
Many sensors only allow one connection at a time, so close other apps using the strap.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

Option A, via GitHub: push this folder to a repo, then on vercel.com choose
**Add New → Project**, import the repo, keep the detected Vite settings, and deploy.

Option B, from the command line:

```bash
npm i -g vercel
vercel          # first time: log in and accept the defaults
vercel --prod
```

Open the `https://….vercel.app` URL in Chrome on the laptop with Bluetooth, press
**Search devices**, pick your device, and train.
