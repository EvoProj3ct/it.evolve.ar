"use client";

import { useEffect, useRef, useState } from "react";
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
    trail: ReturnType<typeof makeGoldenTrail>;
    preview: THREE.Group;
  } | null>(null);

  const [status, setStatus] = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);

  const sessionRef = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  // touch input (per targetRaySpace)
  const transientHitTestSourceRef = useRef<XRTransientInputHitTestSource | null>(null);

  // ✅ viewer hit-test (per incollare a muro/porta)
  const viewerHitTestSourceRef = useRef<XRHitTestSource | null>(null);

  // ✅ salva ultimo frame per usare hit-test nel pointerUp
  const lastFrameRef = useRef<XRFrame | null>(null);

  // Anchors
  const anchorsSupportedRef = useRef(false);
  const anchoredRef = useRef<Anchored[]>([]);
  const placedRef = useRef<THREE.Object3D[]>([]);

  const drawRef = useRef<DrawState>({ drawing: false, pointsWorld: [] });

  const [colorKey, setColorKey] = useState<ColorKey>("magenta");
  const thicknessRef = useRef(0.06);

  // piano davanti (fallback)
  const drawPlaneRef = useRef<Plane | null>(null);
  const drawDistanceRef = useRef(1.6);

  // correzione percezione dito
  const touchYOffsetRef = useRef(0.0);

  const previewThrottleRef = useRef(0);

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
        typeof (session as unknown as { requestAnchor?: unknown }).requestAnchor === "function";

    const renderer = rendererRef.current!;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    await renderer.xr.setSession(session);

    const refSpace = await session.requestReferenceSpace("local");
    refSpaceRef.current = refSpace;

    // touch transient
    try {
      transientHitTestSourceRef.current =
          (await session.requestHitTestSourceForTransientInput?.({
            profile: "generic-touchscreen",
          })) ?? null;
    } catch {
      transientHitTestSourceRef.current = null;
    }

    // ✅ viewer hit-test
    try {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      viewerHitTestSourceRef.current =
          (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
    } catch {
      viewerHitTestSourceRef.current = null;
    }

    session.addEventListener("end", () => {
      transientHitTestSourceRef.current = null;
      viewerHitTestSourceRef.current = null;
      lastFrameRef.current = null;

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

      setIsRunning(false);
      setStatus("Sessione AR terminata");
    });

    setIsRunning(true);
    setStatus("AR avviata. Tieni premuto e contorna il vano.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      const refSpaceNow = refSpaceRef.current!;

      lastFrameRef.current = frame ?? null;

      if (frame && drawRef.current.drawing) {
        const pt = pointFromTouchOnDrawPlane(frame, refSpaceNow);
        if (pt) {
          drawRef.current.pointsWorld.push(pt);
          three.trail.pushPoint(pt);

          const now = performance.now();
          if (now - previewThrottleRef.current > 50) {
            previewThrottleRef.current = now;
            updatePreview(drawRef.current.pointsWorld);
          }
        }
      }

      if (frame) {
        for (const item of anchoredRef.current) {
          const pose = frame.getPose(item.anchor.anchorSpace, refSpaceNow);
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

  function onPointerDown() {
    if (!isRunning) return;

    const three = threeRef.current!;
    drawRef.current = { drawing: true, pointsWorld: [] };
    previewThrottleRef.current = 0;

    // fallback plane davanti alla camera
    const renderer = rendererRef.current!;
    const cam = renderer.xr.getCamera() as unknown as THREE.Camera;

    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const pointOnPlane = camPos.clone().add(forward.clone().multiplyScalar(drawDistanceRef.current));

    drawPlaneRef.current = { point: pointOnPlane, normal: forward };

    three.trail.reset();
    three.preview.clear();
    three.preview.visible = true;

    setStatus("Traccio…");
  }

  async function onPointerUp() {
    if (!isRunning) return;

    const three = threeRef.current!;
    const pts = drawRef.current.pointsWorld;
    drawRef.current.drawing = false;

    three.preview.visible = false;
    three.preview.clear();

    if (pts.length < 10) {
      setStatus("Tratto troppo corto.");
      three.trail.reset();
      return;
    }

    // ✅ FIX TS: rect può essere null, quindi guard
    const rect0 = fitVerticalRectFromStroke(pts);
    if (!rect0) {
      setStatus("Non riesco a stimare un rettangolo. Riprova.");
      three.trail.reset();
      return;
    }

    // ✅ SNAP SU MURO/PORTA (se disponibile)
    const snapped = snapRectToViewerHit(rect0);

    const rect = snapped.rect;

    const box = makeWindowBox(rect, {
      thickness: thicknessRef.current,
      color: COLORS[colorKey],
    });

    three.root.add(box);
    placedRef.current.push(box);

    // ✅ ancora sul pose snappato (se anchors disponibili)
    const session = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const xrTransform = new XRRigidTransform(
            { x: rect.center.x, y: rect.center.y, z: rect.center.z },
            { x: rect.quaternion.x, y: rect.quaternion.y, z: rect.quaternion.z, w: rect.quaternion.w }
        );
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(xrTransform, refSpace);

        anchoredRef.current.push({ anchor, obj: box });
      } catch {}
    }

    three.trail.reset();
    drawPlaneRef.current = null;

    setStatus(snapped.didSnap ? "Incollato al muro/porta ✅" : "Creato (nessun piano trovato)");
  }

  function updatePreview(points: THREE.Vector3[]) {
    const three = threeRef.current;
    if (!three) return;

    const rect = fitVerticalRectFromStroke(points);
    if (!rect) return;

    three.preview.clear();
    three.preview.add(makePreviewRect(rect, { color: COLORS[colorKey] }));
    three.preview.visible = true;
  }

  function pointFromTouchOnDrawPlane(frame: XRFrame, refSpace: XRReferenceSpace): THREE.Vector3 | null {
    const plane = drawPlaneRef.current;
    if (!plane) return null;

    const src = transientHitTestSourceRef.current;
    if (!src) return null;

    const list = frame.getHitTestResultsForTransientInput?.(src);
    if (!list || list.length === 0) return null;

    const inputSource = list[0].inputSource;
    if (!inputSource?.targetRaySpace) return null;

    const pose = frame.getPose(inputSource.targetRaySpace, refSpace);
    if (!pose) return null;

    const o = pose.transform.position;
    const q = pose.transform.orientation;

    const origin = new THREE.Vector3(o.x, o.y, o.z);
    const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
        .normalize();

    const p = intersectRayPlane(origin, dir, plane.point, plane.normal);
    if (!p) return null;

    if (touchYOffsetRef.current !== 0) {
      p.add(new THREE.Vector3(0, 1, 0).multiplyScalar(touchYOffsetRef.current));
    }
    return p;
  }

  /**
   * ✅ Qui avviene la magia: incolla su un piano reale usando hit-test viewer.
   * - usa lastFrameRef (frame più recente)
   * - prende il primo hit
   * - sposta il centro del rettangolo sulla posa (posizione)
   * - ruota il rettangolo perché sia PARALLELO al muro (z = normale del muro)
   */
  function snapRectToViewerHit(rect: {
    center: THREE.Vector3;
    width: number;
    height: number;
    quaternion: THREE.Quaternion;
  }): { rect: typeof rect; didSnap: boolean } {
    const frame = lastFrameRef.current;
    const refSpace = refSpaceRef.current;
    const src = viewerHitTestSourceRef.current;

    if (!frame || !refSpace || !src || !frame.getHitTestResults) {
      return { rect, didSnap: false };
    }

    const hits = frame.getHitTestResults(src);
    if (!hits || hits.length === 0) return { rect, didSnap: false };

    const pose = hits[0].getPose(refSpace);
    if (!pose) return { rect, didSnap: false };

    const t = pose.transform;
    const hitPos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);

    // normale del muro: applica orientamento hit alla direzione -Z locale
    const hitQ = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    const wallNormal = new THREE.Vector3(0, 0, -1).applyQuaternion(hitQ).normalize();

    // vogliamo un rettangolo verticale (up = Y) e "front" = wallNormal
    const up = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(up, wallNormal);
    if (right.lengthSq() < 1e-8) {
      // caso raro: normal quasi parallela a up -> fallback
      right = new THREE.Vector3(1, 0, 0);
    } else {
      right.normalize();
    }

    const forward = wallNormal.clone().normalize(); // “fuori dal muro”
    const basis = new THREE.Matrix4().makeBasis(right, up, forward);
    const snappedQ = new THREE.Quaternion().setFromRotationMatrix(basis);

    // ✅ porta il rettangolo sulla profondità reale, mantenendo la stessa misura
    const snappedRect = {
      ...rect,
      center: hitPos,
      quaternion: snappedQ,
    };

    return { rect: snappedRect, didSnap: true };
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

    three.preview.clear();
    three.preview.visible = false;
    three.trail.reset();
    drawPlaneRef.current = null;

    setStatus("Tutto cancellato.");
  }

  return (
      <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
      >
        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[560px]">
          <div className="pointer-events-none mb-2 text-sm text-white [text-shadow:_0_1px_2px_rgba(0,0,0,0.85)]">
            {status}
          </div>

          <div className="pointer-events-auto flex flex-wrap gap-2">
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

            <div className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-white backdrop-blur">
              <span className="text-xs opacity-80">Y</span>
              <input
                  type="range"
                  min={-0.5}
                  max={0.5}
                  step={0.01}
                  defaultValue={touchYOffsetRef.current}
                  onChange={(e) => (touchYOffsetRef.current = Number(e.target.value))}
              />
            </div>
          </div>

          <div className="pointer-events-none mt-2 text-xs text-white/80">
            Ora: al rilascio prova a <b>incollare al muro/porta</b> usando hit-test viewer (centro schermo).
            Se non trova piani, resta sul piano “davanti a te”.
          </div>
        </div>
      </div>
  );
}

/* ---------------- helpers ---------------- */

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