import RAPIER from '@dimforge/rapier3d-compat'
import { lerp } from '../helpers/index.js'
import {
	defaultOptions,
	FIXED_TIMESTEP,
	MAX_ANGULAR_SPEED,
	computeGravity,
	computeMass,
	computeSpin,
	computeThrowForce,
	computeStartingHeight,
	vectorLength,
	isSettled,
	scaleVertices,
	halfExtents,
	normalizeQuaternion,
	reducedMass,
	contactForceThreshold,
	collisionStrength,
	accumulateSteps,
	clampLength,
	extrapolatePose,
	bulletToRapierDamping,
} from './physics.helpers.js'

// Firefox limitation: https://github.com/vitejs/vite/issues/4586

// Dice are plain records: {id, body, collider, timeout, mass, colliderKey}. Nothing is stored on Rapier objects.
let bodies = []
let sleepingBodies = []
// collider model cache: { [meshName_modelName]: { model, vertices } } where vertices are already scaled
let colliders = {}
// collider handle -> { id, die? } used to translate contact events back to dice / box part ids
const colliderOwners = new Map()
let world
let eventQueue
let rapierReady
let worldWorkerPort
let width = 150
let height = 150
let aspect = 1
let stopLoop = false
let accumulator = 0

const ZERO = {x: 0, y: 0, z: 0}

let config = {...defaultOptions}

let diceBufferView

self.onmessage = (e) => {
  switch (e.data.action) {
    case "rollDie":
      rollDie(e.data.sides)
      break;
    case "init":
      init(e.data).then(()=>{
        self.postMessage({
          action:"init-complete"
        })
      })
      break
    case "clearDice":
			clearDice()
      break
		case "removeDie":
			removeDie(e.data.id)
			break;
		case "resize":
			width = e.data.width
			height = e.data.height
			aspect = width / height
			addBoxToWorld(config.size, config.startingHeight + 10)
			break
		case "updateConfig":
			updateConfig(e.data.options)
			break
    case "connect":
      worldWorkerPort = e.ports[0]
      worldWorkerPort.onmessage = (e) => {
        switch (e.data.action) {
					case "initBuffer":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						diceBufferView[0] = -1
						break;
					case "loadModels":
						loadModels(e.data.options)
						break;
          case "addDie":
						// toss from all edges
						// setStartPosition()
						if(e.data.options.newStartPoint){
							setStartPosition()
						}
            const newDie = addDie(e.data.options)
						rollDie(newDie)
            break;
          case "rollDie":
            rollDie(findDie(e.data.id))
            break;
					case "removeDie":
						removeDie(e.data.id)
						break;
          case "stopSimulation":
            stopLoop = true
            break;
          case "resumeSimulation":
						if(e.data.newStartPoint){
							setStartPosition()
						}
            stopLoop = false
						loop()
            break;
					case "stepSimulation":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						loop()
						break;
          default:
            console.error("action not found in physics worker from worldOffscreen worker:", e.data.action)
        }
      }
      break
    default:
      console.error("action not found in physics worker:", e.data.action)
  }
}

// Rapier's compat build inlines its WASM as base64, so no asset path is needed.
const initRapier = () => {
	if (!rapierReady) rapierReady = RAPIER.init()
	return rapierReady
}

// runs when the worker loads to set up the Rapier physics world
// loaded colliders will be cached and added to the world in a later post message
const init = async (data) => {
	width = data.width
	height = data.height
	aspect = width / height

	config = {...config,...data.options}
	config.gravity = computeGravity(config.gravity, config.mass)
	config.mass = computeMass(config.mass)
	config.spinForce = computeSpin(config.spinForce)
	config.throwForce = computeThrowForce(config.throwForce,config.mass,config.scale)
	config.startingHeight = computeStartingHeight(config.startingHeight)

	await initRapier()

	setStartPosition()

	freeWorld()
	world = new RAPIER.World({x: 0, y: gravityY(), z: 0})
	world.timestep = FIXED_TIMESTEP
	eventQueue = new RAPIER.EventQueue(true)

	addBoxToWorld(config.size, config.startingHeight + 10)
}

// release the WASM memory held by a previous world (World.free also frees its bodies and colliders)
const freeWorld = () => {
	eventQueue?.free()
	world?.free()
	eventQueue = undefined
	world = undefined
	bodies = []
	sleepingBodies = []
	boxParts = []
	colliderOwners.clear()
	accumulator = 0
}

const updateConfig = (options) => {
	const previousScale = config.scale
	config = {...config, ...options}
	if(options.mass){
		config.mass = computeMass(config.mass)
	}
	if(options.mass || options.gravity) {
		config.gravity = computeGravity(config.gravity, config.mass)
	}

	if(options.spinForce) {
		config.spinForce = computeSpin(config.spinForce)
	}
	if(options.throwForce || options.mass || options.scale){
		config.throwForce = computeThrowForce(config.throwForce, config.mass, config.scale)
	}
	if(options.startingHeight) {
		config.startingHeight = computeStartingHeight(config.startingHeight)
	}

	if (config.scale !== previousScale) {
		rescaleColliders()
	}

	if (!world) return
	addBoxToWorld(config.size, config.startingHeight + 10)
	world.gravity = {x: 0, y: gravityY(), z: 0}
	// the event threshold depends on gravity
	;[...bodies, ...sleepingBodies].forEach(die => die.collider.setContactForceEventThreshold(dieEventThreshold(die)))
}

const gravityY = () => -9.81 * config.gravity
const dieEventThreshold = (die) => contactForceThreshold(die.mass, gravityY())

const scaledVertices = (model) => scaleVertices(model.positions, model.scaling, config.scale)

// options object with colliders and meshName are required
const loadModels = ({colliders: modelData, meshName}) => {

	let has_d100 = false
	let has_d10 = false

	// cache the scaled hull points of every collider model; dice get their own hull collider when added
	modelData.forEach((model) => {
		colliders[meshName + '_' + model.name] = {
			model,
			vertices: scaledVertices(model),
		}
		if (!has_d10) {
			has_d10 = model.id === "d10_collider"
		}
		if (!has_d100) {
			has_d100 = model.id === "d100_collider"
		}
	})
	if (!has_d100 && has_d10) {
		colliders[`${meshName}_d100_collider`] = colliders[`${meshName}_d10_collider`]
	}
}

// the dice scale changed: rebuild cached points and give existing dice a collider of the new size,
// matching the renderer, which rescales existing meshes
const rescaleColliders = () => {
	new Set(Object.values(colliders)).forEach(entry => {
		entry.vertices = scaledVertices(entry.model)
	})
	if (!world) return
	;[...bodies, ...sleepingBodies].forEach(die => {
		colliderOwners.delete(die.collider.handle)
		world.removeCollider(die.collider, false)
		die.collider = createDieCollider(die)
	})
}

const setStartPosition = () => {
	let size = config.size
	let edgeOffset = .5
	let xMin = size * aspect / 2 - edgeOffset
	let xMax = size * aspect / -2 + edgeOffset
	let yMin = size / 2 - edgeOffset
	let yMax = size / -2 + edgeOffset
	let xEnvelope = lerp(xMin, xMax, Math.random())
	let yEnvelope = lerp(yMin, yMax, Math.random())
	let tossFromTop = Math.round(Math.random())
	let tossFromLeft = Math.round(Math.random())
	let tossX = Math.round(Math.random())

	config.startPosition = [
		// tossing on x axis then z should be locked to top or bottom
		// not tossing on x axis then x should be locked to the left or right
		tossX ? xEnvelope : tossFromLeft ? xMax : xMin,
		config.startingHeight,
		tossX ? tossFromTop ? yMax : yMin : yEnvelope
	]
}

// Bullet's default friction/restitution combination is the product of both surfaces.
// Keeping it preserves the feel the config values were tuned for (e.g. .1 * .1 restitution).
const applySurface = (desc) => desc
	.setFriction(config.friction)
	.setRestitution(config.restitution)
	.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
	.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)

const createDieCollider = (die) => {
	const {vertices} = colliders[die.colliderKey]
	let desc = RAPIER.ColliderDesc.convexHull(vertices)
	if (!desc) {
		// degenerate (e.g. flat) point cloud: fall back to its bounding box
		console.warn(`Unable to build a convex hull for ${die.colliderKey}; using its bounding box`)
		const [hx, hy, hz] = halfExtents(vertices)
		desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
	}
	applySurface(desc)
		// Rapier derives the inertia tensor from this mass and the hull
		.setMass(die.mass)
		.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
		.setContactForceEventThreshold(dieEventThreshold(die))
	const collider = world.createCollider(desc, die.body)
	colliderOwners.set(collider.handle, {id: die.id, die})
	return collider
}

const randomRotation = () => normalizeQuaternion({
	x: lerp(-1.5, 1.5, Math.random()),
	y: lerp(-1.5, 1.5, Math.random()),
	z: lerp(-1.5, 1.5, Math.random()),
	w: -1,
})

// cache for box parts so it can be removed after a new one has been made
let boxParts = []
const addBoxToWorld = (size, height) => {
	if (!world) return
	removeBoxFromWorld()
	// [id, position, half extents] - Bullet box half extents and Rapier cuboid half extents mean the same thing
	const parts = [
		['box_bottom', [0, -.5, 0], [size * aspect, 1, size]],
		['box_top', [0, height - .5, 0], [size * aspect, 1, size]],
		['box_wall_north', [0, 0, (size / -2) - .5], [size * aspect, height, 1]],
		['box_wall_south', [0, 0, (size / 2) + .5], [size * aspect, height, 1]],
		['box_wall_east', [(size * aspect / -2) - .5, 0, 0], [1, height, size]],
		['box_wall_west', [(size * aspect / 2) + .5, 0, 0], [1, height, size]],
	]
	boxParts = parts.map(([id, [x, y, z], [hx, hy, hz]]) => {
		const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z))
		const collider = world.createCollider(applySurface(RAPIER.ColliderDesc.cuboid(hx, hy, hz)), body)
		colliderOwners.set(collider.handle, {id})
		return {id, body, collider}
	})
}

const removeBoxFromWorld = () => {
	boxParts.forEach(part => {
		colliderOwners.delete(part.collider.handle)
		// removing the body also removes its collider
		world?.removeRigidBody(part.body)
	})
	boxParts = []
}

const addDie = (options) => {
	const { sides, id, meshName } = options
	const dieType = Number.isInteger(sides) ? `d${sides}` : sides
	let cType = `${dieType}_collider`
	const comboKey = `${meshName}_${cType}`
	if (!world || !colliders[comboKey]) {
		console.error(`physics worker: cannot add die, ${world ? `collider '${comboKey}' not loaded` : 'world not initialized'}`)
		return
	}
	const colliderMass = colliders[comboKey].model.physicsMass || .1
	const mass = colliderMass * config.mass * config.scale // feature? mass should go up with scale, but it throws off the throwForce and spinForce scaling
	// TODO: incorporate colliders physicsFriction and physicsRestitution settings
	const [x, y, z] = config.startPosition
	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation(x, y, z)
			.setRotation(randomRotation())
			.setLinearDamping(bulletToRapierDamping(config.linearDamping))
			.setAngularDamping(bulletToRapierDamping(config.angularDamping))
			// settling is decided by our own thresholds below, never by Rapier's sleep timer
			.setCanSleep(false)
	)
	const die = {
		id,
		body,
		collider: undefined,
		timeout: config.settleTimeout,
		mass,
		colliderKey: comboKey,
	}
	die.collider = createDieCollider(die)
	bodies.push(die)

	return die
}

const findDie = (id) => bodies.find(die => die.id === id)

const rollDie = (die) => {
	if (!die?.body) return
	const [sx, sy, sz] = config.startPosition

	// lerp picks a random number between two values
	die.body.setLinvel({
		x: lerp(-sx * .5, -sx * config.throwForce, Math.random()),
		y: lerp(-sy, -sy * 2, Math.random()), // limit the y force to 2
		z: lerp(-sz * .5, -sz * config.throwForce, Math.random()),
	}, true)

	const flippy = Math.random() > .5 ? 1 : -1 // random positive or negative number
	const spinny = lerp(config.spinForce * .5, config.spinForce, Math.random())
	const impulse = {
		x: spinny * flippy,
		y: spinny * -flippy, // flip the flippy to avoid gimble lock
		z: spinny * flippy
	}

	// attempting to create an envelope for the force influence based on scale and mass
	// linear scale was no good - this creates a nice power curve
	const scale = Math.abs(config.scale - 1) + config.scale * config.scale * (die.mass/config.mass) * .75

	// off-center impulse (Bullet applyImpulse(impulse, relPos)): pushes the die and makes it tumble
	const center = die.body.translation()
	die.body.applyImpulseAtPoint(impulse, {x: center.x + scale, y: center.y + scale, z: center.z + scale}, true)
	// Bullet capped rotation at a quarter turn per step; keep spin in the same range
	die.body.setAngvel(clampLength(die.body.angvel(), MAX_ANGULAR_SPEED), true)
}

const destroyDie = (die) => {
	colliderOwners.delete(die.collider.handle)
	// removing the body also removes its collider
	world?.removeRigidBody(die.body)
}

const removeDie = (id) => {
	const keep = (die) => {
		if (die.id !== id) return true
		destroyDie(die)
		return false
	}
	sleepingBodies = sleepingBodies.filter(keep)
	bodies = bodies.filter(keep)
}

const clearDice = () => {
	if(diceBufferView?.byteLength){
		diceBufferView.fill(0)
	}
	stopLoop = true
	// clear all bodies
	bodies.forEach(destroyDie)
	sleepingBodies.forEach(destroyDie)
	// clear cache arrays
	bodies = []
	sleepingBodies = []
	accumulator = 0
}

// walls and settled (fixed) dice do not move, so they count as infinitely heavy
const dynamicMass = (owner) => owner?.die?.body.isDynamic() ? owner.die.mass : Infinity

const postCollisions = () => {
	eventQueue.drainContactForceEvents(event => {
		const first = colliderOwners.get(event.collider1())
		const second = colliderOwners.get(event.collider2())
		if (!first && !second) return
		const pairMass = reducedMass(dynamicMass(first), dynamicMass(second))
		const force = collisionStrength(event.totalForceMagnitude(), FIXED_TIMESTEP, pairMass)
		if (force > 0) {
			// Send the collision data to the main thread
			self.postMessage({
				action: "collision",
				body0Id: first?.id,
				body1Id: second?.id,
				force
			})
		}
	})
}

const update = (delta) => {
	// step world in fixed increments (at most 2 per frame; extra time is dropped, giving slow motion like before)
	const {steps, remainder} = accumulateSteps(accumulator, delta / 1000)
	accumulator = remainder
	for (let step = 0; step < steps; step++) {
		world.step(eventQueue)
		postCollisions()
	}

	diceBufferView[0] = bodies.length

	// looping backwards since bodies are removed as they are put to sleep
	for (let i = bodies.length - 1; i >= 0; i--) {
		const die = bodies[i]
		const rb = die.body
		const linvel = rb.linvel()
		const angvel = rb.angvel()

		if(isSettled(vectorLength(linvel), vectorLength(angvel), die.timeout)) {
			// flag the second param for this body so it can be processed in World, first param will be the roll.id
			diceBufferView[(i*8) + 1] = die.id
			diceBufferView[(i*8) + 2] = -1
			// zero out anything left and freeze the die where it is
			rb.setLinvel(ZERO, false)
			rb.setAngvel(ZERO, false)
			rb.setBodyType(RAPIER.RigidBodyType.Fixed, false)
			sleepingBodies.push(bodies.splice(i,1)[0])
			continue
		}
		// tick down the movement timeout on this die
		die.timeout -= delta
		const {translation: p, rotation: q} = extrapolatePose(rb.translation(), rb.rotation(), linvel, angvel, accumulator)
		let j = i*8 + 1

		diceBufferView[j] = die.id
		diceBufferView[j+1] = p.x
		diceBufferView[j+2] = p.y
		diceBufferView[j+3] = p.z
		diceBufferView[j+4] = q.x
		diceBufferView[j+5] = q.y
		diceBufferView[j+6] = q.z
		diceBufferView[j+7] = q.w
	}
}

let last = performance.now()
const loop = () => {
	let now = performance.now()
	const delta = now - last
	last = now

	if(!stopLoop && world && diceBufferView?.byteLength) {
		update(delta)
			worldWorkerPort.postMessage({
				action: 'updates',
				diceBuffer: diceBufferView.buffer
			}, [diceBufferView.buffer])
	}
}
