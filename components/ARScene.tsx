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

export default function ARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root: THREE.Group;
    trail: ReturnType<typeof makeGoldenTrail>;
    preview: THREE.Group; // rettangolo mentre traccio
  } | null>(null);

  const [status, setStatus] = useState("Pronto");
  const [isRunning, setIsRunning] = useState(false);

  const sessionRef = useRef<XRSession | null>(null);
  const refSpaceRef = useRef<XRReferenceSpace | null>(null);

  // Touch hit-test (transient input)
  const transientHitTestSourceRef = useRef<any>(null);

  // Anchors
  const anchorsSupportedRef = useRef(false);
  const anchoredRef = useRef<Anchored[]>([]);
  const placedRef = useRef<THREE.Object3D[]>([]);

  const drawRef = useRef<DrawState>({ drawing: false, pointsWorld: [] });

  const [colorKey, setColorKey] = useState<ColorKey>("gold");
  const thicknessRef = useRef(0.06); // spessore parallelepipedo (metri)
  const previewThrottleRef = useRef(0);

  const resizeToContainer = () => {
    const container = containerRef.current;
    const renderer = rendererRef.current;
    if (!container || !renderer) return;

    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  };

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

    // luci un po’ più utili per leggere i box
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(1, 2, 1);
    scene.add(dir);

    const trail = makeGoldenTrail({ color: COLORS[colorKey] });
    root.add(trail.object);

    // preview group (rettangolo “fantasma” mentre traccio)
    const preview = new THREE.Group();
    preview.visible = false;
    root.add(preview);

    threeRef.current = { scene, camera, root, trail, preview };

    resizeToContainer();

    const ro = new ResizeObserver(() => resizeToContainer());
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

  // quando cambio colore: aggiorna trail + preview + futuri box
  useEffect(() => {
    const three = threeRef.current;
    if (!three) return;

    three.trail.setColor(COLORS[colorKey]);
    // aggiorna anche preview se esiste
    setPreviewColor(three.preview, COLORS[colorKey]);
  }, [colorKey]);

  async function startAR() {
    if (isRunning) return;

    const xr = (navigator as any).xr as XRSystem | undefined;
    if (!xr) {
      setStatus("WebXR non disponibile");
      return;
    }

    setStatus("Avvio sessione AR…");

    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay", "local-floor"],
      domOverlay: { root: document.body },
    } as any);

    sessionRef.current = session;
    anchorsSupportedRef.current = typeof (session as any).requestAnchor === "function";

    const renderer = rendererRef.current!;
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    await renderer.xr.setSession(session);

    const refSpace = await session.requestReferenceSpace("local");
    refSpaceRef.current = refSpace;

    try {
      transientHitTestSourceRef.current =
          await (session as any).requestHitTestSourceForTransientInput({
            profile: "generic-touchscreen",
          });
    } catch {
      transientHitTestSourceRef.current = null;
      setStatus("Hit-test touch non disponibile (generic-touchscreen).");
    }

    session.addEventListener("end", () => {
      transientHitTestSourceRef.current = null;
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

      setIsRunning(false);
      setStatus("Sessione AR terminata");
    });

    setIsRunning(true);
    setStatus("AR avviata. Tieni premuto e traccia il perimetro del vano.");

    renderer.setAnimationLoop((_time, frame) => {
      const three = threeRef.current!;
      const refSpaceNow = refSpaceRef.current!;

      if (frame) {
        // aggiorna ancore
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

        // disegno live + preview
        if (drawRef.current.drawing) {
          const pt = hitTestFromTouch(frame, refSpaceNow);
          if (pt) {
            drawRef.current.pointsWorld.push(pt);
            three.trail.pushPoint(pt);

            // preview: throttling leggero per non ammazzare mobile
            const now = performance.now();
            if (now - previewThrottleRef.current > 60) {
              previewThrottleRef.current = now;
              updatePreviewFromStroke(drawRef.current.pointsWorld);
            }
          }
        }
      }

      renderer.render(three.scene, three.camera);
    });
  }

  function stopAR() {
    sessionRef.current?.end();
  }

  function hitTestFromTouch(frame: XRFrame, refSpace: XRReferenceSpace): THREE.Vector3 | null {
    const tht = transientHitTestSourceRef.current;
    if (!tht) return null;

    const results = (frame as any).getHitTestResultsForTransientInput(tht) as any[];
    if (!results?.length) return null;

    const r0 = results[0];
    const hitResults = r0.results as XRHitTestResult[];
    if (!hitResults?.length) return null;

    const pose = hitResults[0].getPose(refSpace);
    if (!pose) return null;

    const p = pose.transform.position;
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  function onPointerDown() {
    if (!isRunning) return;

    const three = threeRef.current!;
    drawRef.current = { drawing: true, pointsWorld: [] };
    previewThrottleRef.current = 0;

    // reset trail e attiva preview
    three.trail.reset();
    three.preview.visible = true;
    three.preview.clear();
    setStatus("Traccio…");
  }

  async function onPointerUp() {
    if (!isRunning) return;

    const three = threeRef.current!;
    const pts = drawRef.current.pointsWorld;
    drawRef.current.drawing = false;

    // nascondi preview (poi lo rimpiazziamo con box definitivo)
    three.preview.visible = false;
    three.preview.clear();

    if (pts.length < 10) {
      setStatus("Tratto troppo corto. Tieni premuto e traccia un perimetro più ampio.");
      three.trail.reset();
      return;
    }

    // ✅ rettangolo VERTICALE (dritto) pensato per vani finestre/aperture
    const rect = fitVerticalRectFromStroke(pts);
    if (!rect) {
      setStatus("Non riesco a stimare un rettangolo verticale. Riprova.");
      three.trail.reset();
      return;
    }

    // ✅ crea parallelepipedo “fine”
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
        const xrTransform = new (window as any).XRRigidTransform(
            { x: rect.center.x, y: rect.center.y, z: rect.center.z },
            {
              x: rect.quaternion.x,
              y: rect.quaternion.y,
              z: rect.quaternion.z,
              w: rect.quaternion.w,
            }
        );
        const anchor = await (session as any).requestAnchor(xrTransform, refSpace);
        anchoredRef.current.push({ anchor, obj: box });
      } catch {
        // ok, resta senza anchor
      }
    }

    // pulisci trail dopo aver “stampato”
    three.trail.reset();
    setStatus("OK. Rettangolo creato. Puoi disegnare un altro (Undo per annullare).");
  }

  function updatePreviewFromStroke(points: THREE.Vector3[]) {
    const three = threeRef.current;
    if (!three) return;

    const rect = fitVerticalRectFromStroke(points);
    if (!rect) return;

    // (re)build preview: una cornice + un fill leggero
    three.preview.clear();
    const g = makePreviewRect(rect, { color: COLORS[colorKey] });
    three.preview.add(g);
    three.preview.visible = true;
  }

  function undoLast() {
    const three = threeRef.current;
    if (!three) return;

    const last = placedRef.current.pop();
    if (!last) {
      setStatus("Niente da annullare.");
      return;
    }

    // rimuovi anche eventuale anchor collegata
    const idx = anchoredRef.current.findIndex((a) => a.obj === last);
    if (idx >= 0) {
      const a = anchoredRef.current[idx];
      anchoredRef.current.splice(idx, 1);
      try {
        (a.anchor as any).delete?.();
      } catch {}
    }

    try {
      three.root.remove(last);
      disposeObject(last);
    } catch {}

    setStatus("Ultimo rettangolo rimosso.");
  }

  function clearAll() {
    const three = threeRef.current;
    if (!three) return;

    for (const a of anchoredRef.current) {
      try {
        (a.anchor as any).delete?.();
      } catch {}
      try {
        three.root.remove(a.obj);
        disposeObject(a.obj);
      } catch {}
    }
    anchoredRef.current = [];

    for (const obj of placedRef.current) {
      try {
        three.root.remove(obj);
        disposeObject(obj);
      } catch {}
    }
    placedRef.current = [];

    three.preview.clear();
    three.preview.visible = false;
    three.trail.reset();

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
        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[460px]">
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
          </div>
        </div>
      </div>
  );
}

/* ---------------- helpers ---------------- */

function makePreviewRect(
    rect: { corners: THREE.Vector3[] },
    opts: { color: number }
): THREE.Group {
  const g = new THREE.Group();

  const corners = rect.corners;

  // fill leggero
  const fillGeom = new THREE.BufferGeometry();
  const v = new Float32Array([
    corners[0].x,
    corners[0].y,
    corners[0].z,
    corners[1].x,
    corners[1].y,
    corners[1].z,
    corners[2].x,
    corners[2].y,
    corners[2].z,

    corners[2].x,
    corners[2].y,
    corners[2].z,
    corners[3].x,
    corners[3].y,
    corners[3].z,
    corners[0].x,
    corners[0].y,
    corners[0].z,
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

  const fill = new THREE.Mesh(fillGeom, fillMat);
  g.add(fill);

  // cornice
  const lineGeom = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
  const lineMat = new THREE.LineBasicMaterial({
    color: opts.color,
    transparent: true,
    opacity: 0.95,
  });
  const line = new THREE.Line(lineGeom, lineMat);
  g.add(line);

  return g;
}

function makeWindowBox(
    rect: {
      center: THREE.Vector3;
      width: number;
      height: number;
      quaternion: THREE.Quaternion;
    },
    opts: { thickness: number; color: number }
) {
  // box geometry centrata, poi applichiamo posizione + rotazione
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

  // outline
  const edges = new THREE.EdgesGeometry(geom);
  const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: opts.color, transparent: true, opacity: 0.95 })
  );
  mesh.add(line);

  return mesh;
}

function setPreviewColor(previewGroup: THREE.Group, color: number) {
  previewGroup.traverse((obj) => {
    const anyObj: any = obj;
    if (anyObj.material?.color) {
      anyObj.material.color.setHex(color);
      anyObj.material.needsUpdate = true;
    }
  });
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const anyO: any = o;
    if (anyO.geometry) anyO.geometry.dispose?.();
    if (anyO.material) {
      if (Array.isArray(anyO.material)) anyO.material.forEach((m: any) => m.dispose?.());
      else anyO.material.dispose?.();
    }
  });
}