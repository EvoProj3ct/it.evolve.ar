"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { makeGoldenTrail } from "@/server-utils/lib/fx/goldenTrail";
import { fitRectOnBestPlane } from "@/server-utils/lib/geometry/planeRect";

type Anchored = { anchor: XRAnchor; obj: THREE.Object3D };
type DrawState = { drawing: boolean; pointsWorld: THREE.Vector3[] };

export default function ARScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const threeRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    root: THREE.Group;
    trail: ReturnType<typeof makeGoldenTrail>;
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

  const drawRef = useRef<DrawState>({ drawing: false, pointsWorld: [] });

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
      // powerPreference può aiutare su mobile
      powerPreference: "high-performance",
    });

    renderer.xr.enabled = true;

    // ✅ IMPORTANTISSIMO: non coprire la camera passthrough
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);

    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    // ✅ IMPORTANTISSIMO: nessuno sfondo, altrimenti copre la camera
    scene.background = null;

    const camera = new THREE.PerspectiveCamera();

    const root = new THREE.Group();
    scene.add(root);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1));

    const trail = makeGoldenTrail();
    root.add(trail.object);

    threeRef.current = { scene, camera, root, trail };

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

  async function startAR() {
    if (isRunning) return;

    const xr = (navigator as any).xr as XRSystem | undefined;
    if (!xr) {
      setStatus("WebXR non disponibile");
      return;
    }

    // opzionale: log utile per capire se è davvero alpha-blend
    // console.log("is immersive-(ar) supported:", await xr.isSessionSupported?.("immersive-(ar)"));

    setStatus("Avvio sessione AR…");

    const session = await xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay", "local-floor"],
      domOverlay: { root: document.body },
    } as any);

    // 🔎 debug: se non è alpha-blend, la camera può non comparire come ti aspetti
    // console.log("environmentBlendMode:", session.environmentBlendMode);

    sessionRef.current = session;
    anchorsSupportedRef.current = typeof (session as any).requestAnchor === "function";

    const renderer = rendererRef.current!;
    // ribadisco trasparenza anche qui (alcuni device resettano clear state al setSession)
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
      setIsRunning(false);
      setStatus("Sessione AR terminata");
    });

    setIsRunning(true);
    setStatus("AR avviata. Tocca e trascina nel riquadro.");

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

        // disegno
        if (drawRef.current.drawing) {
          const pt = hitTestFromTouch(frame, refSpaceNow);
          if (pt) {
            drawRef.current.pointsWorld.push(pt);
            three.trail.pushPoint(pt);
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
    three.trail.reset();
  }

  async function onPointerUp() {
    if (!isRunning) return;

    const three = threeRef.current!;
    const pts = drawRef.current.pointsWorld;
    drawRef.current.drawing = false;

    if (pts.length < 12) {
      setStatus("Tratto troppo corto. Tieni premuto e traccia un perimetro più ampio.");
      return;
    }

    const rect = fitRectOnBestPlane(pts);
    if (!rect) {
      setStatus("Non riesco a stimare piano/rettangolo. Riprova.");
      return;
    }

    const mesh = makeRectMesh(rect.corners);
    three.root.add(mesh);

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
        anchoredRef.current.push({ anchor, obj: mesh });
      } catch {
        // fallback
      }
    }

    setStatus("Rettangolo fissato. Disegna di nuovo per crearne un altro.");
  }

  function makeRectMesh(corners: THREE.Vector3[]) {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array([
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
    geom.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geom, mat);

    const lineGeom = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
    const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0xffd700 }));
    mesh.add(line);

    return mesh;
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[420px]">
        <div className="pointer-events-none mb-2 text-sm text-white [text-shadow:_0_1px_2px_rgba(0,0,0,0.85)]">
          {status}
        </div>

        <div className="pointer-events-auto flex gap-2">
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
        </div>
      </div>
    </div>
  );
}