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

// preview: accetta corners o pose
type RectLike =
    | { corners: THREE.Vector3[] }
    | {
  center: THREE.Vector3;
  width: number;
  height: number;
  quaternion: THREE.Quaternion;
};

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

  // viewer hit-test (centro schermo) per stimare distanza “reale”
  const viewerHitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const lastFrameRef = useRef<XRFrame | null>(null);

  // ultimo hit valido (pos + rot) dal viewer ray
  const lastViewerHitRef = useRef<{
    position: THREE.Vector3;
    orientation: THREE.Quaternion;
  } | null>(null);

  // Anchors (opzionale)
  const anchorsSupportedRef = useRef(false);
  const anchoredRef = useRef<Anchored[]>([]);
  const placedRef = useRef<THREE.Object3D[]>([]);

  // Oggetti che devono restare frontali alla camera (billboard)
  const billboardsRef = useRef<THREE.Object3D[]>([]);

  const drawRef = useRef<DrawState>({ drawing: false, pointsWorld: [] });

  const [colorKey, setColorKey] = useState<ColorKey>("magenta");
  const thicknessRef = useRef(0.06);

  // piano “bloccato” su pointerDown, perpendicolare alla camera
  const drawPlaneRef = useRef<Plane | null>(null);

  // fallback distanza se non c’è hit-test (slider)
  const drawDistanceRef = useRef(1.2);

  // puntatore (pixel dito)
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  const raycasterRef = useRef(new THREE.Raycaster());
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
        typeof (session as unknown as { requestAnchor?: unknown }).requestAnchor ===
        "function";

    const renderer = rendererRef.current!;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    await renderer.xr.setSession(session);

    const refSpace = await session.requestReferenceSpace("local");
    refSpaceRef.current = refSpace;

    // viewer hit-test source
    try {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      viewerHitTestSourceRef.current =
          (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
    } catch {
      viewerHitTestSourceRef.current = null;
    }

    session.addEventListener("end", () => {
      viewerHitTestSourceRef.current = null;
      lastFrameRef.current = null;
      lastViewerHitRef.current = null;

      refSpaceRef.current = null;
      sessionRef.current = null;

      anchoredRef.current = [];
      placedRef.current = [];
      billboardsRef.current = [];

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
    setStatus("AR avviata. Disegna: il box resterà frontale alla camera.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      lastFrameRef.current = frame ?? null;

      // aggiorna ultimo hit dal viewer (centro schermo)
      if (frame && refSpaceRef.current && viewerHitTestSourceRef.current) {
        const hits = frame.getHitTestResults(viewerHitTestSourceRef.current);
        if (hits && hits.length > 0) {
          const pose = hits[0].getPose(refSpaceRef.current);
          if (pose) {
            const t = pose.transform;
            lastViewerHitRef.current = {
              position: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
              orientation: new THREE.Quaternion(
                  t.orientation.x,
                  t.orientation.y,
                  t.orientation.z,
                  t.orientation.w
              ),
            };
          }
        }
      }

      // mentre disegni: punti = ray(dal dito) ∩ piano bloccato
      if (frame && drawRef.current.drawing) {
        const pt = pointFromScreenOnDrawPlane();
        if (pt) {
          drawRef.current.pointsWorld.push(pt);
          three.trail.pushPoint(pt);

          const now = performance.now();
          if (now - previewThrottleRef.current > 35) {
            previewThrottleRef.current = now;
            updatePreview(drawRef.current.pointsWorld);
          }
        }
      }

      // aggiorna ancore (pos+rot)
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

      // BILLBOARD: rendi sempre frontali alla camera (yaw-only, verticali)
      const renderer = rendererRef.current!;
      const cam = getXRRenderCamera(renderer);
      const camPos = new THREE.Vector3();
      cam.getWorldPosition(camPos);

      for (const obj of billboardsRef.current) {
        billboardYawOnly(obj, camPos);
      }

      renderer.render(three.scene, three.camera);
    });
  }

  function stopAR() {
    sessionRef.current?.end();
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!isRunning) return;

    pointerRef.current = { x: e.clientX, y: e.clientY, active: true };

    const three = threeRef.current!;
    drawRef.current = { drawing: true, pointsWorld: [] };
    previewThrottleRef.current = 0;

    three.trail.reset();
    three.preview.clear();
    three.preview.visible = true;

    // BLOCCA PIANO perpendicolare alla camera, a distanza “giusta”
    const renderer = rendererRef.current!;
    const cam = getXRRenderCamera(renderer);

    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const camQ = new THREE.Quaternion();
    cam.getWorldQuaternion(camQ);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ).normalize();

    // distanza: se abbiamo un hit del viewer, usiamo quella (più realistica)
    let dist = drawDistanceRef.current;
    if (lastViewerHitRef.current) {
      dist = camPos.distanceTo(lastViewerHitRef.current.position);
    }

    // clamp per non “sparare” lontano
    dist = clamp(dist, 0.35, 3.0);

    const pointOnPlane = camPos.clone().add(forward.clone().multiplyScalar(dist));
    drawPlaneRef.current = { point: pointOnPlane, normal: forward };

    setStatus(`Traccio… (piano a ~${dist.toFixed(2)}m)`);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isRunning) return;
    if (!pointerRef.current.active) return;
    pointerRef.current.x = e.clientX;
    pointerRef.current.y = e.clientY;
  }

  async function onPointerUp() {
    if (!isRunning) return;

    pointerRef.current.active = false;

    const three = threeRef.current!;
    const pts = drawRef.current.pointsWorld;
    drawRef.current.drawing = false;

    three.preview.visible = false;
    three.preview.clear();

    if (pts.length < 10) {
      setStatus("Tratto troppo corto.");
      three.trail.reset();
      drawPlaneRef.current = null;
      return;
    }

    const rect0 = fitVerticalRectFromStroke(pts);
    if (!rect0) {
      setStatus("Non riesco a stimare un rettangolo. Riprova.");
      three.trail.reset();
      drawPlaneRef.current = null;
      return;
    }

    // ORIENTA FRONTale alla camera (yaw-only)
    const renderer = rendererRef.current!;
    const cam = getXRRenderCamera(renderer);
    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const rect = {
      ...rect0,
      quaternion: yawFacingQuaternion(rect0.center, camPos),
    };

    const box = makeWindowBox(rect, {
      thickness: thicknessRef.current,
      color: COLORS[colorKey],
    });

    three.root.add(box);
    placedRef.current.push(box);
    billboardsRef.current.push(box); // resta frontale

    // anchor se disponibile (posizione stabile) — rotazione la override col billboard
    const session = sessionRef.current;
    const refSpace = refSpaceRef.current;
    if (session && refSpace && anchorsSupportedRef.current) {
      try {
        const xrTransform = new XRRigidTransform(
            { x: rect.center.x, y: rect.center.y, z: rect.center.z },
            { x: 0, y: 0, z: 0, w: 1 } // rot la gestiamo noi col billboard
        );
        const anchor = await (session as unknown as {
          requestAnchor: (t: XRRigidTransform, s: XRReferenceSpace) => Promise<XRAnchor>;
        }).requestAnchor(xrTransform, refSpace);

        anchoredRef.current.push({ anchor, obj: box });
      } catch {}
    }

    three.trail.reset();
    drawPlaneRef.current = null;

    setStatus("Creato ✅ (sempre frontale alla camera)");
  }

  function updatePreview(points: THREE.Vector3[]) {
    const three = threeRef.current;
    if (!three) return;

    const rect0 = fitVerticalRectFromStroke(points);
    if (!rect0) return;

    const renderer = rendererRef.current!;
    const cam = getXRRenderCamera(renderer);
    const camPos = new THREE.Vector3();
    cam.getWorldPosition(camPos);

    const snapped = {
      ...rect0,
      quaternion: yawFacingQuaternion(rect0.center, camPos),
    };

    three.preview.clear();
    three.preview.add(makePreviewRect(snapped, { color: COLORS[colorKey] }));
    three.preview.visible = true;
  }

  // punto 3D: ray(dal dito) ∩ piano bloccato
  function pointFromScreenOnDrawPlane(): THREE.Vector3 | null {
    const plane = drawPlaneRef.current;
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (!plane || !renderer || !container) return null;
    if (!pointerRef.current.active) return null;

    const rect = container.getBoundingClientRect();
    const x = ((pointerRef.current.x - rect.left) / rect.width) * 2 - 1;
    const y = -(((pointerRef.current.y - rect.top) / rect.height) * 2 - 1);

    const cam = getXRRenderCamera(renderer);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(new THREE.Vector2(x, y), cam);

    return intersectRayPlane(
        raycaster.ray.origin,
        raycaster.ray.direction,
        plane.point,
        plane.normal
    );
  }

  function undoLast() {
    const three = threeRef.current;
    if (!three) return;

    const last = placedRef.current.pop();
    if (!last) {
      setStatus("Niente da annullare.");
      return;
    }

    // rimuovi da billboard list
    billboardsRef.current = billboardsRef.current.filter((o) => o !== last);

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
    billboardsRef.current = [];

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
          onPointerMove={onPointerMove}
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
                  min={0.35}
                  max={3.0}
                  step={0.05}
                  defaultValue={drawDistanceRef.current}
                  onChange={(e) => (drawDistanceRef.current = Number(e.target.value))}
              />
            </div>
          </div>

          <div className="pointer-events-none mt-2 text-xs text-white/80">
            Ora: piano bloccato frontale + box sempre frontale alla camera (verticale).
          </div>
        </div>
      </div>
  );
}

/* ---------------- helpers ---------------- */

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
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

// yaw-only quaternion che guarda la camera, restando verticale
function yawFacingQuaternion(objPos: THREE.Vector3, camPos: THREE.Vector3): THREE.Quaternion {
  const toCam = camPos.clone().sub(objPos);
  toCam.y = 0;
  if (toCam.lengthSq() < 1e-8) toCam.set(0, 0, 1);
  toCam.normalize();

  // forward deve puntare verso camera
  const forward = toCam; // (x,z)
  const up = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(up, forward);
  if (right.lengthSq() < 1e-8) right = new THREE.Vector3(1, 0, 0);
  right.normalize();

  const basis = new THREE.Matrix4().makeBasis(right, up, forward);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

function billboardYawOnly(obj: THREE.Object3D, camPos: THREE.Vector3) {
  obj.quaternion.copy(yawFacingQuaternion(obj.position, camPos));
}

function computeRectCornersFromPose(rect: {
  center: THREE.Vector3;
  width: number;
  height: number;
  quaternion: THREE.Quaternion;
}): THREE.Vector3[] {
  const hw = rect.width * 0.5;
  const hh = rect.height * 0.5;

  const local = [
    new THREE.Vector3(-hw, -hh, 0),
    new THREE.Vector3(+hw, -hh, 0),
    new THREE.Vector3(+hw, +hh, 0),
    new THREE.Vector3(-hw, +hh, 0),
  ];

  return local.map((p) => p.applyQuaternion(rect.quaternion).add(rect.center));
}

function makePreviewRect(rect: RectLike, opts: { color: number }): THREE.Group {
  const g = new THREE.Group();
  const corners =
      "corners" in rect ? rect.corners : computeRectCornersFromPose(rect);

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