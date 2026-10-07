import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {debounce, createAsyncQueue} from '../src/helpers/index.js'

// Substitute browser/Babylon dependencies only; exercise the actual lifecycle code.
function loadClass(path, name, dependencies, transform = source => source) {
	const source = transform(readFileSync(new URL(path, import.meta.url), 'utf8'))
		.replace(/^import .*$/gm, '')
		.replace(`export default ${name}`, `return ${name}`)
	return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies))
}

function environment() {
	const frames = new Map()
	const listeners = new Set()
	let frameId = 0
	globalThis.window = {
		location: {origin: 'https://example.test'},
		addEventListener: (type, callback) => listeners.add(callback),
		removeEventListener: (type, callback) => listeners.delete(callback),
		requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId },
		cancelAnimationFrame: id => frames.delete(id),
	}
	globalThis.requestAnimationFrame = window.requestAnimationFrame
	globalThis.cancelAnimationFrame = window.cancelAnimationFrame
	const workers = []
	class Worker {
		messages = []
		terminated = 0
		constructor() { workers.push(this) }
		postMessage(message) {
			assert.equal(this.terminated, 0, 'message sent after worker termination')
			this.messages.push(message)
			if (message.action === 'init') queueMicrotask(() => this.onmessage?.({data: {action: 'init-complete'}}))
		}
		terminate() { this.terminated++ }
	}
	const ports = []
	class Port {
		closed = 0
		messages = []
		postMessage(message) { assert.equal(this.closed, 0); this.messages.push(message) }
		close() { this.closed++ }
	}
	globalThis.MessageChannel = class {
		port1 = new Port()
		port2 = new Port()
		constructor() { ports.push(this.port1, this.port2) }
	}
	const canvas = {clientWidth: 640, clientHeight: 480, removed: 0, remove() { this.removed++ }}
	globalThis.fetch = async () => ({ok: true, headers: {get: () => 'application/json'}, json: async () => ({diceAvailable: ['d6'], meshFile: 'dice.json'})})
	return {frames, listeners, workers, Worker, Port, ports, canvas}
}

function facade(env, loadWorldModule) {
	return loadClass('../src/WorldFacade.js', 'WorldFacade', {
		createCanvas: () => env.canvas, physicsWorker: env.Worker, debounce, createAsyncQueue,
		Random: {range: () => 4}, hexToRGB: () => ({}), webgl_support: () => true, loadWorldModule,
	}, source => source.replaceAll("import('./components/", "loadWorldModule('./components/"))
}

test('destroy during dynamic world import rejects init and never constructs a late world', async () => {
	const env = environment()
	let resolveModule
	let constructions = 0
	const Box = facade(env, () => new Promise(resolve => { resolveModule = resolve }))
	const box = new Box({offscreen: false})
	const pending = box.init()
	const rejected = assert.rejects(pending, {name: 'AbortError'})
	assert.equal(box.init(), pending, 'concurrent init calls share one lifetime')
	assert.equal(box.destroy(), box)
	box.destroy().dispose()
	resolveModule({default: class { constructor() { constructions++ } }})
	await rejected
	await Promise.resolve()
	assert.equal(constructions, 0)
	assert.equal(env.workers.length, 1)
	assert.equal(env.workers[0].terminated, 1)
	assert.equal(env.canvas.removed, 1)
	assert.equal(env.listeners.size, 0)
	assert.equal(box.destroyed, true)
	assert.throws(() => box.roll('1d6'), {name: 'AbortError'})
})

test('initialized facade releases resources and rejects an outstanding roll without stale callbacks', async () => {
	const env = environment()
	let world
	let collisions = 0
	class World {
		destroyed = 0
		cleared = 0
		constructor(options) { world = this; options.onInitComplete(); this.initialized = Promise.resolve() }
		connect() {}
		loadTheme() { return Promise.resolve() }
		resize() {}
		clear() { this.cleared++ }
		add() {}
		destroy() { this.destroyed++ }
	}
	const Box = facade(env, async () => ({default: World}))
	const box = new Box({offscreen: false, onCollision: () => collisions++})
	await box.init()
	assert.equal(box.clear(), box)
	assert.equal(world.destroyed, 0, 'clear keeps the instance reusable')
	box.resizeWorld()
	assert.equal(env.listeners.size, 1)
	const roll = box.roll('1d6')
	const rejected = assert.rejects(roll, {name: 'AbortError'})
	const stalePhysics = env.workers[0].onmessage
	const staleRoll = world.onRollResult
	box.destroy().destroy()
	stalePhysics({data: {action: 'collision', body0Id: 1, body1Id: 2, force: 10}})
	staleRoll({rollId: 0, value: 6})
	await rejected
	assert.equal(collisions, 0)
	assert.equal(world.destroyed, 1)
	assert.equal(env.workers[0].terminated, 1)
	assert.equal(env.listeners.size, 0)
	assert.equal(env.frames.size, 0)
	assert.ok(env.ports.every(port => port.closed === 1))
})

test('offscreen destroy settles pending init/theme and ignores captured worker responses', async () => {
	const env = environment()
	let initCallbacks = 0
	const World = loadClass('../src/components/world.offscreen.js', 'WorldOffScreen', {worldWorker: env.Worker})
	const world = new World({canvas: {...env.canvas, transferControlToOffscreen: () => ({})}, options: {}, onInitComplete: () => initCallbacks++})
	const theme = world.loadTheme({theme: 'default'})
	const staleMessage = env.workers[0].onmessage
	world.destroy()
	world.destroy()
	staleMessage({data: {action: 'init-complete'}})
	staleMessage({data: {action: 'theme-loaded', id: 'default'}})
	await Promise.all([world.initialized, theme])
	assert.equal(initCallbacks, 0)
	assert.equal(env.workers[0].terminated, 1)
	const port = new env.Port()
	world.connect(port)
	assert.equal(port.closed, 1)
})

test('onscreen destroy cancels delayed dice and transfer RAF, then disposes Babylon once', async () => {
	const env = environment()
	const timers = new Map()
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	let timerId = 0
	globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId }
	globalThis.clearTimeout = id => timers.delete(id)
	const counts = {scene: 0, engine: 0, stop: 0, themes: 0, results: 0}
	const engine = {activeRenderLoops: [], runRenderLoop() {}, stopRenderLoop() { counts.stop++ }, dispose() { counts.engine++ }, resize() {}}
	const scene = {dispose() { counts.scene++ }, render() {}}
	try {
		const World = loadClass('../src/components/world.onscreen.js', 'WorldOnscreen', {
			Vector3: class {}, createEngine: () => engine, createScene: () => scene,
			createCamera: () => ({}), createLights: () => ({}), Container: class {},
			Dice: {getRollResult: async die => die.value}, ThemeLoader: class {destroy() { counts.themes++ }},
		})
		const world = new World({canvas: env.canvas, options: {delay: 10}, onRollResult: () => counts.results++})
		const port = new env.Port()
		world.connect(port)
		world.addNonDie({id: 1, rollId: 1, value: 4})
		world.updatesFromPhysics(new Float32Array(8).buffer)
		const stalePhysics = port.onmessage
		assert.equal(timers.size, 1)
		assert.equal(env.frames.size, 1)
		world.destroy()
		world.destroy()
		stalePhysics({data: {action: 'updates', diceBuffer: new Float32Array(8).buffer}})
		await Promise.resolve()
		assert.equal(timers.size, 0)
		assert.equal(env.frames.size, 0)
		assert.equal(port.closed, 1)
		assert.deepEqual(counts, {scene: 1, engine: 1, stop: 1, themes: 1, results: 0})
	} finally {
		globalThis.setTimeout = originalSetTimeout
		globalThis.clearTimeout = originalClearTimeout
	}
})

test('theme destroy rejects pending texture requests and disposes their textures', async () => {
	const env = environment()
	let textureDisposals = 0
	const ThemeLoader = loadClass('../src/components/ThemeLoader.js', 'ThemeLoader', {
		StandardMaterial: class {}, CustomMaterial: class {}, SerializationHelper: {}, deepCopy: object => structuredClone(object),
		Texture: class {dispose() { textureDisposals++ }},
	})
	const loader = new ThemeLoader({scene: {}})
	const loading = loader.importTextureAsync('https://example.test/dice.png', 'default')
	const rejected = assert.rejects(loading, {name: 'AbortError'})
	loader.destroy()
	loader.destroy()
	await rejected
	assert.equal(textureDisposals, 1)
})

function simpleWorld(loadTheme = async () => {}) {
	return class {
		constructor(options) { options.onInitComplete(); this.initialized = Promise.resolve() }
		connect() {}
		clear() {}
		destroy() {}
		loadTheme = loadTheme
	}
}

test('onscreen resize redraws idle and active scenes without restarting physics or render loops', () => {
	const env = environment()
	const counts = {resize: 0, redraw: 0, started: 0}
	let bufferCleared = false
	const aspects = []
	const engine = {
		activeRenderLoops: [],
		runRenderLoop() { counts.started++ },
		resize() { counts.resize++; bufferCleared = true },
		stopRenderLoop() {}, dispose() {},
	}
	const scene = {
		isDisposed: false,
		render() { assert.equal(bufferCleared, true); counts.redraw++; bufferCleared = false },
		dispose() { this.isDisposed = true },
	}
	const World = loadClass('../src/components/world.onscreen.js', 'WorldOnscreen', {
		Vector3: class {}, createEngine: () => engine, createScene: () => scene,
		createCamera: () => ({}), createLights: () => ({}),
		Container: class {create({aspect}) { aspects.push(aspect) }},
		Dice: {}, ThemeLoader: class {destroy() {}},
	})
	const world = new World({canvas: env.canvas, options: {}})
	const port = new env.Port()
	world.connect(port)
	const messagesBeforeResize = port.messages.length
	world.resize({width: 320, height: 640})
	assert.equal(bufferCleared, false, 'settled board is redrawn after resizing clears the buffer')
	assert.equal(counts.redraw, 1)
	const activeLoop = () => {}
	engine.activeRenderLoops = [activeLoop]
	world.resize({width: 640, height: 320})
	assert.deepEqual(engine.activeRenderLoops, [activeLoop])
	assert.deepEqual(counts, {resize: 2, redraw: 2, started: 0})
	assert.deepEqual(aspects, [0.5, 2])
	assert.equal(port.messages.length, messagesBeforeResize)
	world.destroy()
	world.resize({width: 900, height: 900})
	assert.deepEqual(counts, {resize: 2, redraw: 2, started: 0})
	assert.equal(env.canvas.width, 640)
	assert.equal(env.canvas.height, 320)
})

test('missing required theme configuration rejects init with the asset error', async () => {
	const env = environment()
	globalThis.fetch = async () => ({ok: false, status: 404, statusText: 'Not Found'})
	let loaded = 0
	const Box = facade(env, async () => ({default: simpleWorld()}))
	const box = new Box({offscreen: false, onThemeLoaded: () => loaded++})
	await assert.rejects(box.init(), /404/)
	assert.equal(loaded, 0)
	assert.deepEqual(box.themesLoadedData, {})
	box.destroy()
})

test('model failure rejects init and a failed roll theme rejects its collection', async () => {
	const env = environment()
	const failure = new Error('Babylon mesh import failed')
	const Box = facade(env, async () => ({default: simpleWorld(async () => { throw failure })}))
	const failed = new Box({offscreen: false})
	await assert.rejects(failed.init(), error => error === failure)
	assert.deepEqual(failed.themesLoadedData, {})
	failed.destroy()
	const WorkingBox = facade(env, async () => ({default: simpleWorld()}))
	const box = new WorkingBox({offscreen: false})
	await box.init()
	globalThis.fetch = async () => ({ok: false, status: 404, statusText: 'Not Found'})
	await assert.rejects(box.roll({sides: 6, theme: 'missing'}), /404/)
	box.destroy()
})

function modelLoader(importMesh) {
	return loadClass('../src/components/Dice.js', 'Dice', {
		SceneLoader: {ImportMeshAsync: importMesh},
		Vector3: class {static Zero() { return {} }}, Ray: class {}, Color3: {}, deepCopy: object => structuredClone(object),
	})
}

test('model readiness waits for Babylon import and propagates its rejection', async () => {
	environment()
	globalThis.fetch = async () => ({ok: true, headers: {get: () => 'application/json'}, json: async () => ({meshes: [{name: 'd6_collider'}], colliderFaceMap: {d6: {0: 6}}})})
	let rejectImport
	const Dice = modelLoader(() => new Promise((resolve, reject) => { rejectImport = reject }))
	let settled = false
	const loading = Dice.loadModels({meshFilePath: '/dice.json', meshName: 'default'}, {themeData: {}})
	loading.then(() => { settled = true }, () => { settled = true })
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(settled, false, 'fetching JSON alone does not make models ready')
	const failure = new Error('Babylon import rejected')
	rejectImport(failure)
	await assert.rejects(loading, error => error === failure)
})

test('destroy during model import disposes late meshes and preserves AbortError', async () => {
	environment()
	globalThis.fetch = async () => ({ok: true, headers: {get: () => 'application/json'}, json: async () => ({meshes: [], colliderFaceMap: {}})})
	let resolveImport
	const Dice = modelLoader(() => new Promise(resolve => { resolveImport = resolve }))
	const controller = new AbortController()
	const loading = Dice.loadModels({meshFilePath: '/dice.json', meshName: 'default', signal: controller.signal}, {themeData: {}})
	await new Promise(resolve => setImmediate(resolve))
	controller.abort()
	let disposed = 0
	resolveImport({meshes: [{dispose: () => disposed++}]})
	await assert.rejects(loading, {name: 'AbortError'})
	assert.equal(disposed, 1)
})

test('offscreen worker theme errors reach and reject the pending caller', async () => {
	const env = environment()
	const World = loadClass('../src/components/world.offscreen.js', 'WorldOffScreen', {worldWorker: env.Worker})
	const world = new World({canvas: {...env.canvas, transferControlToOffscreen: () => ({})}, options: {}, onInitComplete: () => {}})
	await world.initialized
	const loading = world.loadTheme({theme: 'broken'})
	const workerSource = readFileSync(new URL('../src/components/offscreenCanvas.worker.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
	const self = {postMessage: data => env.workers[0].onmessage({data})}
	new Function('WorldOnscreen', 'self', workerSource)(simpleWorld(async () => { throw new Error('Broken offscreen model') }), self)
	await self.onmessage({data: {action: 'init', options: {}}})
	await self.onmessage({data: {action: 'loadTheme', options: {theme: 'broken'}}})
	await assert.rejects(loading, /Broken offscreen model/)
	await assert.rejects(world.loadTheme({theme: 'another'}), /Broken offscreen model/)
	world.destroy()
})

test('a d100 pair settling in the same frame reports the combined value once', async () => {
	const env = environment()
	const engine = {activeRenderLoops: [], runRenderLoop() {}, stopRenderLoop() {}, dispose() {}, resize() {}}
	const lookups = new Map()
	const World = loadClass('../src/components/world.onscreen.js', 'WorldOnscreen', {
		Vector3: class {}, createEngine: () => engine, createScene: () => ({render() {}, dispose() {}}),
		createCamera: () => ({}), createLights: () => ({}), Container: class {},
		ThemeLoader: class {destroy() {}},
		// the face lookup is asynchronous; each test step decides when it finishes
		Dice: {getRollResult: die => new Promise(resolve => lookups.set(die, resolve))},
	})
	const results = []
	const world = new World({canvas: env.canvas, options: {}, onRollResult: result => results.push(result)})
	const d100 = {config: {sides: 100, rollId: 5}}
	const d10 = {config: {sides: 10}, dieParent: d100}
	d100.d10Instance = d10
	// both halves are flagged asleep by the same physics frame
	const settling = [world.handleAsleep(d100), world.handleAsleep(d10)]
	d100.value = 30
	lookups.get(d100)()
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(results, [], 'no result before the ones die has a value')
	d10.value = 7
	lookups.get(d10)()
	await Promise.all(settling)
	assert.deepEqual(results, [{rollId: 5, value: 37}])
	world.destroy()
})
