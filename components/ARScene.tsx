"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { makeGoldenTrail } from "@/server-utils/lib/fx/goldenTrail";

// ─────────────────────────────── types ───────────────────────────────────────

type ColorKey = "gold" | "cyan" | "magenta" | "white";
type Phase    = "idle" | "drawing" | "processing";

interface FrozenCamera {
  cam:        THREE.Camera;
  pos:        THREE.Vector3;
  forward:    THREE.Vector3;
  planePoint: THREE.Vector3;
  containerW: number;
  containerH: number;
}

interface AnchoredObject {
  anchor: XRAnchor;
  obj:    THREE.Object3D;
}

// ─────────────────────────── constants ───────────────────────────────────────

const COLORS: Record<ColorKey, number> = {
  gold:    0xffd700,
  cyan:    0x00e5ff,
  magenta: 0xff4fd8,
  white:   0xffffff,
};

const MIN_BOX_SIDE_M     = 0.04;
const STROKE_MIN_DELTA   = 2;
const STROKE_THROTTLE_MS = 30;
const PROCESSING_DELAY   = 200;
const MAX_DPR            = 2;
const INIT_THICKNESS     = 0.06;   // initial slider values as plain constants
const INIT_DISTANCE      = 1.6;    // so we never read .current during render
const UI_SELECTOR        = "button,select,input,textarea,label,a,[role='button']";

// ─────────────────────────── pure helpers ────────────────────────────────────

function hasMaterialColor(
    m: unknown,
): m is THREE.Material & { color: THREE.Color; needsUpdate: boolean } {
  return (
      m !== null &&
      typeof m === "object" &&
      "color" in (m as Record<string, unknown>) &&
      (m as { color?: unknown }).color instanceof THREE.Color
  );
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const o = obj as unknown as {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  });
}

function getXRCamera(renderer: THREE.WebGLRenderer, fallback: THREE.Camera): THREE.Camera {
  const xrCam = (renderer.xr as unknown as {
    getCamera: () => THREE.Camera & { cameras?: THREE.Camera[] };
  }).getCamera();
  return (xrCam?.cameras?.length ? xrCam.cameras[0] : xrCam) ?? fallback;
}

function rayPlaneIntersect(
    origin: THREE.Vector3, direction: THREE.Vector3,
    planePoint: THREE.Vector3, planeNormal: THREE.Vector3,
): THREE.Vector3 | null {
  const denom = planeNormal.dot(direction);
  if (Math.abs(denom) < 1e-6) return null;
  const t = planePoint.clone().sub(origin).dot(planeNormal) / denom;
  if (t < 0) return null;
  return origin.clone().addScaledVector(direction, t);
}

function unprojectOntoPlane(
    sx: number, sy: number, W: number, H: number,
    cam: THREE.Camera, planePoint: THREE.Vector3, planeNormal: THREE.Vector3,
): THREE.Vector3 | null {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -((sy / H) * 2 - 1)), cam);
  return rayPlaneIntersect(rc.ray.origin, rc.ray.direction, planePoint, planeNormal);
}

function tintObject(root: THREE.Object3D, color: number): void {
  root.traverse((obj) => {
    const o = obj as unknown as { material?: unknown };
    const apply = (m: unknown) => {
      if (hasMaterialColor(m)) { m.color.setHex(color); m.needsUpdate = true; }
    };
    if (Array.isArray(o.material)) o.material.forEach(apply);
    else apply(o.material);
  });
}

// ─────────────────────────── 3-D builder ─────────────────────────────────────

function makeWindowBox(opts: {
  center: THREE.Vector3; width: number; height: number;
  thickness: number; forward: THREE.Vector3; color: number;
}): THREE.Mesh {
  const { center, width, height, thickness, forward, color } = opts;
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right   = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
  const upOrt   = new THREE.Vector3().crossVectors(forward, right).normalize();
  const q       = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, upOrt, forward),
  );
  const geom = new THREE.BoxGeometry(width, height, thickness);
  const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 0.22,
        metalness: 0.1, roughness: 0.4, side: THREE.DoubleSide,
      }),
  );
  mesh.position.copy(center);
  mesh.quaternion.copy(q);
  mesh.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  ));
  return mesh;
}

// ─────────────────────────── component ───────────────────────────────────────

export default function ARScene() {

  const containerRef = useRef<HTMLDivElement>(null);
  const hudRef       = useRef<HTMLDivElement>(null);   // for beforexrselect listener
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const threeRef     = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera;
    root: THREE.Group; trail: ReturnType<typeof makeGoldenTrail>;
  } | null>(null);

  const sessionRef  = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  const anchorsSupportedRef = useRef(false);
  const anchoredRef         = useRef<AnchoredObject[]>([]);
  const placedRef           = useRef<THREE.Object3D[]>([]);

  const activePointerIdRef = useRef<number | null>(null);
  const frozenCamRef       = useRef<FrozenCamera | null>(null);

  // Mutable slider values — never read during render, so no ESLint violation.
  const thicknessRef    = useRef(INIT_THICKNESS);
  const drawDistanceRef = useRef(INIT_DISTANCE);

  const stroke2DRef       = useRef<{ x: number; y: number }[]>([]);
  const strokeThrottleRef = useRef(0);

  const [status,    setStatus]    = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);
  const [phase,     setPhase]     = useState<Phase>("idle");
  const [colorKey,  setColorKey]  = useState<ColorKey>("magenta");
  const [stroke2D,  setStroke2D]  = useState<{ x: number; y: number }[]>([]);

  // ── Three.js bootstrap ────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current!;
    const renderer  = new THREE.WebGLRenderer({
      antialias: true, alpha: true, powerPreference: "high-performance",
    });
    renderer.xr.enabled = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    Object.assign(renderer.domElement.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "0",
    });
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene  = new THREE.Scene();
    scene.background = null;
    const camera = new THREE.PerspectiveCamera();
    const root   = new THREE.Group();
    scene.add(root);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    const trail = makeGoldenTrail({ color: COLORS.magenta });
    root.add(trail.object);
    threeRef.current = { scene, camera, root, trail };

    const ro = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      renderer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)), false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      try { sessionRef.current?.end(); } catch { /* ignore */ }
      renderer.setAnimationLoop(null);
      renderer.dispose();
      try { container.removeChild(renderer.domElement); } catch { /* ignore */ }
    };
  }, []);

  // ── beforexrselect — prevents XR selectstart when tapping HUD buttons ────
  // Cannot be set as a JSX prop (not in React's HTMLDivElement type), so we
  // attach it imperatively. This stops the XR runtime from treating a button
  // tap as a drawing input.
  useEffect(() => {
    const hud = hudRef.current;
    if (!hud) return;
    const handler = (e: Event) => e.preventDefault();
    hud.addEventListener("beforexrselect", handler);
    return () => hud.removeEventListener("beforexrselect", handler);
  }, []);

  useEffect(() => { threeRef.current?.trail.setColor(COLORS[colorKey]); }, [colorKey]);

  // ── AR session ────────────────────────────────────────────────────────────

  async function startAR() {
    if (isRunning) return;
    const xr = (navigator as unknown as { xr?: XRSystem }).xr;
    if (!xr) { setStatus("WebXR non disponibile."); return; }

    setStatus("Avvio sessione AR…");
    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay", "local-floor"],
      domOverlay: { root: document.body },
    } as XRSessionInit);

    sessionRef.current = session;
    anchorsSupportedRef.current =
        typeof (session as unknown as { requestAnchor?: unknown }).requestAnchor === "function";

    const renderer = rendererRef.current!;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    await renderer.xr.setSession(session);
    refSpaceRef.current = await session.requestReferenceSpace("local");
    session.addEventListener("end", handleSessionEnd);

    setIsRunning(true);
    setPhase("idle");
    setStatus("AR attiva — disegna un'area col dito.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      if (frame && refSpaceRef.current) {
        for (const { anchor, obj } of anchoredRef.current) {
          const pose = frame.getPose(anchor.anchorSpace, refSpaceRef.current);
          if (!pose) continue;
          const { position: p, orientation: o } = pose.transform;
          obj.position.set(p.x, p.y, p.z);
          obj.quaternion.set(o.x, o.y, o.z, o.w);
        }
      }
      renderer.render(three.scene, three.camera);
    });
  }

  function stopAR() { sessionRef.current?.end(); }

  function handleSessionEnd() {
    refSpaceRef.current = null; sessionRef.current = null;
    anchoredRef.current = []; placedRef.current = [];
    frozenCamRef.current = null; activePointerIdRef.current = null;
    stroke2DRef.current = []; setStroke2D([]);
    threeRef.current?.trail.reset();
    setIsRunning(false); setPhase("idle"); setStatus("Sessione AR terminata.");
  }

  // ── Pointer events ────────────────────────────────────────────────────────
  //
  // CRITICAL: .closest() guard runs BEFORE e.preventDefault().
  // If the touch target is a UI element we return without calling
  // preventDefault() — the browser can then still fire the click the button needs.

  function onPointerDown(e: React.PointerEvent) {
    if (!isRunning || phase === "processing") return;
    if ((e.target as HTMLElement).closest(UI_SELECTOR)) return; // ← before preventDefault
    e.preventDefault();

    activePointerIdRef.current = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ok */ }

    const renderer  = rendererRef.current!;
    const three     = threeRef.current!;
    const container = containerRef.current!;

    const cam = getXRCamera(renderer, three.camera);
    const pos = new THREE.Vector3();
    const q   = new THREE.Quaternion();
    cam.getWorldPosition(pos);
    cam.getWorldQuaternion(q);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const { width, height } = container.getBoundingClientRect();
    const distance = threeRef.current ? drawDistanceRef.current : INIT_DISTANCE;
    frozenCamRef.current = {
      cam, pos, forward,
      planePoint: pos.clone().addScaledVector(forward, distance),
      containerW: width, containerH: height,
    };

    const rect = container.getBoundingClientRect();
    stroke2DRef.current = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
    setStroke2D([...stroke2DRef.current]);
    three.trail.reset();
    setPhase("drawing");
    setStatus("Disegno…");
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isRunning || activePointerIdRef.current !== e.pointerId || phase !== "drawing") return;
    e.preventDefault();

    const rect = containerRef.current!.getBoundingClientRect();
    const p    = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const arr  = stroke2DRef.current;
    const last = arr[arr.length - 1];
    if (last && Math.abs(last.x - p.x) + Math.abs(last.y - p.y) <= STROKE_MIN_DELTA) return;
    arr.push(p);

    const now = performance.now();
    if (now - strokeThrottleRef.current > STROKE_THROTTLE_MS) {
      strokeThrottleRef.current = now;
      setStroke2D([...arr]);
    }
  }

  async function onPointerUp(e: React.PointerEvent) {
    if (!isRunning || activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ok */ }
    activePointerIdRef.current = null;

    const pts = [...stroke2DRef.current];
    const resetDraw = () => {
      stroke2DRef.current = []; frozenCamRef.current = null;
      setStroke2D([]); threeRef.current?.trail.reset(); setPhase("idle");
    };

    if (pts.length < 5) { setStatus("Tratto troppo corto — riprova."); resetDraw(); return; }

    setPhase("processing");
    setStatus("Creo il box…");
    await new Promise<void>((r) => setTimeout(r, PROCESSING_DELAY));

    const frozen = frozenCamRef.current;
    const three  = threeRef.current!;
    if (!frozen) { setStatus("Errore interno — riprova."); resetDraw(); return; }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { x, y } of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    const { cam, pos: camPos, forward, planePoint, containerW, containerH } = frozen;
    const unp = (sx: number, sy: number) =>
        unprojectOntoPlane(sx, sy, containerW, containerH, cam, planePoint, forward);

    const TL = unp(minX, minY), TR = unp(maxX, minY);
    const BL = unp(minX, maxY), BR = unp(maxX, maxY);
    if (!TL || !TR || !BL || !BR) { setStatus("Proiezione fallita — riprova."); resetDraw(); return; }

    const width  = TL.distanceTo(TR);
    const height = TL.distanceTo(BL);
    if (width < MIN_BOX_SIDE_M || height < MIN_BOX_SIDE_M) {
      setStatus(`Troppo piccolo (${(width*100).toFixed(0)}×${(height*100).toFixed(0)} cm).`);
      resetDraw(); return;
    }

    const center = new THREE.Vector3().add(TL).add(TR).add(BL).add(BR).multiplyScalar(0.25);
    const facingForward = forward.clone();
    if (facingForward.dot(camPos.clone().sub(center)) < 0) facingForward.negate();

    const thickness = thicknessRef.current;
    const mesh = makeWindowBox({ center, width, height, thickness, forward: facingForward, color: COLORS[colorKey] });
    three.root.add(mesh);
    placedRef.current.push(mesh);

    const session = sessionRef.current, refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(
            new XRRigidTransform(
                { x: center.x, y: center.y, z: center.z, w: 1 },
                { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
            ), refSpace,
        );
        anchoredRef.current.push({ anchor, obj: mesh });
      } catch { /* optional */ }
    }

    setStatus(`✅  ${(width*100).toFixed(0)} × ${(height*100).toFixed(0)} cm`);
    resetDraw();
  }

  function onPointerCancel(e: React.PointerEvent) {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    stroke2DRef.current = []; frozenCamRef.current = null;
    setStroke2D([]); threeRef.current?.trail.reset();
    setPhase("idle"); setStatus("Annullato.");
  }

  // ── Undo / Clear ───────────────────────────────────────────────────────────

  function undoLast() {
    const last = placedRef.current.pop();
    if (!last) { setStatus("Niente da annullare."); return; }
    const idx = anchoredRef.current.findIndex((a) => a.obj === last);
    if (idx >= 0) {
      try { (anchoredRef.current[idx].anchor as unknown as { delete?: () => void }).delete?.(); } catch { /* ok */ }
      anchoredRef.current.splice(idx, 1);
    }
    threeRef.current!.root.remove(last);
    disposeObject(last);
    setStatus("Ultimo box rimosso.");
  }

  function clearAll() {
    const three = threeRef.current!;
    for (const { anchor, obj } of anchoredRef.current) {
      try { (anchor as unknown as { delete?: () => void }).delete?.(); } catch { /* ok */ }
      three.root.remove(obj); disposeObject(obj);
    }
    anchoredRef.current = [];
    for (const obj of placedRef.current) { three.root.remove(obj); disposeObject(obj); }
    placedRef.current = [];
    three.trail.reset();
    stroke2DRef.current = []; setStroke2D([]);
    setPhase("idle"); setStatus("Scena svuotata.");
  }

  // ── SVG overlay ────────────────────────────────────────────────────────────

  const strokePath = useMemo(() => {
    if (stroke2D.length < 2) return "";
    return "M " + stroke2D.map(({ x, y }) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
  }, [stroke2D]);

  const bboxRect = useMemo(() => {
    if (phase !== "drawing" || stroke2D.length < 2) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { x, y } of stroke2D) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, [stroke2D, phase]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
      <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
      >
        {/* SVG overlay — pointer-events: none, purely visual */}
        <svg
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 10 }}
            width="100%" height="100%"
        >
          <path
              d={strokePath}
              fill="none"
              stroke="rgba(255,235,59,0.50)"
              strokeWidth={22}
              strokeLinecap="round"
              strokeLinejoin="round"
          />
          {bboxRect && (
              <rect
                  x={bboxRect.x} y={bboxRect.y}
                  width={bboxRect.w} height={bboxRect.h}
                  fill="rgba(255,235,59,0.06)"
                  stroke="rgba(255,235,59,0.85)"
                  strokeWidth={2} strokeDasharray="7 4"
              />
          )}
        </svg>

        {/* HUD — beforexrselect attached via useEffect above */}
        <div
            ref={hudRef}
            className="absolute left-3 top-3 max-w-[580px]"
            style={{ zIndex: 20 }}
        >
          <p className="mb-2 text-sm text-white drop-shadow-md">
            {status}
            {phase === "processing" && (
                <span className="ml-2 animate-pulse text-yellow-200">• elaborazione…</span>
            )}
          </p>

          <div className="flex flex-wrap gap-2">
            {(
                [
                  { label: "Start AR", action: startAR,  disabled: isRunning  },
                  { label: "Stop",     action: stopAR,   disabled: !isRunning },
                  { label: "Undo",     action: undoLast, disabled: !isRunning },
                  { label: "Clear",    action: clearAll, disabled: !isRunning },
                ] as const
            ).map(({ label, action, disabled }) => (
                <button
                    key={label}
                    onClick={action}
                    disabled={disabled}
                    className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm text-white backdrop-blur transition-opacity disabled:opacity-35"
                >
                  {label}
                </button>
            ))}

            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Colore</span>
              <select
                  className="bg-transparent text-sm text-white outline-none"
                  value={colorKey}
                  onChange={(e) => {
                    const key = e.target.value as ColorKey;
                    setColorKey(key);
                    placedRef.current.forEach((obj) => tintObject(obj, COLORS[key]));
                  }}
              >
                <option value="gold">Oro</option>
                <option value="cyan">Ciano</option>
                <option value="magenta">Magenta</option>
                <option value="white">Bianco</option>
              </select>
            </label>

            {/* Use INIT_* as defaultValue — never reads .current in render */}
            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Spessore</span>
              <input
                  type="range" min={0.01} max={0.18} step={0.01}
                  defaultValue={INIT_THICKNESS}
                  onChange={(e) => { thicknessRef.current = Number(e.target.value); }}
              />
            </label>

            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Distanza</span>
              <input
                  type="range" min={0.5} max={4.0} step={0.1}
                  defaultValue={INIT_DISTANCE}
                  onChange={(e) => { drawDistanceRef.current = Number(e.target.value); }}
              />
            </label>
          </div>

          <p className="mt-2 text-xs text-white/55">
            Disegna col dito → il box AR appare esattamente dove hai evidenziato.
          </p>
        </div>
      </div>
  );
}