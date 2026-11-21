/**
 * Stills and clips of the model view's field: one frame as PNG, or one full
 * phase cycle as a video that loops cleanly. Each frame is the 3D canvas on
 * the view's own backdrop with the field's caption burned in, so a clip
 * still says what it shows once it leaves the app.
 *
 * The clip steps the phase itself (frame k of N shows phase 2 pi k / N) and
 * encodes each frame with its own timestamp through WebCodecs, so it holds
 * every phase once and plays at the same speed on a fast or slow machine.
 */
import { PHASE_CYCLE_S } from './model_view';
import { muxWebm, type EncodedFrame } from './webm';

/** What a capture needs from the model view. */
export interface PhaseSource {
  readonly canvas: HTMLCanvasElement;
  readonly fieldPhase: number;
  readonly isPlaying: boolean;
  setPhase(phase: number): void;
  setPlaying(on: boolean): void;
  renderNow(): void;
  fieldHasPhase(): boolean;
  readonly viewVersion: number;
  setOrbitEnabled(on: boolean): void;
}

const FRAMES_PER_SECOND = 30;
const VIDEO_BITS_PER_SECOND = 12e6;
/** First the browser can encode wins: WebCodecs codec string and its WebM codec id. */
const CODECS = [
  // VP9 profile 0, level 5.1 (up to 4K), 8 bit.
  { codec: 'vp09.00.51.08', webm: 'V_VP9' },
  { codec: 'vp8', webm: 'V_VP8' },
];

export const phaseDegrees = (phase: number) => Math.round((phase * 180) / Math.PI) % 360;

/** Whether this browser can encode video (WebCodecs). */
export const canRecordVideo = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

/** The current frame as PNG, captioned with its phase when the field has one. */
export function fieldFramePng(source: PhaseSource, caption: string): Promise<Blob> {
  const frame = frameCanvas(source.canvas, false);
  source.renderNow();
  paintFrame(frame, source.canvas, source.fieldHasPhase() ? [caption, phaseCaption(source.fieldPhase)] : [caption]);
  return new Promise((resolve, reject) => frame.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the image'))), 'image/png'));
}

/**
 * Encodes one phase cycle as WebM (PHASE_CYCLE_S seconds at FRAMES_PER_SECOND)
 * and puts the view back at the phase and play state it had. Each frame is
 * stamped with its own time, so a slow machine takes longer to export but the
 * clip still plays at the right speed.
 */
export async function recordPhaseCycle(source: PhaseSource, caption: string): Promise<Blob> {
  if (!canRecordVideo()) throw new Error('this browser cannot encode video');
  const frame = frameCanvas(source.canvas, true);
  const config = await supportedConfig(frame.width, frame.height);
  const encoded: EncodedFrame[] = [];
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      encoded.push({ timeMs: chunk.timestamp / 1000, key: chunk.type === 'key', data });
    },
    error: (e) => (failure = new Error(`encoding failed: ${e.message}`)),
  });
  encoder.configure(config.encoder);

  const [phaseBefore, playingBefore] = [source.fieldPhase, source.isPlaying];
  source.setPlaying(false);
  source.setOrbitEnabled(false);
  const version = source.viewVersion;
  const frames = Math.round(PHASE_CYCLE_S * FRAMES_PER_SECOND);
  const frameUs = 1e6 / FRAMES_PER_SECOND;
  try {
    // Phase 2 pi itself is not drawn, so the clip loops without a repeated frame.
    for (let k = 0; k < frames && !failure; k++) {
      // An edit, a new solve, another field or a resized window mid-clip would splice two views together.
      if (source.viewVersion !== version) throw new Error('the view changed while the video was being made; try again and leave it still until it finishes');
      source.setPhase((2 * Math.PI * k) / frames);
      source.renderNow();
      paintFrame(frame, source.canvas, [caption, phaseCaption(source.fieldPhase)]);
      const videoFrame = new VideoFrame(frame, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs), alpha: 'discard' });
      encoder.encode(videoFrame, { keyFrame: k === 0 });
      videoFrame.close();
      // Let the encoder and the page breathe, so the queue stays short and the UI keeps painting.
      while (encoder.encodeQueueSize > 2) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // After an encoder error, flush rejects with a generic message; report the error itself.
    await encoder.flush().catch((e: Error) => Promise.reject(failure ?? e));
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    source.setOrbitEnabled(true);
    source.setPhase(phaseBefore);
    source.setPlaying(playingBefore);
  }
  if (failure) throw failure;
  encoded.sort((a, b) => a.timeMs - b.timeMs);
  const webm = muxWebm({ codecId: config.webm, width: frame.width, height: frame.height }, encoded, PHASE_CYCLE_S * 1000);
  return new Blob([webm as BlobPart], { type: 'video/webm' });
}

async function supportedConfig(width: number, height: number): Promise<{ encoder: VideoEncoderConfig; webm: string }> {
  for (const { codec, webm } of CODECS) {
    const encoder: VideoEncoderConfig = { codec, width, height, bitrate: VIDEO_BITS_PER_SECOND, framerate: FRAMES_PER_SECOND };
    if ((await VideoEncoder.isConfigSupported(encoder)).supported) return { encoder, webm };
  }
  throw new Error('this browser cannot encode VP9 or VP8 video');
}

const phaseCaption = (phase: number) => `Phase ${phaseDegrees(phase)}°`;

/** A 2D canvas the size of the 3D one; for video, rounded down to even sides for the encoders. */
function frameCanvas(source: HTMLCanvasElement, evenSides: boolean): HTMLCanvasElement {
  const frame = document.createElement('canvas');
  const side = (n: number) => (evenSides ? Math.max(2, n & ~1) : Math.max(1, n));
  frame.width = side(source.width);
  frame.height = side(source.height);
  return frame;
}

/** The view's backdrop, the 3D frame, and the caption lines bottom left. */
function paintFrame(frame: HTMLCanvasElement, source: HTMLCanvasElement, lines: string[]): void {
  const ctx = frame.getContext('2d')!;
  const { width: w, height: h } = frame;
  paintBackdrop(ctx, w, h);
  ctx.drawImage(source, 0, 0, w, h, 0, 0, w, h);
  // Size text against the CSS width so it reads the same as the app's 13 px captions at any pixel ratio.
  const scale = source.width / Math.max(1, source.clientWidth || source.width);
  const size = 13 * scale;
  const pad = 16 * scale;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  ctx.font = `${size}px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgb(230 232 236 / 0.92)';
  lines.forEach((line, n) => ctx.fillText(line, pad, h - pad - (lines.length - 1 - n) * size * 1.5));
}

/**
 * The model view's CSS backdrop, radial-gradient(ellipse at 50% 40%, #1d2026 0%,
 * #121418 55%, #0b0c0e 100%), redrawn on canvas. A CSS farthest-corner ellipse
 * has the closest-side aspect (w/2 : 0.4 h) scaled to pass through the far
 * corner, which here is sqrt(1 + 1.5^2) times the closest-side radii.
 */
function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const k = Math.sqrt(1 + 1.5 ** 2);
  const [rx, ry] = [0.5 * w * k, 0.4 * h * k];
  ctx.save();
  ctx.translate(0.5 * w, 0.4 * h);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, '#1d2026');
  gradient.addColorStop(0.55, '#121418');
  gradient.addColorStop(1, '#0b0c0e');
  ctx.fillStyle = gradient;
  ctx.fillRect(-0.5 * w / rx, -0.4 * h / ry, w / rx, h / ry);
  ctx.restore();
}
