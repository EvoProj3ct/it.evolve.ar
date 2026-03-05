"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { makeGoldenTrail } from "@/server-utils/lib/fx/goldenTrail";
import { fitVerticalRectFromStroke } from "@/server-utils/lib/geometry/planeRect";

type Anchored = { anchor: XRAnchor; obj: THREE.Object3D };
type DrawState = { drawing: boolean; pointsWorld: THREE.Vector3[] };

type ColorKey = "gold" | "cyan" | "magenta" | "white";
const COLORS: Record<ColorKey, number> = {
  gold: 0xffd700,
  cyan: 0x00e5ff,
  magenta: 0xff4fd8,
  white: 0xffffff,
};

type Plane = { point: THREE.Vector3; normal: THREE.Vector3 };

// ---------------- type guards ----------------
function isMaterialWithColor(
    m: unknown
): m is THREE.Material & { color: THREE.Color; needsUpdate: boolean } {
  return (
      typeof m === "object" &&
      m !== null &&
      "color" in (m as Record<string, unknown>) &&
      (m as { color?: unknown }).color instanceof THREE.Color
  );
}

// ---------------- component ----------------
export default function ARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root: THREE.Group;
    trail: ReturnType<typeof makeGoldenTrail>;
    preview: THREE.Group;
  } | null>(null);

  const [status, setStatus] = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);

  const sessionRef = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  // Anchors
  const anchorsSupportedRef = useRef(false);
  const anchoredRef = useRef<Anchored[]>([]);
  const placedRef = useRef<THREE.Object3D[]>([]);

  const drawRef = useRef<DrawState>({ drawing: false, pointsWorld: [] });

  const [colorKey, setColorKey] = useState<ColorKey>("magenta");
  const thicknessRef = useRef(0.06);

  // fallback plane davanti (se non c'è hit-test touch)
  const drawPlaneRef = useRef<Plane | null>(null);
  const drawDistanceRef = useRef(1.6);

  // ✅ puntatore reale (pixel dito)
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  // ✅ per drag affidabile in AR dom-overlay
  const activePointerIdRef = useRef<number | null>(null);

  const raycasterRef = useRef(new THREE.Raycaster());
  const previewThrottleRef = useRef(0);

  // ✅ transient hit-test per touchscreen (precisione massima)
  const transientHitTestSourceRef = useRef<XRHitTestSource | null>(null);

  // ✅ salvo l'ultimo hit valido mentre disegno (pos + rot della superficie)
  const lastSurfaceHitRef = useRef<{
    position: THREE.Vector3;
    orientation: THREE.Quaternion;
  } | null>(null);

  // per update in loop
  const lastFrameRef = useRef<XRFrame | null>(null);

  // --- evidenziatore 2D (solo visuale) ---
  const stroke2DRef = useRef<Array<{ x: number; y: number }>>([]);
  const [stroke2D, setStroke2D] = useState<Array<{ x: number; y: number }>>([]);
  const strokeThrottleRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current!;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });

    renderer.xr.enabled = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera();

    const root = new THREE.Group();
    scene.add(root);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(1, 2, 1);
    scene.add(dir);

    const trail = makeGoldenTrail({ color: COLORS[colorKey] });
    root.add(trail.object);

    const preview = new THREE.Group();
    preview.visible = false;
    root.add(preview);

    threeRef.current = { scene, camera, root, trail, preview };

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));

      // ✅ COME LA VERSIONE CHE “FUNZIONAVA”
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      try {
        sessionRef.current?.end();
      } catch {}
      renderer.setAnimationLoop(null);
      renderer.dispose();
      try {
        container.removeChild(renderer.domElement);
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;
    three.trail.setColor(COLORS[colorKey]);
    setGroupColor(three.preview, COLORS[colorKey]);
  }, [colorKey]);

  async function startAR() {
    if (isRunning) return;

    const xr = (navigator as unknown as { xr?: XRSystem }).xr;
    if (!xr) {
      setStatus("WebXR non disponibile");
      return;
    }

    setStatus("Avvio sessione AR…");

    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay", "local-floor"],
      domOverlay: { root: document.body },
    } as XRSessionInit);

    sessionRef.current = session;
    anchorsSupportedRef.current =
        typeof (session as unknown as { requestAnchor?: unknown }).requestAnchor ===
        "function";

    const renderer = rendererRef.current!;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    await renderer.xr.setSession(session);

    const refSpace = await session.requestReferenceSpace("local");
    refSpaceRef.current = refSpace;

    // ✅ transient hit-test per touchscreen (il dito)
    try {
      transientHitTestSourceRef.current =
          (await (session as unknown as {
            requestHitTestSourceForTransientInput?: (o: {
              profile: string;
            }) => Promise<XRHitTestSource>;
          }).requestHitTestSourceForTransientInput?.({ profile: "generic-touchscreen" })) ?? null;
    } catch {
      transientHitTestSourceRef.current = null;
    }

    session.addEventListener("end", () => {
      transientHitTestSourceRef.current = null;
      lastFrameRef.current = null;
      lastSurfaceHitRef.current = null;

      refSpaceRef.current = null;
      sessionRef.current = null;

      anchoredRef.current = [];
      placedRef.current = [];

      const three = threeRef.current;
      if (three) {
        three.preview.clear();
        three.preview.visible = false;
        three.trail.reset();
      }

      drawPlaneRef.current = null;

      // reset input/evidenziatore
      activePointerIdRef.current = null;
      pointerRef.current.active = false;
      stroke2DRef.current = [];
      setStroke2D([]);

      setIsRunning(false);
      setStatus("Sessione AR terminata");
    });

    setIsRunning(true);
    setStatus("AR avviata. Evidenzia col dito (giallo) e rilascia.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      lastFrameRef.current = frame ?? null;

      // mentre disegni: punti REALI da transient hit-test (se possibile) altrimenti fallback plane
      if (frame && drawRef.current.drawing) {
        const pt = pointFromTouchHitTest(frame) ?? pointFromScreenOnDrawPlane();
        if (pt) {
          drawRef.current.pointsWorld.push(pt);
          three.trail.pushPoint(pt);

          const now = performance.now();
          if (now - previewThrottleRef.current > 40) {
            previewThrottleRef.current = now;
            updatePreview(drawRef.current.pointsWorld);
          }
        }
      }

      // aggiorno ancore
      if (frame && refSpaceRef.current) {
        for (const item of anchoredRef.current) {
          const pose = frame.getPose(item.anchor.anchorSpace, refSpaceRef.current);
          if (!pose) continue;
          const t = pose.transform;
          item.obj.position.set(t.position.x, t.position.y, t.position.z);
          item.obj.quaternion.set(
              t.orientation.x,
              t.orientation.y,
              t.orientation.z,
              t.orientation.w
          );
        }
      }

      renderer.render(three.scene, three.camera);
    });
  }

  function stopAR() {
    sessionRef.current?.end();
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!isRunning) return;

    // ✅ UI non deve triggerare il draw
    if ((e.target as HTMLElement).closest("button,select,input,textarea,label,a")) return;

    e.preventDefault();

    activePointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    pointerRef.current = { x: e.clientX, y: e.clientY, active: true };

    const three = threeRef.current!;
    drawRef.current = { drawing: true, pointsWorld: [] };
    previewThrottleRef.current = 0;
    lastSurfaceHitRef.current = null;

    // reset evidenziatore
    stroke2DRef.current = [];
    setStroke2D([]);

    // fallback plane davanti camera
    const renderer = rendererRef.current!;
    const cam = getXRRenderCamera(renderer, three.camera);

    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const camQ = new THREE.Quaternion();
    cam.getWorldQuaternion(camQ);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ).normalize();
    const pointOnPlane = camPos.clone().add(forward.clone().multiplyScalar(drawDistanceRef.current));
    drawPlaneRef.current = { point: pointOnPlane, normal: forward };

    // primo punto evidenziatore (2D)
    pushStroke2D(e.clientX, e.clientY);

    three.trail.reset();
    three.preview.clear();
    three.preview.visible = true;

    setStatus("Evidenzio…");
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isRunning) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    if (!pointerRef.current.active) return;

    e.preventDefault();

    pointerRef.current.x = e.clientX;
    pointerRef.current.y = e.clientY;

    // evidenziatore 2D
    pushStroke2D(e.clientX, e.clientY);
  }

  async function onPointerUp(e: React.PointerEvent) {
    if (!isRunning) return;
    if (activePointerIdRef.current !== e.pointerId) return;

    e.preventDefault();

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    activePointerIdRef.current = null;
    pointerRef.current.active = false;

    const three = threeRef.current!;
    const pts = drawRef.current.pointsWorld;
    drawRef.current.drawing = false;

    three.preview.visible = false;
    three.preview.clear();

    // pulisci evidenziatore (lasciamo un attimo? qui lo tolgo subito)
    stroke2DRef.current = [];
    setStroke2D([]);

    if (pts.length < 10) {
      setStatus("Tratto troppo corto.");
      three.trail.reset();
      return;
    }

    const rect0 = fitVerticalRectFromStroke(pts);
    if (!rect0) {
      setStatus("Non riesco a stimare un rettangolo. Riprova.");
      three.trail.reset();
      return;
    }

    const { rect, didSnap } = snapRectFrontToLastSurface(rect0);

    const box = makeWindowBox(rect, {
      thickness: thicknessRef.current,
      color: COLORS[colorKey],
    });

    three.root.add(box);
    placedRef.current.push(box);

    // anchor se disponibile
    const session = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const xrTransform = new XRRigidTransform(
            { x: rect.center.x, y: rect.center.y, z: rect.center.z },
            {
              x: rect.quaternion.x,
              y: rect.quaternion.y,
              z: rect.quaternion.z,
              w: rect.quaternion.w,
            }
        );
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(xrTransform, refSpace);

        anchoredRef.current.push({ anchor, obj: box });
      } catch {}
    }

    three.trail.reset();
    drawPlaneRef.current = null;

    setStatus(didSnap ? "Finestra frontale sul muro ✅" : "Creato (fallback plane)");
  }

  function onPointerCancel(e: React.PointerEvent) {
    if (activePointerIdRef.current !== e.pointerId) return;

    activePointerIdRef.current = null;
    pointerRef.current.active = false;
    drawRef.current.drawing = false;

    const three = threeRef.current;
    if (three) {
      three.preview.visible = false;
      three.preview.clear();
      three.trail.reset();
    }

    drawPlaneRef.current = null;
    lastSurfaceHitRef.current = null;

    stroke2DRef.current = [];
    setStroke2D([]);

    setStatus("Annullato (pointercancel)");
  }

  function updatePreview(points: THREE.Vector3[]) {
    const three = threeRef.current;
    if (!three) return;

    const rect = fitVerticalRectFromStroke(points);
    if (!rect) return;

    const { rect: snapped } = snapRectFrontToLastSurface(rect);
    three.preview.clear();
    three.preview.add(makePreviewRect(snapped, { color: COLORS[colorKey] }));
    three.preview.visible = true;
  }

  // 1) punto preciso da hit-test transient touchscreen (superficie reale)
  function pointFromTouchHitTest(frame: XRFrame): THREE.Vector3 | null {
    const refSpace = refSpaceRef.current;
    const src = transientHitTestSourceRef.current;
    if (!refSpace || !src) return null;

    const getTransient = (frame as unknown as {
      getHitTestResultsForTransientInput?: (s: XRHitTestSource) => Array<{
        inputSource: XRInputSource;
        results: XRHitTestResult[];
      }>;
    }).getHitTestResultsForTransientInput;

    if (!getTransient) return null;

    const transientResults = getTransient.call(frame, src);
    if (!transientResults || transientResults.length === 0) return null;

    for (const tr of transientResults) {
      const results = tr.results;
      if (!results || results.length === 0) continue;

      const pose = results[0].getPose(refSpace);
      if (!pose) continue;

      const t = pose.transform;
      const pos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
      const q = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);

      lastSurfaceHitRef.current = { position: pos.clone(), orientation: q.clone() };
      return pos;
    }

    return null;
  }

  // 2) fallback: ray da pixel dito ∩ piano davanti camera
  function pointFromScreenOnDrawPlane(): THREE.Vector3 | null {
    const plane = drawPlaneRef.current;
    const renderer = rendererRef.current;
    const three = threeRef.current;
    const container = containerRef.current;
    if (!plane || !renderer || !three || !container) return null;
    if (!pointerRef.current.active) return null;

    const rect = container.getBoundingClientRect();
    const x = ((pointerRef.current.x - rect.left) / rect.width) * 2 - 1;
    const y = -(((pointerRef.current.y - rect.top) / rect.height) * 2 - 1);

    const cam = getXRRenderCamera(renderer, three.camera);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(new THREE.Vector2(x, y), cam);

    return intersectRayPlane(raycaster.ray.origin, raycaster.ray.direction, plane.point, plane.normal);
  }

  // Snap frontale usando ultima superficie hittata
  function snapRectFrontToLastSurface(rect: {
    center: THREE.Vector3;
    width: number;
    height: number;
    quaternion: THREE.Quaternion;
    corners: THREE.Vector3[];
  }): { rect: typeof rect; didSnap: boolean } {
    const hit = lastSurfaceHitRef.current;
    const renderer = rendererRef.current;
    const three = threeRef.current;
    if (!hit || !renderer || !three) return { rect, didSnap: false };

    const hitPos = hit.position.clone();
    const hitQ = hit.orientation.clone();

    let forward = new THREE.Vector3(0, 0, -1).applyQuaternion(hitQ).normalize();

    // yaw-only
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) {
      const cam = getXRRenderCamera(renderer, three.camera);
      const camQ = new THREE.Quaternion();
      cam.getWorldQuaternion(camQ);
      forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ);
      forward.y = 0;
    }
    forward.normalize();

    // faccia verso camera
    const cam = getXRRenderCamera(renderer, three.camera);
    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const toCam = camPos.clone().sub(hitPos).normalize();
    if (forward.dot(toCam) < 0) forward.multiplyScalar(-1);

    const up = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(up, forward);
    if (right.lengthSq() < 1e-8) right = new THREE.Vector3(1, 0, 0);
    right.normalize();

    const basis = new THREE.Matrix4().makeBasis(right, up, forward);
    const snappedQ = new THREE.Quaternion().setFromRotationMatrix(basis);

    return { rect: { ...rect, center: hitPos, quaternion: snappedQ }, didSnap: true };
  }

  function pushStroke2D(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = { x: clientX - r.left, y: clientY - r.top };

    const arr = stroke2DRef.current;
    const last = arr[arr.length - 1];
    if (!last || (Math.abs(last.x - p.x) + Math.abs(last.y - p.y)) > 2) {
      arr.push(p);

      const now = performance.now();
      if (now - strokeThrottleRef.current > 30) {
        strokeThrottleRef.current = now;
        setStroke2D([...arr]);
      }
    }
  }

  const strokePath = useMemo(() => {
    if (stroke2D.length === 0) return "";
    return "M " + stroke2D.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  }, [stroke2D]);

  function undoLast() {
    const three = threeRef.current;
    if (!three) return;

    const last = placedRef.current.pop();
    if (!last) {
      setStatus("Niente da annullare.");
      return;
    }

    const idx = anchoredRef.current.findIndex((a) => a.obj === last);
    if (idx >= 0) {
      const a = anchoredRef.current[idx];
      anchoredRef.current.splice(idx, 1);
      try {
        (a.anchor as unknown as { delete?: () => void }).delete?.();
      } catch {}
    }

    three.root.remove(last);
    disposeObject(last);

    setStatus("Ultimo rimosso.");
  }

  function clearAll() {
    const three = threeRef.current;
    if (!three) return;

    for (const a of anchoredRef.current) {
      try {
        (a.anchor as unknown as { delete?: () => void }).delete?.();
      } catch {}
      three.root.remove(a.obj);
      disposeObject(a.obj);
    }
    anchoredRef.current = [];

    for (const obj of placedRef.current) {
      three.root.remove(obj);
      disposeObject(obj);
    }
    placedRef.current = [];

    three.preview.clear();
    three.preview.visible = false;
    three.trail.reset();
    drawPlaneRef.current = null;
    lastSurfaceHitRef.current = null;

    stroke2DRef.current = [];
    setStroke2D([]);

    setStatus("Tutto cancellato.");
  }

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
        {/* evidenziatore giallo (solo visuale, non blocca input) */}
        <svg className="absolute inset-0" style={{ pointerEvents: "none" }} width="100%" height="100%">
          <path
              d={strokePath}
              fill="none"
              stroke="rgba(255, 235, 59, 0.55)"
              strokeWidth={26}
              strokeLinecap="round"
              strokeLinejoin="round"
          />
        </svg>

        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[560px]">
          <div className="pointer-events-none mb-2 text-sm text-white [text-shadow:_0_1px_2px_rgba(0,0,0,0.85)]">
            {status}
          </div>

          {/* IMPORTANTISSIMO: stopPropagation qui, così i bottoni non fanno partire il draw */}
          <div
              className="pointer-events-auto flex flex-wrap gap-2"
              onPointerDownCapture={(e) => e.stopPropagation()}
              onPointerMoveCapture={(e) => e.stopPropagation()}
              onPointerUpCapture={(e) => e.stopPropagation()}
          >
            <button
                onClick={startAR}
                disabled={isRunning}
                className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white backdrop-blur"
            >
              Start AR
            </button>

            <button
                onClick={stopAR}
                disabled={!isRunning}
                className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white backdrop-blur"
            >
              Stop
            </button>

            <button
                onClick={undoLast}
                disabled={!isRunning}
                className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white backdrop-blur"
            >
              Undo
            </button>

            <button
                onClick={clearAll}
                disabled={!isRunning}
                className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-white backdrop-blur"
            >
              Clear
            </button>

            <div className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-white backdrop-blur">
              <span className="text-xs opacity-80">Colore</span>
              <select
                  className="bg-transparent text-white text-sm outline-none"
                  value={colorKey}
                  onChange={(e) => setColorKey(e.target.value as ColorKey)}
              >
                <option value="gold">Oro</option>
                <option value="cyan">Ciano</option>
                <option value="magenta">Magenta</option>
                <option value="white">Bianco</option>
              </select>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-white backdrop-blur">
              <span className="text-xs opacity-80">Spess.</span>
              <input
                  type="range"
                  min={0.01}
                  max={0.18}
                  step={0.01}
                  defaultValue={thicknessRef.current}
                  onChange={(e) => (thicknessRef.current = Number(e.target.value))}
              />
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-white backdrop-blur">
              <span className="text-xs opacity-80">Dist.</span>
              <input
                  type="range"
                  min={0.6}
                  max={3.5}
                  step={0.1}
                  defaultValue={drawDistanceRef.current}
                  onChange={(e) => (drawDistanceRef.current = Number(e.target.value))}
              />
            </div>
          </div>

          <div className="pointer-events-none mt-2 text-xs text-white/80">
            Evidenzia in giallo e rilascia → crea il box. Se il touch hit-test becca il muro, viene frontale.
          </div>
        </div>
      </div>
  );
}

// ---------------- helpers ----------------

function getXRRenderCamera(renderer: THREE.WebGLRenderer, baseCamera: THREE.Camera): THREE.Camera {
  const xrCam = renderer.xr.getCamera(baseCamera) as unknown as THREE.Camera & { cameras?: THREE.Camera[] };
  return xrCam.cameras && xrCam.cameras.length > 0 ? xrCam.cameras[0] : xrCam;
}

function intersectRayPlane(
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
    planePoint: THREE.Vector3,
    planeNormal: THREE.Vector3
): THREE.Vector3 | null {
  const denom = planeNormal.dot(rayDir);
  if (Math.abs(denom) < 1e-6) return null;
  const t = planePoint.clone().sub(rayOrigin).dot(planeNormal) / denom;
  if (t < 0) return null;
  return rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));
}

function makePreviewRect(rect: { corners: THREE.Vector3[] }, opts: { color: number }): THREE.Group {
  const g = new THREE.Group();
  const corners = rect.corners;

  const fillGeom = new THREE.BufferGeometry();
  const v = new Float32Array([
    corners[0].x, corners[0].y, corners[0].z,
    corners[1].x, corners[1].y, corners[1].z,
    corners[2].x, corners[2].y, corners[2].z,
    corners[2].x, corners[2].y, corners[2].z,
    corners[3].x, corners[3].y, corners[3].z,
    corners[0].x, corners[0].y, corners[0].z,
  ]);
  fillGeom.setAttribute("position", new THREE.BufferAttribute(v, 3));
  fillGeom.computeVertexNormals();

  const fillMat = new THREE.MeshStandardMaterial({
    color: opts.color,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  g.add(new THREE.Mesh(fillGeom, fillMat));

  const lineGeom = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
  const lineMat = new THREE.LineBasicMaterial({ color: opts.color, transparent: true, opacity: 0.95 });
  g.add(new THREE.Line(lineGeom, lineMat));

  return g;
}

function makeWindowBox(
    rect: { center: THREE.Vector3; width: number; height: number; quaternion: THREE.Quaternion },
    opts: { thickness: number; color: number }
) {
  const geom = new THREE.BoxGeometry(rect.width, rect.height, opts.thickness);
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color,
    transparent: true,
    opacity: 0.25,
    metalness: 0.15,
    roughness: 0.35,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(rect.center);
  mesh.quaternion.copy(rect.quaternion);

  const edges = new THREE.EdgesGeometry(geom);
  mesh.add(
      new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color: opts.color, transparent: true, opacity: 0.95 })
      )
  );
  return mesh;
}

function setGroupColor(group: THREE.Group, color: number) {
  group.traverse((obj) => {
    const o = obj as unknown as { material?: unknown };
    const m = o.material;

    if (Array.isArray(m)) {
      for (const mm of m) {
        if (isMaterialWithColor(mm)) {
          mm.color.setHex(color);
          mm.needsUpdate = true;
        }
      }
    } else if (isMaterialWithColor(m)) {
      m.color.setHex(color);
      m.needsUpdate = true;
    }
  });
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const oo = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    oo.geometry?.dispose?.();

    const m = oo.material;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
    else m?.dispose?.();
  });
}