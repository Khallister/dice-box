// Drives the real physics worker module in Node: fake `self`, fake MessagePort and a manual clock.
// Rapier runs for real (the compat build inlines its WASM).
import {readFileSync} from 'node:fs'

const FRAME_MS = 1000 / 60
let instance = 0

// Keep the real Performance object (Rapier's WASM bindings use it) and only drive its clock.
const clock = {now: 0}
Object.defineProperty(performance, 'now', {value: () => clock.now, configurable: true, writable: true})

export const loadColliders = () => {
	const data = JSON.parse(readFileSync(new URL('../public/assets/dice-box/themes/default/default.json', import.meta.url), 'utf8'))
	return data.meshes.filter(mesh => mesh.name.includes('collider'))
}

export async function createWorker({width = 800, height = 600, options = {}, initBuffer = true, models = loadColliders()} = {}) {
	const messages = []
	const updates = []
	// In a worker `self` is the global scope; Rapier's WASM bindings look globals up through it.
	const self = globalThis
	self.self = self
	self.postMessage = message => messages.push(message)
	await import(`../src/components/physics.worker.js?instance=${++instance}`)
	const send = data => self.onmessage({data})

	send({action: 'init', width, height, options: {scale: 5, settleTimeout: 5000, ...options}})
	for (let i = 0; i < 1000 && !messages.some(m => m.action === 'init-complete'); i++) {
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	if (!messages.some(m => m.action === 'init-complete')) throw new Error('physics worker did not finish init')

	const port = {postMessage: message => updates.push(message)}
	self.onmessage({data: {action: 'connect'}, ports: [port]})
	const toWorker = data => port.onmessage({data})

	let buffer = new ArrayBuffer(8000 * 4)
	if (initBuffer) toWorker({action: 'initBuffer', diceBuffer: buffer})
	if (models) toWorker({action: 'loadModels', options: {colliders: models, meshName: 'default'}})

	return {
		messages,
		send,
		toWorker,
		collisions: () => messages.filter(m => m.action === 'collision'),
		addDie: (id, sides, extra = {}) => toWorker({action: 'addDie', options: {id, sides, meshName: 'default', ...extra}}),
		// advance one rendered frame and return the buffer view the worker posted back
		frame(ms = FRAME_MS) {
			clock.now += ms
			toWorker({action: 'stepSimulation', diceBuffer: buffer})
			const update = updates.at(-1)
			buffer = update?.diceBuffer ?? buffer
			return new Float32Array(buffer)
		},
	}
}

// Read the per-die records of one frame: [{id, settled, position, rotation}]
export const readFrame = (view) => {
	const dice = []
	for (let i = 0; i < view[0]; i++) {
		const j = i * 8 + 1
		dice.push(view[j + 1] === -1
			? {id: view[j], settled: true}
			: {id: view[j], settled: false, position: [view[j + 1], view[j + 2], view[j + 3]], rotation: [view[j + 4], view[j + 5], view[j + 6], view[j + 7]]})
	}
	return dice
}

export const FRAME = FRAME_MS
