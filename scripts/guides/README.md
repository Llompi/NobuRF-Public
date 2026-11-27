# Guide screenshots

Tools for the step screenshots on the site's guide pages (`site/*/index.html`, images in `site/assets/guides/`).

- `guide_capture.mjs <out dir> [app url] [patch,line,emissions,pair,farfield]` drives the workbench in Edge (or Chromium with `CHANNEL=chromium`) at 1440x1000, DPR 2, dark scheme. It saves one PNG per step, plus a JSON file holding the boxes of the controls the guide points at.
- `annotate.py spec.json outdir` crops each shot (crop box in CSS px), draws the numbered callouts and arrows, and writes WebP. In the page, set the `<img>` width and height to half the file's pixel size.

Capture on a machine with a real GPU. In a GPU-less cloud container, WebGPU falls back to SwiftShader, and a 0.5 M-cell solve takes 12 to 45 minutes.

`specs/` holds the crop and callout specs for the current images. Their `src` paths point to `shots/`, so capture into a folder of that name, or edit the paths.
