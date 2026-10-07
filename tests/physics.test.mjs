import test from 'node:test'
import assert from 'node:assert/strict'
import {
	FIXED_TIMESTEP,
	MAX_SUBSTEPS,
	isSettled,
	scaleVertices,
	reducedMass,
	collisionStrength,
	contactForceThreshold,
	accumulateSteps,
	extrapolatePose,
	normalizeQuaternion,
	bulletToRapierDamping,
} from '../src/components/physics.helpers.js'
import {createWorker, readFrame, loadColliders, FRAME} from './physics-harness.mjs'

// deterministic Math.random for the simulation tests
const seed = (value) => {
	let state = value >>> 0
	Math.random = () => {
		state = (state + 0x6D2B79F5) >>> 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
const random = Math.random
test.afterEach(() => { Math.random = random })

test('a die is settled when nearly still or out of time', () => {
	assert.equal(isSettled(.005, .001, 1000), true)
	assert.equal(isSettled(.02, .001, 1000), false)
	assert.equal(isSettled(.005, .01, 1000), false)
	assert.equal(isSettled(3, 4, -1), true)
})

test('hull points include model scaling and dice scale', () => {
	assert.deepEqual([...scaleVertices([1, 2, 3, -1, -2, -3], [1, -1, .5], 2)], [2, -4, 3, -2, 4, -3])
	assert.deepEqual([...scaleVertices([1, 2, 3], undefined, 5)], [5, 10, 15])
})

test('collision strength is the relative velocity change, never NaN', () => {
	const dt = FIXED_TIMESTEP
	// an impulse of 6 on a 0.5 kg die against a wall changes its velocity by 12 units/s -> full scale
	assert.ok(Math.abs(collisionStrength(6 / dt, dt, reducedMass(.5, Infinity)) - 1) < 1e-9)
	// two equal dice share the impulse: reduced mass halves
	assert.ok(Math.abs(reducedMass(.5, .5) - .25) < 1e-12)
	assert.equal(reducedMass(Infinity, Infinity), 0)
	for (const args of [[NaN, dt, 1], [10, dt, 0], [10, dt, Infinity], [Infinity, dt, 1], [10, 0, 1], [-5, dt, 1]]) {
		assert.equal(collisionStrength(...args), 0, `collisionStrength(${args})`)
	}
	// resting on the floor under gravity must stay below the event threshold
	const mass = .67
	const restingForce = mass * 9.81 * 4 / 3
	assert.ok(restingForce < contactForceThreshold(mass) / 5)
})

test('frame time becomes whole fixed steps, capped like Bullet', () => {
	let {steps, remainder} = accumulateSteps(0, 1 / 60)
	assert.equal(steps, 1)
	;({steps, remainder} = accumulateSteps(remainder, 1 / 60))
	assert.equal(steps, 2)
	assert.ok(remainder >= 0 && remainder < FIXED_TIMESTEP)
	;({steps, remainder} = accumulateSteps(0, 5))
	assert.equal(steps, MAX_SUBSTEPS)
	assert.ok(remainder < FIXED_TIMESTEP)
	assert.deepEqual(accumulateSteps(0, NaN), {steps: 0, remainder: 0})
	assert.equal(accumulateSteps(0, -1).steps, 0)
})

test('pose extrapolation follows the velocities', () => {
	const {translation, rotation} = extrapolatePose({x: 1, y: 2, z: 3}, {x: 0, y: 0, z: 0, w: 1}, {x: 1, y: 0, z: -2}, {x: 0, y: 0, z: 2}, .01)
	assert.deepEqual(Object.values(translation).map(v => +v.toFixed(6)), [1.01, 2, 2.98])
	// rotation of 0.02 rad about z: (0, 0, sin(.01), cos(.01))
	assert.ok(Math.abs(rotation.z - Math.sin(.01)) < 1e-6)
	assert.ok(Math.abs(rotation.w - Math.cos(.01)) < 1e-6)
	assert.deepEqual(normalizeQuaternion({x: 0, y: 0, z: 0, w: 0}), {x: 0, y: 0, z: 0, w: 1})
})

test('rolled dice tumble, collide with the box and come to rest on the floor', async () => {
	seed(7)
	const settleTimeout = 5000
	const box = await createWorker({options: {settleTimeout}})
	const sides = [4, 6, 8, 10, 12, 20, 100]
	const settledAt = new Map()
	const lastPose = new Map()
	for (let f = 0; f < 600 && settledAt.size < sides.length; f++) {
		if (f % 3 === 0 && f / 3 < sides.length) box.addDie(f / 3, sides[f / 3])
		const dice = readFrame(box.frame())
		for (const die of dice) {
			if (die.settled) { if (!settledAt.has(die.id)) settledAt.set(die.id, f); continue }
			assert.ok([...die.position, ...die.rotation].every(Number.isFinite))
			lastPose.set(die.id, die)
		}
	}
	assert.equal(settledAt.size, sides.length, 'every die reports the -1 settle flag')
	for (const [id, frame] of settledAt) {
		assert.ok(frame * FRAME < settleTimeout - 100, `die ${id} came to rest by itself (frame ${frame})`)
		const {position: [x, y, z], rotation} = lastPose.get(id)
		// floor top is y = .5 and the box spans |x| < 9.5 * aspect / 2, |z| < 9.5 / 2
		assert.ok(y > .45 && y < 2, `die ${id} rests on the floor (y=${y})`)
		assert.ok(Math.abs(x) < 9.5 * 4 / 3 / 2 && Math.abs(z) < 9.5 / 2, `die ${id} stays inside the box`)
		assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-3)
	}
	// the buffer count drops to zero once every die has been flagged
	assert.equal(box.frame()[0], 0)

	const collisions = box.collisions()
	assert.ok(collisions.some(c => [c.body0Id, c.body1Id].includes('box_bottom')), 'floor impacts are reported')
	for (const c of collisions) {
		assert.ok(Number.isFinite(c.force) && c.force > 0)
		assert.ok(c.body0Id !== undefined || c.body1Id !== undefined)
	}
	assert.ok(collisions.some(c => c.force < 1), 'collision strength is not always saturated')

	const before = collisions.length
	for (let f = 0; f < 120; f++) box.frame()
	assert.equal(box.collisions().length, before, 'dice at rest emit no collisions')
})

test('dice can be removed while rolling or after settling, and cleared without a buffer', async () => {
	seed(11)
	const box = await createWorker()
	box.addDie(1, 6)
	box.addDie(2, 20)
	box.frame()
	box.toWorker({action: 'removeDie', id: 1})
	let view = box.frame()
	assert.equal(view[0], 1)
	assert.equal(view[1], 2)
	box.send({action: 'clearDice'})
	box.toWorker({action: 'resumeSimulation'})
	assert.equal(box.frame()[0], 0)

	const empty = await createWorker({initBuffer: false})
	assert.doesNotThrow(() => empty.send({action: 'clearDice'}))
	assert.doesNotThrow(() => empty.toWorker({action: 'removeDie', id: 3}))
	assert.doesNotThrow(() => empty.addDie(4, 'd7'))
})

test('changing scale and gravity keeps existing and new dice simulating', async () => {
	seed(3)
	const box = await createWorker()
	box.addDie(1, 8)
	for (let f = 0; f < 5; f++) box.frame()
	box.send({action: 'updateConfig', options: {scale: 3, gravity: 2, mass: 1, size: 9.5, startingHeight: 8}})
	box.addDie(2, 12)
	let settled = 0
	for (let f = 0; f < 400 && settled < 2; f++) {
		settled += readFrame(box.frame()).filter(die => die.settled).length
	}
	assert.equal(settled, 2)
})

test('Bullet damping converts to the Rapier damping with the same decay', () => {
	for (const d of [.1, .4, .5, .9]) {
		const c = bulletToRapierDamping(d)
		// both keep the same fraction of velocity after one second
		assert.ok(Math.abs(Math.exp(-c) - (1 - d)) < 1e-12, `damping ${d}`)
	}
	assert.equal(bulletToRapierDamping(0), 0)
	assert.equal(bulletToRapierDamping(-1), 0)
	assert.equal(bulletToRapierDamping(NaN), 0)
	assert.ok(Number.isFinite(bulletToRapierDamping(1)) && bulletToRapierDamping(1) >= 100)
	assert.ok(Number.isFinite(bulletToRapierDamping(5)))
})

test('the collision event threshold stays above resting weight at any gravity', () => {
	const mass = .67
	for (const gravity of [9.81 * 4 / 3, 9.81 * 9.4, 9.81 * 30]) {
		assert.ok(contactForceThreshold(mass, gravity) >= 3 * mass * gravity, `gravity ${gravity}`)
	}
	// at normal gravity the velocity-change floor decides
	assert.equal(contactForceThreshold(mass, 9.81), contactForceThreshold(mass, 0))
})

// roll until every die reports the settle flag; returns the last unsettled pose per die
const rollToRest = (box, frames = 600) => {
	const poses = new Map()
	const settled = new Set()
	for (let f = 0; f < frames; f++) {
		for (const die of readFrame(box.frame())) {
			if (die.settled) settled.add(die.id)
			else poses.set(die.id, die)
		}
		if (settled.size && settled.size === poses.size) break
	}
	return {poses, settled}
}

test('a theme without a d100 collider rolls d100 with the d10 hull', async () => {
	seed(5)
	const models = loadColliders().filter(model => model.id !== 'd100_collider')
	const box = await createWorker({models})
	const errors = []
	const error = console.error
	console.error = (...args) => errors.push(args)
	try {
		box.addDie(1, 100)
		const {poses, settled} = rollToRest(box)
		assert.deepEqual([...settled], [1])
		assert.ok(poses.get(1).position[1] > .45)
	} finally {
		console.error = error
	}
	assert.deepEqual(errors, [])
})

test('the box is rebuilt on resize and on config changes', async () => {
	seed(9)
	const box = await createWorker({width: 800, height: 600})
	// a narrow (portrait) canvas: walls at |x| = 9.5 * .5 / 2
	box.send({action: 'resize', width: 300, height: 600})
	for (let i = 0; i < 5; i++) box.addDie(i, 6, {newStartPoint: i === 0})
	let {poses, settled} = rollToRest(box)
	assert.equal(settled.size, 5)
	for (const {position: [x, y, z]} of poses.values()) {
		assert.ok(Math.abs(x) < 9.5 * .5 / 2, `x=${x} inside the narrow box`)
		assert.ok(Math.abs(z) < 9.5 / 2 && y > .45)
	}

	// a smaller tray from updateConfig: walls at |z| = 6 / 2
	box.send({action: 'clearDice'})
	box.send({action: 'updateConfig', options: {size: 6, scale: 5}})
	box.toWorker({action: 'resumeSimulation'})
	for (let i = 0; i < 5; i++) box.addDie(10 + i, 8, {newStartPoint: i === 0})
	;({poses, settled} = rollToRest(box))
	assert.equal(settled.size, 5)
	for (const {position: [x, , z]} of poses.values()) {
		assert.ok(Math.abs(x) < 6 * .5 / 2 && Math.abs(z) < 6 / 2, `(${x}, ${z}) inside the smaller box`)
	}
})

test('a scale change resizes the colliders of dice already in the world', async () => {
	const restingHeight = async (rescale) => {
		seed(21)
		const box = await createWorker()
		box.addDie(1, 6)
		for (let f = 0; f < 3; f++) box.frame()
		if (rescale) box.send({action: 'updateConfig', options: {scale: 10}})
		const {poses, settled} = rollToRest(box)
		assert.deepEqual([...settled], [1])
		return poses.get(1).position[1]
	}
	// d6 hull half size is .078 * scale; the floor top is y = .5
	const small = await restingHeight(false)
	const large = await restingHeight(true)
	assert.ok(Math.abs(small - (.5 + .078 * 5)) < .05, `scale 5 rests at ${small}`)
	assert.ok(Math.abs(large - (.5 + .078 * 10)) < .08, `scale 10 rests at ${large}`)
})
