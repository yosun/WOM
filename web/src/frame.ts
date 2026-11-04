// How a memory (a photo, or a slide's image) sits on screen. The viewer and the slide space share these, so
// a slide that flies up to face the camera lands exactly where the viewer will show its image.

export interface PhotoRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the image fills the stage and overflows it on one side; false when it is shown whole with bars. */
  cover: boolean;
}

/**
 * Where an image of `aspect` (width / height) sits on a `w` × `h` stage: full-bleed when that crops little of
 * it, else whole, centred. The viewer's camera sees exactly this rectangle.
 */
export function photoFrame(w: number, h: number, aspect: number): PhotoRect {
  const viewAspect = w / h;
  const cover = Math.min(viewAspect, aspect) / Math.max(viewAspect, aspect) >= 0.84;
  let pw: number, ph: number;
  if (cover === viewAspect >= aspect) {
    pw = w;
    ph = w / aspect;
  } else {
    ph = h;
    pw = h * aspect;
  }
  return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph, cover };
}

/**
 * A tiny, darkened copy of the image, which looks blurred once stretched: it fills the bars around an image
 * shown whole. Returns the canvas it painted.
 */
export function paintBackdrop(canvas: HTMLCanvasElement, img: CanvasImageSource, aspect: number): HTMLCanvasElement {
  canvas.width = 40;
  canvas.height = Math.max(1, Math.round(40 / aspect));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(5, 4, 4, 0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
