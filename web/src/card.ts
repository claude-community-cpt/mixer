// The keepsake card: a picture a guest can save or share to say they were
// there. It is drawn in the browser, so nothing about it is sent anywhere.

const STICKERS = import.meta.glob<string>("./assets/stickers/*.png", { eager: true, query: "?url", import: "default" });

// A line to go with each Clawd sticker.
const LINES: Record<string, string> = {
  clawd: "Showed up, pulled up a chair, joined in.",
  coffee: "Came for the coffee, stayed for the chat.",
  dizzy: "Three tables, three topics, one happy head-spin.",
  happy: "Left with new faces and new ideas.",
  headphones: "Did some talking and a lot of listening.",
  heart: "Found good company at every table.",
  lightbulb: "Had at least one light bulb moment.",
  magnifier: "Asked the good questions.",
  shiny: "Shared something shiny and new.",
  skateboard: "Rolled from table to table.",
  vibing: "Good coffee, good questions, good vibes.",
  wand: "Swapped a few tricks of the trade.",
};

const names = Object.keys(STICKERS)
  .map((path) => path.split("/").pop()!.replace(".png", ""))
  .filter((n) => LINES[n])
  .sort();

/** The same sticker every time for the same guest, but a different one for each. */
export function stickerFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  return names[h % names.length];
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Shrinks the text until it fits the width, then draws it centred. */
function fitText(ctx: CanvasRenderingContext2D, text: string, y: number, font: (px: number) => string, px: number, maxWidth: number) {
  let size = px;
  ctx.font = font(size);
  while (ctx.measureText(text).width > maxWidth && size > 24) {
    size -= 4;
    ctx.font = font(size);
  }
  ctx.fillText(text, W / 2, y);
}

const W = 1080;
const H = 1350;

export async function drawCard(o: { name: string; eventName: string; line: string; sticker: string }): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const serif = (px: number) => `500 ${px}px Lora, Georgia, serif`;
  const sans = (px: number, weight = 500) => `${weight} ${px}px Poppins, system-ui, sans-serif`;
  // The page fonts may not have been used yet at these weights.
  await Promise.all([serif(100), sans(40), sans(40, 600)].map((f) => document.fonts?.load(f).catch(() => null)));
  const img = await load(STICKERS[`./assets/stickers/${o.sticker}.png`]);

  const coral = "#d97757";
  const ink = "#141413";
  ctx.fillStyle = "#faf9f5";
  ctx.fillRect(0, 0, W, H);
  // A coral frame with rounded inner corners.
  ctx.fillStyle = coral;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#faf9f5";
  ctx.beginPath();
  ctx.roundRect(36, 36, W - 72, H - 72, 44);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#c5633f";
  ctx.font = sans(30, 600);
  ctx.letterSpacing = "4px";
  ctx.fillText("CLAUDE COMMUNITY", W / 2, 150);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = ink;
  ctx.font = serif(48);
  ctx.fillText("Cape Town", W / 2, 210);

  // The sticker, as large as fits its box.
  const box = { x: 190, y: 270, w: 700, h: 440 };
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);

  ctx.fillStyle = "rgba(20, 20, 19, .6)";
  ctx.font = sans(36);
  ctx.fillText("I was at", W / 2, 800);
  ctx.fillStyle = ink;
  fitText(ctx, o.eventName, 900, serif, 104, W - 200);
  ctx.fillStyle = "#c5633f";
  fitText(ctx, o.name, 1010, (px) => sans(px, 600), 76, W - 220);
  ctx.fillStyle = "rgba(20, 20, 19, .7)";
  fitText(ctx, LINES[o.sticker], 1090, sans, 34, W - 200);

  ctx.fillStyle = "rgba(20, 20, 19, .12)";
  ctx.fillRect(W / 2 - 60, 1140, 120, 3);
  ctx.fillStyle = "rgba(20, 20, 19, .6)";
  fitText(ctx, o.line, 1200, sans, 30, W - 200);
  ctx.font = sans(26);
  ctx.fillText("claudecapetown.com", W / 2, 1250);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"));
}
