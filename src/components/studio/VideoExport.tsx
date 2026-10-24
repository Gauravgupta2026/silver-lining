"use client";

import { useEffect, useRef, useState } from "react";
import { Choice, GHOST } from "./controls";

/** Length of every recording. Frames in the file = fps × this. */
export const RECORD_SECONDS = 5;
export const FPS_OPTIONS = [30, 60] as const;
type Fps = (typeof FPS_OPTIONS)[number];

/** Safari and Chrome 126+ record H.264 in MP4. Firefox has no MP4 recorder, so none of these match there. */
const MP4_TYPES = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"];
/** Bits per pixel per frame. Sets quality; the clamps keep tiny and huge canvases sane. */
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE = 2_000_000;
const MAX_BITRATE = 40_000_000;
const TICK_MS = 250;
const MS_PER_SECOND = 1000;

/**
 * Record a live canvas to a Blob.
 * captureStream(fps) caps the rate: a 120 Hz screen still gives `fps` frames per second.
 * A frame is only taken when the canvas redraws, so a paused animation yields fewer frames.
 */
function recordCanvas(canvas: HTMLCanvasElement, mimeType: string, fps: Fps, seconds: number, signal: AbortSignal): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(fps);
    const bitrate = Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, canvas.width * canvas.height * fps * BITS_PER_PIXEL));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error("The recorder stopped with an error."));
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      resolve(signal.aborted ? null : new Blob(chunks, { type: mimeType }));
    };
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    signal.addEventListener("abort", stop);
    recorder.start();
    setTimeout(stop, seconds * MS_PER_SECOND);
  });
}

/**
 * MP4 export for any studio. The studio only has to give a way to reach its live canvas.
 * Choose 30 or 60 fps, then record RECORD_SECONDS of the preview.
 */
export function VideoExport({ getCanvas, fileName, onError }: { getCanvas: () => HTMLCanvasElement | null; fileName: string; onError: (message: string | null) => void }) {
  const [fps, setFps] = useState<Fps>(30);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Leaving the page mid-recording stops the recorder and drops the file.
  useEffect(() => () => abort.current?.abort(), []);

  const save = async () => {
    const canvas = getCanvas();
    if (!canvas) {
      onError("The live preview is not ready. Reload the page before saving an MP4.");
      return;
    }
    const mimeType = typeof MediaRecorder === "undefined" ? undefined : MP4_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      onError("This browser can't record MP4. Use Chrome or Safari.");
      return;
    }
    onError(null);
    const controller = new AbortController();
    abort.current = controller;
    const startedAt = performance.now();
    setSecondsLeft(RECORD_SECONDS);
    const tick = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil(RECORD_SECONDS - (performance.now() - startedAt) / MS_PER_SECOND)));
    }, TICK_MS);
    try {
      const blob = await recordCanvas(canvas, mimeType, fps, RECORD_SECONDS, controller.signal);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileName}-${fps}fps.mp4`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "The MP4 could not be saved.");
    } finally {
      clearInterval(tick);
      abort.current = null;
      setSecondsLeft(null);
    }
  };

  const recording = secondsLeft !== null;
  return (
    <div className="export-options">
      {FPS_OPTIONS.map((option) => (
        <Choice key={option} value={String(option)} current={String(fps)} onSelect={() => !recording && setFps(option)} title={`${option * RECORD_SECONDS} frames over ${RECORD_SECONDS} seconds`}>
          {option} fps
        </Choice>
      ))}
      <button type="button" onClick={save} disabled={recording} className={`download-maps ${GHOST}`}>
        {recording ? `Recording… ${secondsLeft} s` : `Save MP4 · ${RECORD_SECONDS} s`}
      </button>
    </div>
  );
}
