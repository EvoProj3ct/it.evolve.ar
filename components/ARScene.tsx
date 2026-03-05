"use client";

/**
 * ARScene — WebXR immersive-AR component.
 *
 * UX flow
 * ───────
 *  1. Tap "Start AR" to enter an immersive-AR session.
 *  2. Draw freely with your finger — a yellow translucent highlighter follows
 *     the stroke and a dashed rectangle previews the computed bounding-box.
 *  3. On pointer-up the component unprojects the 2-D bounding-box corners
 *     onto a vertical plane frozen at pointer-down, then places a 3-D box
 *     (door / window / picture-frame style) exactly in that space.
 *  4. Undo removes the last placed box; Clear removes everything.
 *
 * Design rationale
 * ────────────────
 *  • All 3-D maths runs only at pointer-up using a snapshot of the camera
 *    taken at pointer-down — the gesture is fully stable regardless of head
 *    movement during drawing.
 *  • The draw-plane is always vertical (forward.y = 0) so placed boxes never
 *    tilt with camera pitch.
 *  • XR anchors are requested when available (best-effort, non-fatal).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { makeGoldenTrail } from "@/server-utils/lib/fx/goldenTrail";

// ─────────────────────────────── types ───────────────────────────────────────

type ColorKey = "gold" | "cyan" | "magenta" | "white";
type Phase    = "idle" | "drawing" | "processing";

/** Camera state frozen at pointer-down; used for stable unprojection. */
interface FrozenCamera {
  /** Active XR eye camera (or fallback perspective camera). */
  cam:        THREE.Camera;
  /** World-space camera position at the moment of pointer-down. */
  pos:        THREE.Vector3;
  /**
   * Yaw-only (horizontal) unit forward vector derived from camera orientation.
   * Keeping Y = 0 ensures the draw-plane stays strictly vertical even when
   * the user tilts their head.
   */
  forward:    THREE.Vector3;
  /** A point on the draw-plane (camPos + forward × drawDistance). */
  planePoint: THREE.Vector3;
  /** Container pixel dimensions at pointer-down (used for NDC conversion). */
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

/** Minimum placed-box side in metres; smaller results are rejected. */
const MIN_BOX_SIDE_M     = 0.04;
/** Skip 2-D stroke points that moved fewer than this many pixels. */
const STROKE_MIN_DELTA   = 2;
/** React state for the SVG overlay is updated at most this often (ms). */
const STROKE_THROTTLE_MS = 30;
/** Brief visual pause between "drawing" and "idle" so the user sees feedback. */
const PROCESSING_DELAY   = 200;
/** Maximum devicePixelRatio forwarded to the renderer. */
const MAX_DPR            = 2;

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

/** Recursively dispose all geometries and materials of an Object3D subtree. */
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

/**
 * Returns the active XR eye camera from the renderer.
 * Falls back to the scene's perspective camera when not in XR or when
 * the XR camera array is empty.
 */
function getXRCamera(renderer: THREE.WebGLRenderer, fallback: THREE.Camera): THREE.Camera {
  const xrCam = (renderer.xr as unknown as {
    getCamera: () => THREE.Camera & { cameras?: THREE.Camera[] };
  }).getCamera();
  return (xrCam?.cameras?.length ? xrCam.cameras[0] : xrCam) ?? fallback;
}

/**
 * Ray–plane intersection.
 * Returns the world-space hit point, or null when the ray is parallel to or
 * behind the plane.
 */
function rayPlaneIntersect(
    origin:      THREE.Vector3,
    direction:   THREE.Vector3,
    planePoint:  THREE.Vector3,
    planeNormal: THREE.Vector3,
): THREE.Vector3 | null {
  const denom = planeNormal.dot(direction);
  if (Math.abs(denom) < 1e-6) return null;
  const t = planePoint.clone().sub(origin).dot(planeNormal) / denom;
  if (t < 0) return null;
  return origin.clone().addScaledVector(direction, t);
}

/**
 * Unprojects a 2-D point (container-local pixels, origin at top-left) onto a
 * 3-D plane defined by a point and its normal.
 */
function unprojectOntoPlane(
    sx: number, sy: number,
    containerW: number, containerH: number,
    cam: THREE.Camera,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3,
): THREE.Vector3 | null {
  const ndcX =  (sx / containerW) * 2 - 1;
  const ndcY = -((sy / containerH) * 2 - 1);
  const rc   = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
  return rayPlaneIntersect(rc.ray.origin, rc.ray.direction, planePoint, planeNormal);
}

// ─────────────────────────── 3-D builders ────────────────────────────────────

/**
 * Builds a translucent rectangular box mesh (window / door / frame style).
 *
 * Orientation:
 *   right   = worldUp × forward  (horizontal axis on the wall)
 *   up      = forward × right    (vertical axis, close to world-up)
 *   forward = provided forward   (face normal, pointing toward camera)
 */
function makeWindowBox(opts: {
  center:    THREE.Vector3;
  width:     number;
  height:    number;
  thickness: number;
  forward:   THREE.Vector3;
  color:     number;
}): THREE.Mesh {
  const { center, width, height, thickness, forward, color } = opts;

  const worldUp = new THREE.Vector3(0, 1, 0);
  const right   = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
  const up      = new THREE.Vector3().crossVectors(forward, right).normalize();

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, forward),
  );

  const geom = new THREE.BoxGeometry(width, height, thickness);

  const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity:     0.22,
        metalness:   0.1,
        roughness:   0.4,
        side:        THREE.DoubleSide,
      }),
  );
  mesh.position.copy(center);
  mesh.quaternion.copy(quaternion);

  mesh.add(
      new THREE.LineSegments(
          new THREE.EdgesGeometry(geom),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      ),
  );

  return mesh;
}

/** Recursively tints all colour-capable materials inside an Object3D. */
function tintObject(root: THREE.Object3D, color: number): void {
  root.traverse((obj) => {
    const o = obj as unknown as { material?: unknown };
    if (Array.isArray(o.material)) {
      o.material.forEach((m) => {
        if (hasMaterialColor(m)) { m.color.setHex(color); m.needsUpdate = true; }
      });
    } else if (hasMaterialColor(o.material)) {
      o.material.color.setHex(color);
      o.material.needsUpdate = true;
    }
  });
}

// ─────────────────────────── component ───────────────────────────────────────

export default function ARScene() {

  // ── refs ──────────────────────────────────────────────────────────────────

  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);

  const threeRef = useRef<{
    scene:  THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root:   THREE.Group;
    trail:  ReturnType<typeof makeGoldenTrail>;
  } | null>(null);

  const sessionRef  = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  const anchorsSupportedRef = useRef(false);
  const anchoredRef         = useRef<AnchoredObject[]>([]);
  const placedRef           = useRef<THREE.Object3D[]>([]);

  const activePointerIdRef = useRef<number | null>(null);
  const frozenCamRef       = useRef<FrozenCamera | null>(null);
  const thicknessRef       = useRef(0.06);
  const drawDistanceRef    = useRef(1.6);

  /** Raw 2-D stroke points in container-local pixels. */
  const stroke2DRef       = useRef<{ x: number; y: number }[]>([]);
  const strokeThrottleRef = useRef(0);

  // ── state ─────────────────────────────────────────────────────────────────

  const [status,    setStatus]    = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);
  const [phase,     setPhase]     = useState<Phase>("idle");
  const [colorKey,  setColorKey]  = useState<ColorKey>("magenta");
  const [stroke2D,  setStroke2D]  = useState<{ x: number; y: number }[]>([]);

  // ── Three.js setup ────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current!;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.xr.enabled = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "0" });
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

  // Keep trail colour in sync.
  useEffect(() => { threeRef.current?.trail.setColor(COLORS[colorKey]); }, [colorKey]);

  // ── AR session lifecycle ───────────────────────────────────────────────────

  async function startAR() {
    if (isRunning) return;
    const xr = (navigator as unknown as { xr?: XRSystem }).xr;
    if (!xr) { setStatus("WebXR non disponibile su questo dispositivo."); return; }

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
      // Update world-locked anchor poses every frame.
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
    refSpaceRef.current       = null;
    sessionRef.current        = null;
    anchoredRef.current       = [];
    placedRef.current         = [];
    frozenCamRef.current      = null;
    activePointerIdRef.current = null;
    stroke2DRef.current       = [];
    setStroke2D([]);
    threeRef.current?.trail.reset();
    setIsRunning(false);
    setPhase("idle");
    setStatus("Sessione AR terminata.");
  }

  // ── Pointer events ─────────────────────────────────────────────────────────

  function onPointerDown(e: React.PointerEvent) {
    if (!isRunning || phase === "processing") return;
    if ((e.target as HTMLElement).closest("button,select,input,textarea,label,a")) return;
    e.preventDefault();

    activePointerIdRef.current = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ok */ }

    // ── Snapshot the camera so the full gesture uses a consistent projection.
    const renderer  = rendererRef.current!;
    const three     = threeRef.current!;
    const container = containerRef.current!;

    const cam = getXRCamera(renderer, three.camera);
    const pos = new THREE.Vector3();
    const q   = new THREE.Quaternion();
    cam.getWorldPosition(pos);
    cam.getWorldQuaternion(q);

    // Yaw-only forward → vertical draw-plane regardless of camera pitch.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const { width, height } = container.getBoundingClientRect();
    frozenCamRef.current = {
      cam, pos, forward,
      planePoint: pos.clone().addScaledVector(forward, drawDistanceRef.current),
      containerW: width,
      containerH: height,
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
      stroke2DRef.current  = [];
      frozenCamRef.current = null;
      setStroke2D([]);
      threeRef.current?.trail.reset();
      setPhase("idle");
    };

    if (pts.length < 5) {
      setStatus("Tratto troppo corto — riprova.");
      resetDraw();
      return;
    }

    setPhase("processing");
    setStatus("Creo il box…");
    await new Promise<void>((r) => setTimeout(r, PROCESSING_DELAY));

    const frozen = frozenCamRef.current;
    const three  = threeRef.current!;
    if (!frozen) { setStatus("Errore interno — riprova."); resetDraw(); return; }

    // ── 2-D bounding-box of the stroke ──
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const { x, y } of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    const { cam, pos: camPos, forward, planePoint, containerW, containerH } = frozen;
    const unp = (sx: number, sy: number) =>
        unprojectOntoPlane(sx, sy, containerW, containerH, cam, planePoint, forward);

    // Unproject the 4 corners of the 2-D bbox onto the frozen vertical 3-D plane.
    const TL = unp(minX, minY);
    const TR = unp(maxX, minY);
    const BL = unp(minX, maxY);
    const BR = unp(maxX, maxY);

    if (!TL || !TR || !BL || !BR) {
      setStatus("Proiezione fallita — riprova.");
      resetDraw();
      return;
    }

    const width  = TL.distanceTo(TR);
    const height = TL.distanceTo(BL);

    if (width < MIN_BOX_SIDE_M || height < MIN_BOX_SIDE_M) {
      setStatus(`Box troppo piccolo (${(width * 100).toFixed(0)} × ${(height * 100).toFixed(0)} cm) — riprova.`);
      resetDraw();
      return;
    }

    const center = new THREE.Vector3()
        .add(TL).add(TR).add(BL).add(BR)
        .multiplyScalar(0.25);

    // Ensure the box face points toward the camera.
    const facingForward = forward.clone();
    if (facingForward.dot(camPos.clone().sub(center)) < 0) facingForward.negate();

    const mesh = makeWindowBox({
      center, width, height,
      thickness: thicknessRef.current,
      forward:   facingForward,
      color:     COLORS[colorKey],
    });
    three.root.add(mesh);
    placedRef.current.push(mesh);

    // World-lock via XR anchor (best-effort — non-fatal if unavailable).
    const session  = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const xrTransform = new XRRigidTransform(
            { x: center.x, y: center.y, z: center.z, w: 1 },
            { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
        );
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(xrTransform, refSpace);
        anchoredRef.current.push({ anchor, obj: mesh });
      } catch { /* anchors are optional */ }
    }

    setStatus(`✅  ${(width * 100).toFixed(0)} × ${(height * 100).toFixed(0)} cm`);
    resetDraw();
  }

  function onPointerCancel(e: React.PointerEvent) {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    stroke2DRef.current        = [];
    frozenCamRef.current       = null;
    setStroke2D([]);
    threeRef.current?.trail.reset();
    setPhase("idle");
    setStatus("Annullato.");
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
      three.root.remove(obj);
      disposeObject(obj);
    }
    anchoredRef.current = [];
    for (const obj of placedRef.current) { three.root.remove(obj); disposeObject(obj); }
    placedRef.current = [];
    three.trail.reset();
    stroke2DRef.current = [];
    setStroke2D([]);
    setPhase("idle");
    setStatus("Scena svuotata.");
  }

  // ── SVG overlay data ───────────────────────────────────────────────────────

  /** SVG "d" attribute for the free-hand highlighter path. */
  const strokePath = useMemo(() => {
    if (stroke2D.length < 2) return "";
    return "M " + stroke2D.map(({ x, y }) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
  }, [stroke2D]);

  /** Live bounding-box shown as a dashed rectangle while drawing. */
  const bboxRect = useMemo(() => {
    if (phase !== "drawing" || stroke2D.length < 2) return null;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
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
        {/* ── SVG: free-hand highlighter + live bbox ── */}
        <svg
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 10 }}
            width="100%"
            height="100%"
        >
          {/* Yellow translucent highlighter */}
          <path
              d={strokePath}
              fill="none"
              stroke="rgba(255,235,59,0.50)"
              strokeWidth={22}
              strokeLinecap="round"
              strokeLinejoin="round"
          />
          {/* Dashed bounding-box preview */}
          {bboxRect && (
              <rect
                  x={bboxRect.x} y={bboxRect.y}
                  width={bboxRect.w} height={bboxRect.h}
                  fill="rgba(255,235,59,0.06)"
                  stroke="rgba(255,235,59,0.85)"
                  strokeWidth={2}
                  strokeDasharray="7 4"
              />
          )}
        </svg>

        {/* ── HUD ── */}
        <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[580px]">

          {/* Status line */}
          <p className="mb-2 text-sm text-white drop-shadow-md">
            {status}
            {phase === "processing" && (
                <span className="ml-2 animate-pulse text-yellow-200">• elaborazione…</span>
            )}
          </p>

          {/*
          Controls wrapper: stopPropagation on all pointer events so that
          tapping a button never accidentally starts a draw stroke.
        */}
          <div
              className="pointer-events-auto flex flex-wrap gap-2"
              onPointerDownCapture={(e) => e.stopPropagation()}
              onPointerMoveCapture={(e) => e.stopPropagation()}
              onPointerUpCapture={(e)   => e.stopPropagation()}
          >
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

            {/* ── Colour picker ── */}
            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Colore</span>
              <select
                  className="bg-transparent text-sm text-white outline-none"
                  value={colorKey}
                  onChange={(e) => {
                    const key = e.target.value as ColorKey;
                    setColorKey(key);
                    // Update already-placed boxes so the colour feels live.
                    placedRef.current.forEach((obj) => tintObject(obj, COLORS[key]));
                  }}
              >
                <option value="gold">Oro</option>
                <option value="cyan">Ciano</option>
                <option value="magenta">Magenta</option>
                <option value="white">Bianco</option>
              </select>
            </label>

            {/* ── Frame thickness ── */}
            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Spessore</span>
              <input
                  type="range" min={0.01} max={0.18} step={0.01}
                  defaultValue={thicknessRef.current}
                  onChange={(e) => { thicknessRef.current = Number(e.target.value); }}
              />
            </label>

            {/* ── Draw distance ── */}
            <label className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 backdrop-blur">
              <span className="text-xs text-white opacity-75">Distanza</span>
              <input
                  type="range" min={0.5} max={4.0} step={0.1}
                  defaultValue={drawDistanceRef.current}
                  onChange={(e) => { drawDistanceRef.current = Number(e.target.value); }}
              />
            </label>
          </div>

          <p className="pointer-events-none mt-2 text-xs text-white/55">
            Disegna col dito → il box AR appare esattamente dove hai evidenziato.
          </p>
        </div>
      </div>
  );
}