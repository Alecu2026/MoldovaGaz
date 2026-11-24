"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

/**
 * Scanner de cod QR cu camera (ca acțiunea „ScanQR” din SCADA / aplicația mobilă): camera din spate, citire continuă; folosește BarcodeDetector când există (Chrome / Android),
 * altfel jsQR. Dacă nu există cameră (sau pagina nu e pe HTTPS), apare un câmp pentru textul codului. Închiderea fără rezultat apelează `onCancel`.
 */
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

export default function QrScanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const done = useRef(false);
  const cb = useRef({ onResult, onCancel });
  useEffect(() => { cb.current = { onResult, onCancel }; }, [onResult, onCancel]);

  useEffect(() => {
    let stream: MediaStream | null = null, raf = 0, stopped = false, last = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let det: Detector | null = null;
    try { det = BD ? new BD({ formats: ["qr_code"] }) : null; } catch { det = null; }
    const finish = (text: string) => { if (done.current) return; done.current = true; cb.current.onResult(text); };
    const tick = async (t: number) => {
      if (stopped || done.current) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth && t - last > 120) {
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
      if (!navigator.mediaDevices?.getUserMedia) { setErr("Camera nu e disponibilă (e nevoie de HTTPS și permisiune)."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((x) => x.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => undefined); }
        raf = requestAnimationFrame((x) => void tick(x));
      } catch { setErr("Nu pot porni camera (permisiune refuzată sau nu există cameră)."); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((x) => x.stop()); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); cb.current.onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="tbx-back" role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="tbx-dialog" style={{ width: "min(520px, 100%)" }}>
        <div className="tbx-toolbar"><h2>Scan QR code</h2><span style={{ flex: 1 }} /><button type="button" className="tbx-iconbtn tbx-white" aria-label="Close" onClick={onCancel}><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg></button></div>
        <div className="tbx-dialog-body">
          {err ? (
            <div>
              <p style={{ margin: "0 0 12px" }}>{err}</p>
              <label className="tbx-field"><span>QR text</span>
                <input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) finish0(manual.trim()); }} placeholder=":3010.60027989.2610:" aria-label="QR text" />
              </label>
            </div>
          ) : (
            <div className="tbx-video"><video ref={video} muted playsInline aria-label="Camera" /><i /></div>
          )}
        </div>
        <div className="tbx-dialog-actions">
          {err && <button type="button" className="tbx-btn tbx-primary" disabled={!manual.trim()} onClick={() => finish0(manual.trim())}>Ok</button>}
          <button type="button" className="tbx-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
  function finish0(text: string) { if (done.current) return; done.current = true; cb.current.onResult(text); }
}
