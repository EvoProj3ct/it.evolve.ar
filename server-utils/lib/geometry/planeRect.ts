import * as THREE from "three";

/**
 * Fit pratico:
 * - stima assi del piano dai punti (farthest pair + farthest from that axis)
 * - proietta punti sul piano (u,v)
 * - bounding box in (u,v) -> rettangolo
 */
export function fitRectOnBestPlane(points: THREE.Vector3[]) {
  if (points.length < 8) return null;

  // centroid
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);

  const { dir1, dir2 } = estimatePlaneAxes(points, c);
  if (!dir1 || !dir2) return null;

  const u = dir1.clone().normalize();
  // orthogonalize dir2 vs u
  const v = dir2
    .clone()
    .sub(u.clone().multiplyScalar(dir2.dot(u)))
    .normalize();

  if (v.lengthSq() < 1e-10) return null;

  const n = new THREE.Vector3().crossVectors(u, v).normalize();
  if (n.lengthSq() < 1e-10) return null;

  // project points into (u,v)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

  for (const p of points) {
    const d = p.clone().sub(c);
    const pu = d.dot(u);
    const pv = d.dot(v);
    minU = Math.min(minU, pu);
    maxU = Math.max(maxU, pu);
    minV = Math.min(minV, pv);
    maxV = Math.max(maxV, pv);
  }

  // corners back to 3D
  const A = c.clone().add(u.clone().multiplyScalar(minU)).add(v.clone().multiplyScalar(minV));
  const B = c.clone().add(u.clone().multiplyScalar(maxU)).add(v.clone().multiplyScalar(minV));
  const C = c.clone().add(u.clone().multiplyScalar(maxU)).add(v.clone().multiplyScalar(maxV));
  const D = c.clone().add(u.clone().multiplyScalar(minU)).add(v.clone().multiplyScalar(maxV));

  // plane orientation quaternion (basis u,v,n)
  const basis = new THREE.Matrix4().makeBasis(u, v, n);
  const q = new THREE.Quaternion().setFromRotationMatrix(basis);

  return {
    corners: [A, B, C, D],
    center: c,
    quaternion: q,
    normal: n,
    u,
    v,
  };
}

function estimatePlaneAxes(points: THREE.Vector3[], c: THREE.Vector3) {
  // farthest pair O(n^2) (ok per MVP)
  let bestI = 0;
  let bestJ = 1;
  let bestD = -1;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = points[i].distanceToSquared(points[j]);
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }

  const dir1 = points[bestJ].clone().sub(points[bestI]);
  if (dir1.lengthSq() < 1e-10) return { dir1: null as any, dir2: null as any };

  // farthest from axis through centroid along dir1
  const u = dir1.clone().normalize();
  let bestK = -1;
  let bestDist = -1;

  for (let k = 0; k < points.length; k++) {
    const d = points[k].clone().sub(c);
    const proj = u.clone().multiplyScalar(d.dot(u));
    const perp = d.sub(proj);
    const dist = perp.lengthSq();
    if (dist > bestDist) {
      bestDist = dist;
      bestK = k;
    }
  }

  if (bestK < 0 || bestDist < 1e-10) return { dir1, dir2: null as any };

  const dir2 = points[bestK].clone().sub(c);
  return { dir1, dir2 };
}