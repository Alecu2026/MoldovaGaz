"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MSG } from "@/lib/installer";
import { ICON, type IconName } from "./tbicons";

/**
 * Dialogul „Photo” din SCADA (acțiunile Photo / PhotoBrowser): cameră pe tot ecranul (din spate, 4:3, cât mai mare), buton rotund pentru poză, apoi „Refă” / „Confirmă”;
 * butoane sus: schimbă camera și închide. Poza se micșorează la cel mult 2048 px (JPEG 0,9) înainte să plece. La eroare mesajul apare în dialog, cu „Reîncercați.”.
 * Fără cameră (sau fără HTTPS) apare „Cameră indisponibilă” și o alegere de fișier, ca să se poată încărca totuși o poză.
 */
const MAX_SIZE = 2048, JPEG_QUALITY = 0.9;
const I = ({ n, s = 24 }: { n: IconName; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" aria-hidden="true"><path d={ICON[n]} /></svg>;

export default function CameraDialog({ onSave, onClose }: { onSave: (photo: Blob) => Promise<void>; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [err, setErr] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const stop = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; }, []);
  const attach = useCallback(() => { const v = video.current; if (v && stream.current) { v.srcObject = stream.current; void v.play().catch(() => undefined); } }, []);

  useEffect(() => {
    let dead = false;
    const take = async (mode: "environment" | "user") => {
      if (!navigator.mediaDevices?.getUserMedia) { setErr(MSG.camUnsupported); return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
        if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s; setErr(null); attach();
      } catch {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode } });
          if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
          stream.current = s; setErr(null); attach();
        } catch { if (!dead) setErr(MSG.camUnavailable); }
      }
    };
    stop();
    const t = setTimeout(() => void take(facing), 0);
    return () => { dead = true; clearTimeout(t); stop(); };
  }, [facing, stop, attach]);

  useEffect(() => { if (!shot) attach(); }, [shot, attach]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); stop(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, stop]);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const toBlob = (src: CanvasImageSource, w: number, h: number) => new Promise<Blob | null>((res) => {
    const k = MAX_SIZE ? Math.min(1, MAX_SIZE / Math.max(w, h)) : 1;
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const x = c.getContext("2d", { alpha: false });
    if (!x) { res(null); return; }
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height);
    c.toBlob(res, "image/jpeg", JPEG_QUALITY);
  });
  const capture = async () => {
    const v = video.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const b = await toBlob(v, v.videoWidth, v.videoHeight);
    if (b) setShot({ blob: b, url: URL.createObjectURL(b) });
  };
  const confirm = async () => {
    if (!shot || saving) return;
    setSaving(true); setErr(null);
    try { await onSave(shot.blob); stop(); onClose(); } catch (e) { setSaving(false); setErr(`${(e as Error).message || "Eroare la salvarea atributului."} Reîncercați.`); }
  };
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    try { const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); const b = await toBlob(bmp, bmp.width, bmp.height); bmp.close(); if (b) setShot({ blob: b, url: URL.createObjectURL(b) }); else setShot({ blob: f, url: URL.createObjectURL(f) }); }
    catch { setShot({ blob: f, url: URL.createObjectURL(f) }); }
  };

  return (
    <div className="tbx-cam" role="dialog" aria-modal="true" aria-label="Photo">
      {saving && <div className="tbx-progress" role="progressbar" aria-label={MSG.saving}><i /></div>}
      <div className="tbx-cam-top">
        <button type="button" className="tbx-iconbtn tbx-white" onClick={() => { if (!saving) { setShot(null); setFacing((f) => (f === "user" ? "environment" : "user")); } }} disabled={saving} aria-label="Schimbă camera"><I n="flip_camera_android" /></button>
        <button type="button" className="tbx-iconbtn tbx-white" onClick={() => { stop(); onClose(); }} aria-label="Close"><I n="close" /></button>
      </div>
      {err && <div className="tbx-cam-err" role="alert">{err}{err === MSG.camUnavailable || err === MSG.camUnsupported ? <div><button type="button" className="tbx-btn tbx-white-btn" onClick={() => file.current?.click()}>Alege un fișier / Выбрать файл</button></div> : null}</div>}
      <div className="tbx-cam-body">
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot.url} alt="Poza făcută" className="tbx-cam-img" />
        ) : <video ref={video} autoPlay muted playsInline className="tbx-cam-video" aria-label="Camera" />}
      </div>
      <div className="tbx-cam-bottom">
        {!shot ? (
          <button type="button" className="tbx-fab" onClick={() => void capture()} aria-label="Fă poza" disabled={!!err}><I n="camera" s={28} /></button>
        ) : (
          <div className="tbx-cam-confirm">
            <button type="button" className="tbx-btn tbx-white-btn" onClick={() => { if (!saving) { setShot(null); setErr(null); } }} disabled={saving}><I n="refresh" s={20} /> {MSG.retake}</button>
            <button type="button" className="tbx-btn tbx-raised tbx-accent" onClick={() => void confirm()} disabled={saving}><I n="check" s={20} /> {saving ? MSG.saving : MSG.confirm}</button>
          </div>
        )}
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void fromFile(f); }} aria-label="Fișier" />
    </div>
  );
}
