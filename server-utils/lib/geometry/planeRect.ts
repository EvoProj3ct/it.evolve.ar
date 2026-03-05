/**
 * planeRect — utilities for fitting rectangles onto point clouds.
 *
 * NOTE: These functions are no longer used by ARScene, which switched to the
 * simpler and more reliable 2-D bbox → unproject approach.  They are kept
 * here in case you need free-form plane fitting elsewhere (e.g. for floor /
 * ceiling detection or non-AR geometry fitting).
 */

import * as THREE from "three";

// ─────────────────────────── types ───────────────────────────────────────────

export interface FittedRect {
  /** Rectangle corner points in world space: [bottom-left, bottom-right, top-right, top-left]. */
  corners:    [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** World-space centroid of the rectangle. */
  center:     THREE.Vector3;
  /** Rotation quaternion aligning local X→right, Y→up, Z→normal. */
  quaternion: THREE.Quaternion;
  /** Plane normal (unit length). */
  normal:     THREE.Vector3;
  /** Local horizontal axis (unit length). */
  u:          THREE.Vector3;
  /** Local vertical axis (unit length). */
  v:          THREE.Vector3;
}

export interface VerticalRect extends FittedRect {
  /** Width along the local horizontal axis (metres). */
  width:   number;
  /** Height along the world-up axis (metres). */
  height:  number;
  /** Local horizontal axis (same as `u`, kept for clarity). */
  right:   THREE.Vector3;
  /** Forward direction perpendicular to the wall face. */
  forward: THREE.Vector3;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

/**
 * Finds the pair of points in `pts` with the greatest squared distance.
 * O(n²) — acceptable for interactive strokes of up to a few hundred points.
 */
function farthestPair(pts: THREE.Vector3[]): [number, number] {
  let bestI = 0, bestJ = 1, bestDsq = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = pts[i].distanceToSquared(pts[j]);
      if (d > bestDsq) { bestDsq = d; bestI = i; bestJ = j; }
    }
  }
  return [bestI, bestJ];
}

/**
 * Given a principal axis `u` and a centroid `c`, returns the index of the
 * point farthest from the line through `c` along `u`.
 */
function farthestFromAxis(
    pts: THREE.Vector3[],
    c:   THREE.Vector3,
    u:   THREE.Vector3,
): number {
  let bestK = 0, bestDsq = -1;
  for (let k = 0; k < pts.length; k++) {
    const d    = pts[k].clone().sub(c);
    const proj = u.clone().multiplyScalar(d.dot(u));
    const perp = d.sub(proj).lengthSq();
    if (perp > bestDsq) { bestDsq = perp; bestK = k; }
  }
  return bestK;
}

// ─────────────────────────── public API ──────────────────────────────────────

/**
 * Fits a rectangle onto an arbitrary plane estimated from a point cloud.
 *
 * The plane axes are determined by:
 *  1. `dir1` — direction between the farthest pair of points.
 *  2. `dir2` — direction from the centroid to the point farthest from `dir1`.
 *
 * Returns `null` when the point cloud is degenerate (< 8 points, collinear,
 * or coplanar with ambiguous orientation).
 */
export function fitRectOnBestPlane(points: THREE.Vector3[]): FittedRect | null {
  if (points.length < 8) return null;

  // Centroid
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);

  // Principal axis from farthest pair
  const [i0, i1] = farthestPair(points);
  const dir1 = points[i1].clone().sub(points[i0]);
  if (dir1.lengthSq() < 1e-10) return null;

  const u  = dir1.normalize().clone();
  const k  = farthestFromAxis(points, c, u);
  const dir2 = points[k].clone().sub(c);

  // Orthogonalize
  const v = dir2.clone().sub(u.clone().multiplyScalar(dir2.dot(u))).normalize();
  if (v.lengthSq() < 1e-10) return null;

  const normal = new THREE.Vector3().crossVectors(u, v).normalize();
  if (normal.lengthSq() < 1e-10) return null;

  // Project points into (u, v)
  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const d  = p.clone().sub(c);
    const pu = d.dot(u);
    const pv = d.dot(v);
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }

  const A = c.clone().addScaledVector(u, minU).addScaledVector(v, minV);
  const B = c.clone().addScaledVector(u, maxU).addScaledVector(v, minV);
  const C = c.clone().addScaledVector(u, maxU).addScaledVector(v, maxV);
  const D = c.clone().addScaledVector(u, minU).addScaledVector(v, maxV);

  return {
    corners:    [A, B, C, D],
    center:     c,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, normal)),
    normal,
    u,
    v,
  };
}

/**
 * Fits a **vertical** rectangle from a stroke point cloud.
 *
 * Orientation:
 *   right   — estimated from the farthest pair projected onto the XZ-plane
 *   up      — world up (0, 1, 0), strictly enforced
 *   forward — right × up (points away from the wall face)
 *
 * This is specialised for window / door / frame placement on vertical surfaces.
 * Returns `null` when the point cloud is degenerate (< 8 points or
 * insufficient horizontal spread).
 */
export function fitVerticalRectFromStroke(points: THREE.Vector3[]): VerticalRect | null {
  if (points.length < 8) return null;

  // Centroid
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);

  const worldUp = new THREE.Vector3(0, 1, 0);

  // Horizontal axis from the farthest pair on the XZ plane
  let bestI = 0, bestJ = 1, bestDxz = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dz = points[i].z - points[j].z;
      const d  = dx * dx + dz * dz;
      if (d > bestDxz) { bestDxz = d; bestI = i; bestJ = j; }
    }
  }

  const right = points[bestJ].clone().sub(points[bestI]);
  right.y = 0; // force horizontal
  if (right.lengthSq() < 1e-10) return null;
  right.normalize();

  const forward = new THREE.Vector3().crossVectors(worldUp, right).normalize();
  if (forward.lengthSq() < 1e-10) return null;

  // Project onto (right, worldUp)
  let minR = Infinity, maxR = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const d  = p.clone().sub(c);
    const pr = d.dot(right);
    const py = d.dot(worldUp);
    if (pr < minR) minR = pr; if (pr > maxR) maxR = pr;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }

  const width  = Math.max(0.0001, maxR - minR);
  const height = Math.max(0.0001, maxY - minY);

  // Geometric centre (more accurate than the point-cloud centroid)
  const center = c.clone()
      .addScaledVector(right,   (minR + maxR) * 0.5)
      .addScaledVector(worldUp, (minY + maxY) * 0.5);

  const A = c.clone().addScaledVector(right, minR).addScaledVector(worldUp, minY);
  const B = c.clone().addScaledVector(right, maxR).addScaledVector(worldUp, minY);
  const C = c.clone().addScaledVector(right, maxR).addScaledVector(worldUp, maxY);
  const D = c.clone().addScaledVector(right, minR).addScaledVector(worldUp, maxY);

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, worldUp, forward),
  );

  return {
    corners: [A, B, C, D],
    center,
    quaternion,
    normal:  forward,
    u:       right,
    v:       worldUp,
    width,
    height,
    right,
    forward,
  };
}