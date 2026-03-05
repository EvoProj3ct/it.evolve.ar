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
  let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity;

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

/**
 * ✅ Fit rettangolo "verticale" (dritto), pensato per finestre/aperture:
 * - up = (0,1,0)
 * - right stimato dal tratto (farthest pair sul piano XZ)
 * - forward = up x right
 * - bbox su (right, up) => rettangolo
 */
export function fitVerticalRectFromStroke(points: THREE.Vector3[]) {
  if (points.length < 8) return null;

  // centroid
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);

  const up = new THREE.Vector3(0, 1, 0);

  // stima asse orizzontale "right" dal farthest pair su XZ
  let bestI = 0;
  let bestJ = 1;
  let bestD = -1;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      const d = dx * dx + dz * dz; // distanza su XZ
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }

  const right = points[bestJ].clone().sub(points[bestI]);
  right.y = 0; // forza orizzontale
  if (right.lengthSq() < 1e-10) return null;
  right.normalize();

  const forward = new THREE.Vector3().crossVectors(up, right).normalize();
  if (forward.lengthSq() < 1e-10) return null;

  // proietta su right (orizzontale) e up (verticale)
  let minR = Infinity,
      maxR = -Infinity,
      minU = Infinity,
      maxU = -Infinity;

  for (const p of points) {
    const d = p.clone().sub(c);
    const pr = d.dot(right);
    const pu = d.dot(up);
    minR = Math.min(minR, pr);
    maxR = Math.max(maxR, pr);
    minU = Math.min(minU, pu);
    maxU = Math.max(maxU, pu);
  }

  const width = Math.max(0.0001, maxR - minR);
  const height = Math.max(0.0001, maxU - minU);

  // corners: A(bottom-left), B(bottom-right), C(top-right), D(top-left)
  const A = c.clone().add(right.clone().multiplyScalar(minR)).add(up.clone().multiplyScalar(minU));
  const B = c.clone().add(right.clone().multiplyScalar(maxR)).add(up.clone().multiplyScalar(minU));
  const Cc = c.clone().add(right.clone().multiplyScalar(maxR)).add(up.clone().multiplyScalar(maxU));
  const D = c.clone().add(right.clone().multiplyScalar(minR)).add(up.clone().multiplyScalar(maxU));

  // orientamento: x=right, y=up, z=forward
  const basis = new THREE.Matrix4().makeBasis(right, up, forward);
  const q = new THREE.Quaternion().setFromRotationMatrix(basis);

  // centro del rettangolo (meglio del centroid del tratto)
  const center = c
      .clone()
      .add(right.clone().multiplyScalar((minR + maxR) * 0.5))
      .add(up.clone().multiplyScalar((minU + maxU) * 0.5));

  return {
    corners: [A, B, Cc, D],
    center,
    quaternion: q,
    width,
    height,
    right,
    up,
    forward,
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