import * as THREE from "three";

export function makeGoldenTrail(opts?: { color?: number }) {
  const points: THREE.Vector3[] = [];
  const geom = new THREE.BufferGeometry();

  const mat = new THREE.LineBasicMaterial({
    color: opts?.color ?? 0xffd700,
    transparent: true,
    opacity: 0.95,
  });

  const line = new THREE.Line(geom, mat);

  function rebuild() {
    geom.setFromPoints(points);
    geom.computeBoundingSphere?.();
  }

  return {
    object: line,
    reset() {
      points.length = 0;
      rebuild();
    },
    pushPoint(p: THREE.Vector3) {
      const last = points[points.length - 1];
      // più fitto = più “matita”
      if (last && last.distanceToSquared(p) < 0.00005) return;
      points.push(p.clone());
      rebuild();
    },
    setColor(hex: number) {
      mat.color.setHex(hex);
      mat.needsUpdate = true;
    },
  };
}