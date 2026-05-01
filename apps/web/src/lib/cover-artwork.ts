// Lock-screen / CarPlay artwork generator.
//
// PDFs we ingest don't carry cover images, so we synthesize a
// typographic placeholder client-side: deterministic-from-title
// background color + wrapped title + author. Rendered to a 512×512 PNG
// data URL once per (title, author) and cached in-memory; the data
// URL is what `MediaSession.metadata.artwork` consumes.
//
// 512×512 is the largest size iOS lock-screen and CarPlay actually
// display; we let the OS downscale to 192/96 rather than emit three
// images. Saves the canvas work and keeps the returned MediaImage[]
// short.

const SIZE = 512;

type CoverArgs = {
  title: string;
  author: string | null;
};

const cache = new Map<string, string>();

/** Stable hash → hue. djb2-ish, sufficient for "different titles get
 *  different colors" without needing a real hash. */
function hashHue(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Force into 0..359 with a bias toward warm/legible hues. Cool blues
  // (200..240) under bright white text on the lock screen are hardest
  // to read in sunlight; nudge into the warm half.
  return Math.abs(h) % 360;
}

/** Wrap `text` into lines that fit `maxWidth` at the given font on
 *  `ctx`. Greedy word-wrap; doesn't try to balance lines. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    const last = truncated[truncated.length - 1];
    truncated[truncated.length - 1] = `${last.replace(/[.,;:!?]+$/, "")}…`;
    return truncated;
  }
  return lines;
}

/** Generate a typographic cover. Returns a data URL ("data:image/png;...")
 *  or null when called in an environment without a canvas (SSR). */
export function generateCoverArtwork({ title, author }: CoverArgs): string | null {
  if (typeof document === "undefined") return null;
  const cacheKey = `${title}\x00${author ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Background: muted gradient from a hash-derived hue. Two stops keep
  // the lock-screen look slightly textured rather than flat. Use HSL
  // for predictable saturation/lightness across hues.
  const hue = hashHue(title);
  const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  grad.addColorStop(0, `hsl(${hue}, 38%, 22%)`);
  grad.addColorStop(1, `hsl(${(hue + 24) % 360}, 32%, 14%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Subtle center vignette so the title pops.
  const vignette = ctx.createRadialGradient(
    SIZE / 2,
    SIZE / 2,
    SIZE * 0.1,
    SIZE / 2,
    SIZE / 2,
    SIZE * 0.7,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Title — wrapped to up to 5 lines, font size scaled to fit. Try
  // 64px first; step down if the title is too long to fit four lines.
  const fontStack =
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const horizontalPad = 56;
  const maxTextWidth = SIZE - horizontalPad * 2;

  let titleSize = 64;
  let titleLines: string[] = [];
  for (const candidateSize of [64, 56, 48, 42, 36]) {
    ctx.font = `600 ${candidateSize}px ${fontStack}`;
    titleLines = wrapLines(ctx, title, maxTextWidth, 5);
    if (titleLines.length <= 4 || candidateSize === 36) {
      titleSize = candidateSize;
      break;
    }
  }
  ctx.font = `600 ${titleSize}px ${fontStack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f4f1ec";

  const lineHeight = Math.round(titleSize * 1.18);
  const titleBlockHeight = lineHeight * titleLines.length;
  const titleStartY = SIZE / 2 - titleBlockHeight / 2 + lineHeight / 2;
  for (let i = 0; i < titleLines.length; i++) {
    ctx.fillText(titleLines[i], SIZE / 2, titleStartY + i * lineHeight);
  }

  // Author — small, bottom-aligned, in a muted tone.
  if (author) {
    ctx.font = `400 24px ${fontStack}`;
    ctx.fillStyle = "rgba(244, 241, 236, 0.62)";
    const authorLines = wrapLines(ctx, author, maxTextWidth, 1);
    ctx.fillText(authorLines[0], SIZE / 2, SIZE - 56);
  }

  // Top-left brand mark — a small typeset glyph identifies this as a
  // tts.raizhost.com cover even when the lock screen crops the bottom
  // (e.g. CarPlay's narrow display strip).
  ctx.font = `500 18px ${fontStack}`;
  ctx.fillStyle = "rgba(244, 241, 236, 0.45)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("tts", 40, 40);

  const dataUrl = canvas.toDataURL("image/png");
  cache.set(cacheKey, dataUrl);
  return dataUrl;
}
