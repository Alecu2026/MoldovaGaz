"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { MSG } from "@/lib/installer";
import { ICON, type IconName } from "./tbicons";

/**
 * Dialogul „QR-Scan(Web)” din SCADA: cameră pe tot ecranul (din spate), cadru cu colțuri, textul „Îndreaptă camera spre QR / Наведите камеру на QR”, zoom și lanternă când
 * telefonul le are. Citește cu BarcodeDetector când există (Chrome / Android), altfel cu jsQR. Închiderea fără rezultat apelează `onCancel`.
 * Fără cameră (sau fără HTTPS) apare un câmp pentru textul codului.
 */
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type Caps = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step?: number } };
const I = ({ n, s = 24 }: { n: IconName; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" aria-hidden="true"><path d={ICON[n]} /></svg>;

export default function QrScanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [torch, setTorch] = useState<{ has: boolean; on: boolean }>({ has: false, on: false });
  const [zoom, setZoom] = useState<{ min: number; max: number; step: number; value: number } | null>(null);
  const done = useRef(false);
  const cb = useRef({ onResult, onCancel });
  useEffect(() => { cb.current = { onResult, onCancel }; }, [onResult, onCancel]);
  const finish = (text: string) => { if (done.current) return; done.current = true; cb.current.onResult(text); };

  useEffect(() => {
    let stream: MediaStream | null = null, raf = 0, stopped = false, last = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let det: Detector | null = null;
    try { det = BD ? new BD({ formats: ["qr_code"] }) : null; } catch { det = null; }
    const tick = async (t: number) => {
      if (stopped || done.current) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth && t - last > 70) {
        last = t;
        try {
          if (det) { const r = await det.detect(v); if (r[0]?.rawValue) return finish(r[0].rawValue); }
          else if (ctx) {
            const w = Math.min(960, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth);
            canvas.width = w; canvas.height = h; ctx.drawImage(v, 0, 0, w, h);
            const q = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
            if (q?.data) return finish(q.data);
          }
        } catch { /* cadru ratat: încercăm din nou */ }
      }
      raf = requestAnimationFrame((x) => void tick(x));
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setErr(MSG.camUnsupported); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((x) => x.stop()); return; }
        const tr = stream.getVideoTracks()[0]; track.current = tr ?? null;
        try {
          const caps = (tr?.getCapabilities?.() ?? {}) as Caps;
          if (caps.torch) setTorch({ has: true, on: false });
          if (caps.zoom && caps.zoom.max > caps.zoom.min) { const v0 = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 1.5)); setZoom({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: v0 }); void tr.applyConstraints({ advanced: [{ zoom: v0 } as MediaTrackConstraintSet] }).catch(() => undefined); }
          void tr.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
        } catch { /* fără zoom / lanternă */ }
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => undefined); }
        raf = requestAnimationFrame((x) => void tick(x));
      } catch { setErr(MSG.camUnavailable); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((x) => x.stop()); track.current = null; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); cb.current.onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const toggleTorch = () => { const on = !torch.on; setTorch({ has: true, on }); void track.current?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => setTorch({ has: true, on: !on })); };
  const setZ = (v: number) => { setZoom((z) => (z ? { ...z, value: v } : z)); void track.current?.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] }).catch(() => undefined); };

  return (
    <div className="tbx-qr" role="dialog" aria-modal="true" aria-label="Scan QR">
      <div className="tbx-qr-top"><span>Scan QR / Сканировать QR</span><button type="button" className="tbx-iconbtn tbx-white" onClick={onCancel} aria-label="Close"><I n="close" /></button></div>
      {err ? (
        <div className="tbx-qr-manual">
          <p>{err}</p>
          <label className="tbx-ff"><input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) finish(manual.trim()); }} placeholder=" " aria-label="QR text" /><span>QR text</span><i /></label>
          <div style={{ textAlign: "right", marginTop: 12 }}><button type="button" className="tbx-btn tbx-raised tbx-primary" disabled={!manual.trim()} onClick={() => finish(manual.trim())}>Ok</button></div>
        </div>
      ) : (
        <div className="tbx-qr-cam">
          <video ref={video} muted playsInline aria-label="Camera" />
          <div className="tbx-qr-frame"><b className="tl" /><b className="tr" /><b className="bl" /><b className="br" /></div>
        </div>
      )}
      <div className="tbx-qr-bottom">
        <div className="tbx-qr-status">{MSG.qrAim}</div>
        {zoom && <div className="tbx-qr-zoom"><I n="zoom_in" /><input type="range" min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value} onChange={(e) => setZ(Number(e.target.value))} aria-label="Zoom" /></div>}
        {torch.has && <button type="button" className="tbx-iconbtn tbx-white tbx-qr-torch" onClick={toggleTorch} aria-label="Lanternă"><I n={torch.on ? "flash_off" : "flash_on"} /></button>}
      </div>
    </div>
  );
}
