import * as THREE from "three";

// ─────────────────────────── types ───────────────────────────────────────────

interface GoldenTrailOptions {
  /** Hex colour of the trail line (default: 0xffd700 — gold). */
  color?: number;
  /**
   * Squared distance threshold below which consecutive points are skipped.
   * Lower values produce a denser, "pencil-like" trail.
   * Default: 0.00005 (≈ 7 mm between points).
   */
  minDistanceSq?: number;
}

interface GoldenTrail {
  /** The Three.js object to add to a scene / group. */
  object:     THREE.Line;
  /** Append a world-space point to the trail. Ignores duplicates within minDistanceSq. */
  pushPoint:  (p: THREE.Vector3) => void;
  /** Clear all points and reset the geometry. */
  reset:      () => void;
  /** Change the trail colour at runtime. */
  setColor:   (hex: number) => void;
}

// ─────────────────────────── factory ─────────────────────────────────────────

/**
 * Creates a world-space line trail suitable for use as a drawing aid in AR.
 *
 * The trail is backed by a `THREE.BufferGeometry` that is rebuilt from scratch
 * on every `pushPoint` call.  This is perfectly adequate for short interactive
 * strokes (< a few thousand points) and avoids the complexity of managing
 * dynamic buffer sizes.
 *
 * @example
 * ```ts
 * const trail = makeGoldenTrail({ color: 0x00e5ff });
 * scene.add(trail.object);
 *
 * // inside an animation loop or pointer-move handler:
 * trail.pushPoint(worldPosition);
 *
 * // on gesture end:
 * trail.reset();
 * ```
 */
export function makeGoldenTrail(opts: GoldenTrailOptions = {}): GoldenTrail {
  const {
    color         = 0xffd700,
    minDistanceSq = 0.00005,
  } = opts;

  const points: THREE.Vector3[] = [];
  const geom = new THREE.BufferGeometry();
  const mat  = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
  });

  const line = new THREE.Line(geom, mat);

  // ── internal helpers ──────────────────────────────────────────────────────

  function rebuild(): void {
    geom.setFromPoints(points);
    geom.computeBoundingSphere?.();
  }

  // ── public API ────────────────────────────────────────────────────────────

  function pushPoint(p: THREE.Vector3): void {
    const last = points[points.length - 1];
    if (last && last.distanceToSquared(p) < minDistanceSq) return;
    points.push(p.clone());
    rebuild();
  }

  function reset(): void {
    points.length = 0;
    rebuild();
  }

  function setColor(hex: number): void {
    mat.color.setHex(hex);
    mat.needsUpdate = true;
  }

  return { object: line, pushPoint, reset, setColor };
}