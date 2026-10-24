/** Decoded images, shared across instances and re-renders. Keyed by URL. */
const images = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string) {
  let p = images.get(src);
  if (!p) {
    const img = new Image();
    // Needed to read pixels from images on another origin (they must send CORS headers).
    if (!src.startsWith("blob:") && !src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.src = src;
    p = img.decode().then(() => img);
    p.catch(() => images.delete(src));
    images.set(src, p);
  }
  return p;
}

/** Drops a cached image, e.g. after revoking a blob URL. */
export function forgetImage(src: string) {
  images.delete(src);
}
