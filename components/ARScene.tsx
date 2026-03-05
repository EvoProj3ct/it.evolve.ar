"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Anchored = { anchor: XRAnchor; obj: THREE.Object3D };

type ColorKey = "gold" | "cyan" | "magenta" | "white";
const COLORS: Record<ColorKey, number> = {
  gold: 0xffd700,
  cyan: 0x00e5ff,
  magenta: 0xff4fd8,
  white: 0xffffff,
};

type Plane = { point: THREE.Vector3; normal: THREE.Vector3 };

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

export default function ARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root: THREE.Group;
  } | null>(null);

  const [status, setStatus] = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);

  const sessionRef = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  // viewer hit-test (centro schermo) → stima distanza reale
  const viewerHitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const autoDistRef = useRef<number | null>(null);

  // Anchors (opzionale)
  const anchorsSupportedRef = useRef(false);
  const anchoredRef = useRef<Anchored[]>([]);
  const placedRef = useRef<THREE.Object3D[]>([]);

  const [colorKey, setColorKey] = useState<ColorKey>("magenta");
  const thicknessRef = useRef(0.06);
  const drawDistanceRef = useRef(1.2);

  // piano “muro finto” davanti camera, deciso al down
  const drawPlaneRef = useRef<Plane | null>(null);
  const planeAxesRef = useRef<{ right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3 } | null>(null);

  // input tracking robusto
  const activePointerIdRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });

  // “evidenziatore” in 2D (punti in pixel, relativi al container)
  const [strokePts, setStrokePts] = useState<Array<{ x: number; y: number }>>([]);
  const strokePtsRef = useRef<Array<{ x: number; y: number }>>([]);
  const drawingRef = useRef(false);

  const raycasterRef = useRef(new THREE.Raycaster());

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

    // canvas sempre full screen
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    // IMPORTANTISSIMO: lascia input al DOM overlay, non al canvas
    renderer.domElement.style.pointerEvents = "none";

    container.style.position = "relative";
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

    threeRef.current = { scene, camera, root };

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize(w, h, true);
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
  }, []);

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
        typeof (session as unknown as { requestAnchor?: unknown }).requestAnchor === "function";

    const renderer = rendererRef.current!;
    await renderer.xr.setSession(session);

    const refSpace = await session.requestReferenceSpace("local");
    refSpaceRef.current = refSpace;

    // viewer hit-test
    try {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      viewerHitTestSourceRef.current =
          (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
    } catch {
      viewerHitTestSourceRef.current = null;
    }

    session.addEventListener("end", () => {
      viewerHitTestSourceRef.current = null;
      autoDistRef.current = null;

      refSpaceRef.current = null;
      sessionRef.current = null;

      anchoredRef.current = [];
      placedRef.current = [];

      // reset stroke/input
      activePointerIdRef.current = null;
      pointerRef.current.active = false;
      drawingRef.current = false;
      strokePtsRef.current = [];
      setStrokePts([]);

      setIsRunning(false);
      setStatus("Sessione AR terminata");
    });

    setIsRunning(true);
    setStatus("AR avviata. Evidenzia (giallo) e poi rilascia.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      const refSpaceNow = refSpaceRef.current!;
      const rendererNow = rendererRef.current!;

      // aggiorna distanza auto
      if (frame && viewerHitTestSourceRef.current && refSpaceNow) {
        const hits = frame.getHitTestResults(viewerHitTestSourceRef.current);
        if (hits && hits.length > 0) {
          const pose = hits[0].getPose(refSpaceNow);
          if (pose) {
            const t = pose.transform;
            const hitPos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
            const cam = getXRRenderCamera(rendererNow);
            const camPos = new THREE.Vector3();
            cam.getWorldPosition(camPos);

            const rawDist = camPos.distanceTo(hitPos);
            const clamped = clamp(rawDist, 0.35, 4.0);
            const prev = autoDistRef.current;
            autoDistRef.current = prev == null ? clamped : prev * 0.85 + clamped * 0.15;
          }
        }
      }

      // aggiorna ancore
      if (frame && refSpaceNow) {
        for (const item of anchoredRef.current) {
          const pose = frame.getPose(item.anchor.anchorSpace, refSpaceNow);
          if (!pose) continue;
          const t = pose.transform;
          item.obj.position.set(t.position.x, t.position.y, t.position.z);
          item.obj.quaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        }
      }

      rendererNow.render(three.scene, three.camera);
    });
  }

  function stopAR() {
    sessionRef.current?.end();
  }

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

    setStatus("Tutto cancellato.");
  }

  // ===== INPUT: evidenziatore =====

  function onPointerDown(e: React.PointerEvent) {
    if (!isRunning) return;

    // non iniziare se tocchi UI
    if ((e.target as HTMLElement).closest("button,select,input,textarea,label,a")) return;

    e.preventDefault();

    activePointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    pointerRef.current = { x: e.clientX, y: e.clientY, active: true };

    // prepara piano davanti camera (una volta per stroke)
    setupFrontPlane();

    // inizia stroke 2D
    drawingRef.current = true;
    const p = toLocalPoint(e.clientX, e.clientY);
    strokePtsRef.current = [p];
    setStrokePts([p]);

    setStatus("Evidenzia… poi rilascia per creare il box.");
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isRunning) return;
    if (activePointerIdRef.current !== e.pointerId) return;
    if (!pointerRef.current.active || !drawingRef.current) return;

    e.preventDefault();
    pointerRef.current.x = e.clientX;
    pointerRef.current.y = e.clientY;

    const p = toLocalPoint(e.clientX, e.clientY);
    // decima un po’ (evita 2000 punti)
    const arr = strokePtsRef.current;
    const last = arr[arr.length - 1];
    if (!last || dist2(last, p) > 2.5) {
      arr.push(p);
      // aggiorna UI (non ad ogni singolo pixel, ma abbastanza spesso)
      if (arr.length % 2 === 0) setStrokePts([...arr]);
    }
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
    drawingRef.current = false;

    const pts = strokePtsRef.current;
    if (pts.length < 6) {
      setStatus("Evidenziazione troppo corta.");
      strokePtsRef.current = [];
      setStrokePts([]);
      return;
    }

    // bounding box 2D dell’area evidenziata
    const bb = bounds2D(pts);

    // proietta i 4 angoli del bounding box sul piano 3D
    const rect3D = rectFromScreenBoundsOnPlane(bb);
    if (!rect3D) {
      setStatus("Non riesco a proiettare sul piano. Riprova.");
      strokePtsRef.current = [];
      setStrokePts([]);
      return;
    }

    // crea box
    const three = threeRef.current!;
    const box = makeWindowBox(rect3D, { thickness: thicknessRef.current, color: COLORS[colorKey] });
    three.root.add(box);
    placedRef.current.push(box);

    // anchor opzionale
    const session = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const xrTransform = new XRRigidTransform(
            { x: rect3D.center.x, y: rect3D.center.y, z: rect3D.center.z },
            { x: rect3D.quaternion.x, y: rect3D.quaternion.y, z: rect3D.quaternion.z, w: rect3D.quaternion.w }
        );
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(xrTransform, refSpace);
        anchoredRef.current.push({ anchor, obj: box });
      } catch {}
    }

    // pulisci stroke
    strokePtsRef.current = [];
    setStrokePts([]);

    setStatus("Creato ✅");
  }

  function onPointerCancel(e: React.PointerEvent) {
    if (activePointerIdRef.current !== e.pointerId) return;

    activePointerIdRef.current = null;
    pointerRef.current.active = false;
    drawingRef.current = false;

    strokePtsRef.current = [];
    setStrokePts([]);

    setStatus("Annullato (pointercancel)");
  }

  // ===== helper geometria =====

  function toLocalPoint(clientX: number, clientY: number) {
    const el = containerRef.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function setupFrontPlane() {
    const renderer = rendererRef.current!;
    const cam = getXRRenderCamera(renderer);

    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const camQ = new THREE.Quaternion();
    cam.getWorldQuaternion(camQ);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ).normalize();

    // yaw-only (verticale)
    const forwardYaw = forward.clone();
    forwardYaw.y = 0;
    if (forwardYaw.lengthSq() < 1e-8) forwardYaw.set(0, 0, -1);
    forwardYaw.normalize();

    const dist = clamp(autoDistRef.current ?? drawDistanceRef.current, 0.35, 4.0);
    const pointOnPlane = camPos.clone().add(forwardYaw.clone().multiplyScalar(dist));
    drawPlaneRef.current = { point: pointOnPlane, normal: forwardYaw };

    const up = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(up, forwardYaw);
    if (right.lengthSq() < 1e-8) right = new THREE.Vector3(1, 0, 0);
    right.normalize();

    planeAxesRef.current = { right, up, forward: forwardYaw };
  }

  function rectFromScreenBoundsOnPlane(bb: { minX: number; minY: number; maxX: number; maxY: number }) {
    const plane = drawPlaneRef.current;
    const axes = planeAxesRef.current;
    const renderer = rendererRef.current;
    const el = containerRef.current;
    if (!plane || !axes || !renderer || !el) return null;

    // 4 angoli del box 2D (in pixel, relativi al container)
    const corners2D = [
      { x: bb.minX, y: bb.minY },
      { x: bb.maxX, y: bb.minY },
      { x: bb.maxX, y: bb.maxY },
      { x: bb.minX, y: bb.maxY },
    ];

    // proietta ogni corner sul piano 3D
    const corners3D: THREE.Vector3[] = [];
    for (const p of corners2D) {
      const w = pointFromLocalPixelOnPlane(p.x, p.y);
      if (!w) return null;
      corners3D.push(w);
    }

    // width/height dal piano (dist tra corner)
    const width = corners3D[0].distanceTo(corners3D[1]);
    const height = corners3D[0].distanceTo(corners3D[3]);

    // center = media dei 4 corners
    const center = new THREE.Vector3();
    for (const c of corners3D) center.add(c);
    center.multiplyScalar(1 / 4);

    // orientazione dal piano (right/up/forward)
    const basis = new THREE.Matrix4().makeBasis(axes.right, axes.up, axes.forward);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);

    return { center, width, height, quaternion };
  }

  function pointFromLocalPixelOnPlane(localX: number, localY: number): THREE.Vector3 | null {
    const plane = drawPlaneRef.current;
    const renderer = rendererRef.current;
    const el = containerRef.current;
    if (!plane || !renderer || !el) return null;

    const r = el.getBoundingClientRect();
    const ndcX = (localX / r.width) * 2 - 1;
    const ndcY = -((localY / r.height) * 2 - 1);

    const cam = getXRRenderCamera(renderer);
    cam.updateMatrixWorld(true);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);

    return intersectRayPlane(raycaster.ray.origin, raycaster.ray.direction, plane.point, plane.normal);
  }

  const strokePath = useMemo(() => {
    if (strokePts.length === 0) return "";
    return "M " + strokePts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  }, [strokePts]);

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
        {/* evidenziatore: SOLO VISIVO, non blocca input */}
        <svg
            className="absolute inset-0"
            style={{ pointerEvents: "none" }}
            width="100%"
            height="100%"
        >
          <path
              d={strokePath}
              fill="none"
              stroke="rgba(255, 235, 59, 0.55)"  // giallo evidenziatore
              strokeWidth={26}
              strokeLinecap="round"
              strokeLinejoin="round"
          />
        </svg>

        {/* UI */}
        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[560px]">
          <div className="pointer-events-none mb-2 text-sm text-white [text-shadow:_0_1px_2px_rgba(0,0,0,0.85)]">
            {status}
          </div>

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
                  min={0.35}
                  max={4.0}
                  step={0.05}
                  defaultValue={drawDistanceRef.current}
                  onChange={(e) => (drawDistanceRef.current = Number(e.target.value))}
              />
            </div>
          </div>

          <div className="pointer-events-none mt-2 text-xs text-white/80">
            Evidenzia in giallo e rilascia → crea il box. (Distanza auto se hit-test becca superfici)
          </div>
        </div>
      </div>
  );
}

/* ---------------- helpers ---------------- */

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function bounds2D(pts: Array<{ x: number; y: number }>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function getXRRenderCamera(renderer: THREE.WebGLRenderer): THREE.Camera {
  const xrCam = (renderer.xr as unknown as {
    getCamera: () => THREE.Camera & { cameras?: THREE.Camera[] };
  }).getCamera();
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