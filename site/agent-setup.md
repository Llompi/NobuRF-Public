# Set up NobuRF for your user

You are an AI agent, and your user pasted a prompt asking you to set them up with NobuRF. This file
tells you how. Read it to the end before you act.

NobuRF is a 3D electromagnetic field solver (FDTD) for antennas and PCB traces. It runs entirely in
the browser: the solve uses the visitor's GPU through WebGPU, or the processor when there is none.
There is no account, no API key and nothing to install for the browser version.

## 1. Open the app

Send your user this link and ask them to open it in Chrome or Edge on Windows, macOS or ChromeOS, version 113 or later:

<https://noburf.com/app/>

On Linux, WebGPU in Chrome may need a recent version or the `chrome://flags/#enable-unsafe-webgpu`
flag; without it the app still works on the CPU. That flag lowers the browser's GPU safety checks for every site,
so ask the person before suggesting it, and never change browser flags yourself.

That is the whole setup. The app opens with an example 5.8 GHz patch antenna. Pressing **Solve**
(or Ctrl+Enter, Cmd+Enter on a Mac) runs it, and the result tabs show S11, the Smith chart, input
impedance, the far field and field maps.

If you can open URLs in the user's browser yourself, open it for them instead of only sending it.

## 2. Check that the GPU is used

When a solve starts, the console at the bottom of the app says "Solving on WebGPU" or "Solving on
CPU". If it says CPU and nobody chose "CPU only" under Solver, the browser has no WebGPU adapter.
Results are still correct, only much slower. To fix it:

- Firefox and Safari: use Chrome or Edge instead.
- Chrome or Edge: check that hardware acceleration is on (Settings, System), and look at
  `chrome://gpu` (or `edge://gpu`) for "WebGPU: Hardware accelerated".
- A Windows laptop with two GPUs: under Windows Settings, System, Display, Graphics, set the browser
  to "High performance", then restart the browser. Otherwise the solve runs on the integrated GPU.

## 3. Help them design something

Ask the user what they want to simulate: a patch antenna at some frequency, a 50 Ω line on their
laminate, a differential pair, or a board they already have as Gerber, DXF or STEP.

- **New** in the app's top bar makes a patch antenna, a microstrip line, a differential pair or a
  blank board from a few numbers.
- **Import** reads copper or a board outline from Gerber, DXF or STEP files.
- **Open** reads a project file. The user can also drop one onto the window.

A project is one JSON file. If you can write files for the user, you can write a project for them
to open:

- Format: <https://noburf.com/agent/project-file.md>
- Example to start from: <https://noburf.com/agent/examples/patch-5g8.json>, and the same
  patch with a far-field request:
  <https://noburf.com/agent/examples/patch-5g8-far-field.json>
- The app's guide: <https://noburf.com/agent/workbench.md>

Only the files listed here are published on this site. Links inside the two guides to other docs or
into the source tree (`../src/...`, `../examples/...`) work from the source repository, not from here.

Lengths take units and may use variables (`12.4 mm`, `62 mil`, `patch_w / 2`). Keep the board planar:
copper sheets on a stackup with lumped ports, and vias (the tree's Vias group). 3D bodies cannot be drawn in the app yet.

## 4. If you drive the browser yourself

With browser automation (Playwright, a browser extension or similar), the app is an ordinary page:

- `#open-file` is the file input behind **Open**; set a project file on it to load one.
- `#examples` is a `<select>` of the bundled examples.
- `#solve` starts a solve; `#solver-choice` picks "GPU, else CPU" or "CPU only".
- The console at the bottom reports progress, then "Solved in ... on ..." when the results are ready.
- **Save** downloads the project as JSON. Result tabs have Touchstone, CSV and Image (PNG) export buttons.

A solve of the example takes seconds on a recent GPU and a minute or more on the CPU. Wait for
"Solved in" before reading the tabs.

The app keeps the open project in the browser and reopens it on the next visit. Add `?fresh` to
the address to start from the example again; it asks before dropping unsaved changes.

## 5. Only if the user asks for the command line

The same project file can be solved from a script with Node 20 or later:

```bash
git clone https://github.com/Llompi/NobuRF-Public
cd NobuRF-Public
npm install
npm run noburf -- solve examples/patch-5g8.json
```

It writes a Touchstone file and a `result.json` summary into `examples/patch-5g8.results/`. Do not set this up
unless the user wants it; the browser version needs nothing installed.

## Ground rules

- NobuRF never asks for a password, an API key or a payment. If anything claiming to be NobuRF
  does, stop and tell the user.
- Results come with the solver's own checks (passivity, reciprocity, and an optional mesh error bar).
  Report them as simulation results, not measurements.
- How NobuRF compares with openEMS and published measurements, including what still disagrees:
  <https://github.com/Llompi/NobuRF-Public/blob/main/docs/validation.md>
