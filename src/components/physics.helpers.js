// Pure helpers used by physics.worker.js. They hold no engine state and do not touch Rapier,
// so they can be unit tested without a worker or WASM.

export const defaultOptions = {
	size: 9.5,
	startingHeight: 8,
	spinForce: 6,
	throwForce: 5,
	gravity: 1,
	mass: 1,
	friction: .8,
	restitution: .1,
	linearDamping: .5,
	angularDamping: .4,
	settleTimeout: 5000,
	// TODO: toss: "center", "edge", "allEdges"
}

// Fixed simulation step and catch-up limit (same values the Bullet world used: stepSimulation(dt, 2, 1/90)).
export const FIXED_TIMESTEP = 1 / 90
export const MAX_SUBSTEPS = 2

// Bullet limits per-step rotation to a quarter turn (BT_ANGULAR_MOTION_THRESHOLD). Rapier has no such
// limit and computes exact (smaller) hull inertia, so the same spin impulse would spin dice much faster.
export const MAX_ANGULAR_SPEED = (Math.PI / 4) / FIXED_TIMESTEP

// Contact force events are converted to the relative velocity change they caused (units/s).
// A change of COLLISION_FULL_SCALE maps to force 1 (full volume downstream); the event threshold
// sits far above the per-step change caused by resting on a surface (g * dt ~ 0.15 at default gravity).
export const COLLISION_FULL_SCALE = 12
export const COLLISION_MIN_VELOCITY_CHANGE = 1

export const SETTLE_LINEAR_SPEED = .01
export const SETTLE_ANGULAR_SPEED = .005

export const computeGravity = (gravity = defaultOptions.gravity, mass = defaultOptions.mass) => {
	// make gravity a little bit stronger for heavy objects, so they seem heavier
	return gravity === 0 ? 0 : gravity + mass / 3
}

export const computeMass = (mass = defaultOptions.mass) => {
	// high values in mass are pretty ineffective, but whole intigers make better config values, so we shave down the value
	// also prevents mass from ever being zero
	return 1 + mass / 3
}

export const computeSpin = (spin = defaultOptions.spinForce, spinScale = 40) => {
	// scale down the actual spin value from a nice intiger in config to a fractional value
	return spin / spinScale
}

export const computeThrowForce = (throwForce = defaultOptions.throwForce, mass = defaultOptions.mass, scale = defaultOptions.scale) => {
	return throwForce / 2 / mass * (1 + scale / 6)
}

export const computeStartingHeight = (height = defaultOptions.startingHeight) => {
	// ensure minimum startingHeight of 1
	return height < 1 ? 1 : height
}

export const vectorLength = ({x, y, z}) => Math.sqrt(x * x + y * y + z * z)

export const isSettled = (linearSpeed, angularSpeed, timeout) =>
	(linearSpeed < SETTLE_LINEAR_SPEED && angularSpeed < SETTLE_ANGULAR_SPEED) || timeout < 0

// Bake the model scaling and the global dice scale into the hull points.
export const scaleVertices = (positions, scaling = [1, 1, 1], scale = 1) => {
	const vertices = new Float32Array(positions.length)
	for (let i = 0; i < positions.length; i++) {
		vertices[i] = positions[i] * (scaling[i % 3] ?? 1) * scale
	}
	return vertices
}

// Half extents of the axis aligned bounds of a flat xyz array (fallback shape for degenerate hulls).
export const halfExtents = (vertices) => {
	const extents = [0, 0, 0]
	for (let i = 0; i < vertices.length; i++) {
		extents[i % 3] = Math.max(extents[i % 3], Math.abs(vertices[i]))
	}
	return extents.map(value => Math.max(value, 1e-3))
}

export const normalizeQuaternion = ({x, y, z, w}) => {
	const length = Math.sqrt(x * x + y * y + z * z + w * w)
	if (!(length > 0) || !Number.isFinite(length)) return {x: 0, y: 0, z: 0, w: 1}
	return {x: x / length, y: y / length, z: z / length, w: w / length}
}

// Effective mass of a contact pair. Non-dynamic bodies (walls, settled dice) have infinite mass.
export const reducedMass = (massA = Infinity, massB = Infinity) => {
	const inverse = (massA > 0 ? 1 / massA : 0) + (massB > 0 ? 1 / massB : 0)
	return inverse > 0 ? 1 / inverse : 0
}

// Resting/rolling contact carries about m * g; events must stay well above it at any gravity setting.
export const RESTING_FORCE_MARGIN = 4

// Contact force magnitude (N) that emits a collision event: a relative velocity change of
// `velocityChange` within one step, but never less than RESTING_FORCE_MARGIN times the die's weight.
export const contactForceThreshold = (mass, gravity = 9.81, dt = FIXED_TIMESTEP, velocityChange = COLLISION_MIN_VELOCITY_CHANGE) =>
	mass * Math.max(velocityChange / dt, RESTING_FORCE_MARGIN * Math.abs(gravity))

// Bullet damping d keeps (1 - d)^t of the velocity after t seconds; Rapier damping c keeps
// about e^(-c t). Equal decay needs c = -ln(1 - d). d >= 1 (Bullet: stop at once) maps to a very large c.
export const MAX_RAPIER_DAMPING = 1000
export const bulletToRapierDamping = (damping) => {
	if (!Number.isFinite(damping) || damping <= 0) return 0
	if (damping >= 1) return MAX_RAPIER_DAMPING
	return Math.min(MAX_RAPIER_DAMPING, -Math.log(1 - damping))
}

// Map a contact force event to the dimensionless collision strength posted to the host:
// impulse = force * dt; relative velocity change = impulse / reduced mass; divided by the full scale.
export const collisionStrength = (totalForceMagnitude, dt, pairMass, fullScale = COLLISION_FULL_SCALE) => {
	if (!(pairMass > 0) || !Number.isFinite(pairMass) || !Number.isFinite(totalForceMagnitude) || !(dt > 0)) return 0
	const strength = (totalForceMagnitude * dt) / pairMass / fullScale
	return Number.isFinite(strength) && strength > 0 ? strength : 0
}

// Accumulate frame time into whole fixed steps; like Bullet, steps beyond `maxSteps` are dropped.
export const accumulateSteps = (accumulator, deltaSeconds, dt = FIXED_TIMESTEP, maxSteps = MAX_SUBSTEPS) => {
	const safeDelta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
	let remainder = accumulator + safeDelta
	// tiny epsilon so exact multiples of dt are not lost to floating point rounding
	const available = Math.floor(remainder / dt + 1e-9)
	remainder = Math.max(0, remainder - available * dt)
	return {steps: Math.min(available, maxSteps), remainder}
}

// Scale a vector down so its length does not exceed `max`.
export const clampLength = (vector, max) => {
	const length = vectorLength(vector)
	if (!(length > max)) return vector
	const factor = max / length
	return {x: vector.x * factor, y: vector.y * factor, z: vector.z * factor}
}

// Extrapolate a pose forward by `dt` seconds from its velocities, like Bullet's motion state
// interpolation, so a 60 Hz display does not judder between 1 and 2 physics steps per frame.
export const extrapolatePose = (translation, rotation, linvel, angvel, dt) => {
	if (!(dt > 0)) return {translation, rotation}
	const {x: wx, y: wy, z: wz} = angvel
	const {x: qx, y: qy, z: qz, w: qw} = rotation
	const half = dt / 2
	return {
		translation: {
			x: translation.x + linvel.x * dt,
			y: translation.y + linvel.y * dt,
			z: translation.z + linvel.z * dt,
		},
		// q' = q + dt/2 * (w, 0) * q
		rotation: normalizeQuaternion({
			x: qx + half * (wx * qw + wy * qz - wz * qy),
			y: qy + half * (wy * qw + wz * qx - wx * qz),
			z: qz + half * (wz * qw + wx * qy - wy * qx),
			w: qw - half * (wx * qx + wy * qy + wz * qz),
		}),
	}
}
