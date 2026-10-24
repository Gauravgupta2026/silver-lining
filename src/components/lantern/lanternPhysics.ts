/**
 * Light physics for the lantern, on the CPU. The shader traces camera rays through the glass; this
 * file traces the sun's rays out of it, to find where they land on the wall.
 *
 * Model. The glass is two nested vertical tubes, and every flute runs straight up them. A ray that
 * travels in the horizontal plane stays in that plane when it bends, so the optics is a 2D problem
 * in (x, z) and height y only scales the result. Both the shader and this file use these steps:
 *
 *  - OUTER shell, radius 1: fluted outer face, smooth inner face.
 *  - ROD layer (optional), radius ROD_OUTER_RADIUS: fluted outer face, smooth inner face. It turns
 *    against the outer shell, and the two ribbed layers beat against each other (moire).
 *  - Each face refracts with Snell's law. Unpolarised Fresnel sets how much light gets through.
 *  - Red, green and blue use slightly different indices, which gives the colour fringes.
 *
 * A flute is a circular arc, so its normal turns linearly across its width, from -depth to +depth.
 * Azimuth theta = atan2(x, z) is 0 toward the camera. A layer turned by phi puts its material
 * angle theta - phi under the point at azimuth theta. The rods are slightly wavy along y in the
 * shader; here the sun's height row (y = 0) is used, where the wave is zero.
 */

export const GLASS_RADIUS = 1;
/** The rod layer's fluted face sits at this radius. */
export const ROD_OUTER_RADIUS = 0.8;
/** Rod wall thickness, as a share of the outer shell's thickness. */
export const ROD_THICKNESS_SHARE = 0.8;
const TAU = Math.PI * 2;

/** Rays per sweep, over the arc that can reach the wall. */
const RAYS_PER_SWEEP = 700;
/** Extra angle beyond the half circle behind the sun, because flutes bend rays sideways. */
const SWEEP_MARGIN = 0.6;
/**
 * The sun is a disc, so light comes from several points. Each offset is a share of the emitter
 * radius, so the shadow edges of the flutes soften instead of ghosting.
 */
const SOURCE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0.8],
  [0.69, -0.4],
  [-0.69, -0.4],
];
/** Rays whose landing points are closer than this many bins are drawn as one point. */
const MIN_FOOTPRINT_BINS = 1.5;
/** Landing points further apart than this (world units) are a break in the ray bundle. */
const MAX_SPAN = 0.6;

/** Radii of the glass faces, outer to inner. */
export interface Shells {
  /** Inner (smooth) face of the outer shell. */
  outerInner: number;
  rodOuter: number;
  rodInner: number;
  rods: boolean;
  /** Radius of the clear space the sun lives in. */
  clear: number;
}

export function shellRadii(thickness: number, rods: boolean): Shells {
  const outerInner = GLASS_RADIUS - thickness;
  const rodInner = ROD_OUTER_RADIUS - thickness * ROD_THICKNESS_SHARE;
  return { outerInner, rodOuter: ROD_OUTER_RADIUS, rodInner, rods, clear: rods ? rodInner : outerInner };
}

export interface CausticParams {
  /** Outer shell turn, radians. */
  phi: number;
  /** Rod layer turn, radians. */
  rodPhi: number;
  /** Sun position in the horizontal plane. */
  sunX: number;
  sunZ: number;
  /** Radius of the area the light comes from. */
  emitterRadius: number;
  flutes: number;
  rodFlutes: number;
  /** Steepest flute slope, radians. */
  depth: number;
  rodDepth: number;
  /** Refractive index for red, green and blue. */
  ior: readonly [number, number, number];
  shells: Shells;
  /** Distance from the axis to the wall, positive. The wall plane is z = -wallDistance. */
  wallDistance: number;
  /** The texture covers wall x from -halfRange to +halfRange. */
  halfRange: number;
}

/** Unpolarised reflectance. cosI is the angle in medium 1; eta = n1 / n2. 1 means total reflection. */
export function fresnel(cosI: number, eta: number): number {
  const sin2t = eta * eta * (1 - cosI * cosI);
  if (sin2t >= 1) return 1;
  const cosT = Math.sqrt(1 - sin2t);
  const rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  const rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

/** Snell refraction in 2D. n faces against the ray. Returns null on total internal reflection. */
export function refract2(dx: number, dz: number, nx: number, nz: number, eta: number): [number, number] | null {
  const cosI = -(dx * nx + dz * nz);
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return null;
  const f = eta * cosI - Math.sqrt(k);
  return [eta * dx + f * nx, eta * dz + f * nz];
}

/** Outward normal of a fluted face at azimuth theta, for a layer turned by phi. */
export function fluteNormal(theta: number, phi: number, flutes: number, depth: number): [number, number] {
  const u = ((theta - phi) * flutes) / TAU;
  const s = 2 * (u - Math.floor(u)) - 1;
  const a = depth * s;
  const sx = Math.sin(theta);
  const sz = Math.cos(theta);
  // Radial direction is (sin, cos). The tangent toward growing theta is (cos, -sin).
  return [sx * Math.cos(a) + sz * Math.sin(a), sz * Math.cos(a) - sx * Math.sin(a)];
}

/** Which surface a hop lands on: the outer shell's flutes, the rods' flutes, or a smooth face. */
type Face = "outer" | "rods" | "smooth";

interface Ray {
  px: number;
  pz: number;
  dx: number;
  dz: number;
  /** Share of the light that survives so far. */
  through: number;
  /** Distance travelled in air and in glass. */
  air: number;
  glass: number;
}

/**
 * Moves a ray to the next circle and refracts it there. `far` takes the far side of the circle (a
 * ray leaving the inside). `eta` is n1 / n2. Returns false if the ray is lost.
 */
function hop(r: Ray, radius: number, far: boolean, face: Face, eta: number, fromGlass: boolean, p: CausticParams): boolean {
  const b = r.px * r.dx + r.pz * r.dz;
  const disc = b * b - (r.px * r.px + r.pz * r.pz - radius * radius);
  if (disc < 0) return false;
  const root = Math.sqrt(disc);
  const t = far ? -b + root : -b - root;
  if (t < 0) return false;
  r.px += r.dx * t;
  r.pz += r.dz * t;
  if (fromGlass) r.glass += t;
  else r.air += t;

  let nx: number;
  let nz: number;
  if (face === "smooth") {
    nx = r.px / radius;
    nz = r.pz / radius;
  } else {
    const theta = Math.atan2(r.px, r.pz);
    [nx, nz] = face === "outer" ? fluteNormal(theta, p.phi, p.flutes, p.depth) : fluteNormal(theta, p.rodPhi, p.rodFlutes, p.rodDepth);
  }
  // The normal that faces against the ray.
  if (r.dx * nx + r.dz * nz > 0) {
    nx = -nx;
    nz = -nz;
  }
  r.through *= 1 - fresnel(-(r.dx * nx + r.dz * nz), eta);
  const d = refract2(r.dx, r.dz, nx, nz, eta);
  if (!d) return false;
  [r.dx, r.dz] = d;
  return true;
}

interface Landing {
  x: number;
  /** Share of the light that survives the faces and spreads over height. */
  weight: number;
}

/** Follows one ray from inside the lantern to the wall. Null if it never arrives. */
function traceToWall(sx: number, sz: number, angle: number, ng: number, p: CausticParams): Landing | null {
  const { shells } = p;
  const r: Ray = { px: sx, pz: sz, dx: Math.sin(angle), dz: Math.cos(angle), through: 1, air: 0, glass: 0 };
  if (shells.rods) {
    if (!hop(r, shells.rodInner, true, "smooth", 1 / ng, false, p)) return null;
    if (!hop(r, shells.rodOuter, true, "rods", ng, true, p)) return null;
  }
  if (!hop(r, shells.outerInner, true, "smooth", 1 / ng, false, p)) return null;
  if (!hop(r, GLASS_RADIUS, true, "outer", ng, true, p)) return null;

  if (r.dz > -0.02) return null;
  const toWall = (-p.wallDistance - r.pz) / r.dz;
  const x = r.px + r.dx * toWall;
  if (Math.abs(x) > p.halfRange) return null;
  const total = r.air + r.glass + toWall;
  // Light also spreads up and down, so what lands on a unit of wall falls off with the distance.
  return { x, weight: r.through / total };
}

/**
 * Light per unit of wall width, for red, green and blue, as a halfRange * 2 wide strip.
 * `out` holds bins * 4 floats. Rays are followed as ordered bundles: two neighbouring rays
 * spread their light evenly between the points where they land. That draws bright lines
 * (caustics) exactly where the glass focuses light, with no noise. Where two neighbours left
 * through different flutes, the gap is the rounded valley between flutes, which scatters light
 * across it, so the same rule applies.
 */
export function computeCaustic(out: Float32Array, bins: number, p: CausticParams): void {
  out.fill(0);
  const binWorld = (2 * p.halfRange) / bins;
  const start = Math.PI / 2 - SWEEP_MARGIN;
  const span = Math.PI + 2 * SWEEP_MARGIN;
  const step = span / RAYS_PER_SWEEP;
  const share = step / SOURCE_OFFSETS.length;

  const deposit = (channel: number, x0: number, x1: number, energy: number) => {
    let a = (Math.min(x0, x1) + p.halfRange) / binWorld;
    let z = (Math.max(x0, x1) + p.halfRange) / binWorld;
    if (z - a < MIN_FOOTPRINT_BINS) {
      const mid = 0.5 * (a + z);
      a = mid - MIN_FOOTPRINT_BINS / 2;
      z = mid + MIN_FOOTPRINT_BINS / 2;
    }
    const width = z - a;
    const first = Math.max(0, Math.floor(a));
    const last = Math.min(bins - 1, Math.floor(z));
    for (let i = first; i <= last; i++) {
      const overlap = Math.min(z, i + 1) - Math.max(a, i);
      if (overlap > 0) out[i * 4 + channel] += (energy * overlap) / (width * binWorld);
    }
  };

  for (const [ox, oz] of SOURCE_OFFSETS) {
    const sx = p.sunX + ox * p.emitterRadius;
    const sz = p.sunZ + oz * p.emitterRadius;
    for (let channel = 0; channel < 3; channel++) {
      let prev: Landing | null = null;
      for (let k = 0; k <= RAYS_PER_SWEEP; k++) {
        const hit = traceToWall(sx, sz, start + k * step, p.ior[channel], p);
        if (hit && prev && Math.abs(hit.x - prev.x) < MAX_SPAN) {
          deposit(channel, prev.x, hit.x, 0.5 * (hit.weight + prev.weight) * share);
        } else if (hit) {
          deposit(channel, hit.x, hit.x, hit.weight * share * 0.5);
        }
        prev = hit;
      }
    }
  }

  // One light [1 2 1] blur takes the last bit of stair-stepping out of the bins.
  const before = [out[0], out[1], out[2]];
  for (let i = 0; i < bins; i++) {
    const next = i + 1 < bins ? i + 1 : i;
    for (let ch = 0; ch < 3; ch++) {
      const here = out[i * 4 + ch];
      out[i * 4 + ch] = 0.25 * before[ch] + 0.5 * here + 0.25 * out[next * 4 + ch];
      before[ch] = here;
    }
    out[i * 4 + 3] = 1;
  }
}
