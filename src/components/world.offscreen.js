import worldWorker from './offscreenCanvas.worker?worker&inline' // using vite.js worker import - this will be compiled away

class WorldOffScreen {
	initialized = false
	offscreenWorkerInit = false
	themeLoadedInit = false
	pendingThemePromises = {}
	#offscreenCanvas
	#destroyed = false
	#initReject
	#failure
	#OffscreenWorker
	// onInitComplete = () => {} // init callback
	onRollResult = () => {} // individual die callback
	onRollComplete = () => {} // roll group callback

	constructor(options){
		this.onInitComplete = options.onInitComplete

		// transfer control offscreen
		this.#offscreenCanvas = options.canvas.transferControlToOffscreen()

		// initialize 3D World in which BabylonJS runs
		this.#OffscreenWorker = new worldWorker()
		// need to initialize the web worker and get confirmation that initialization is complete before other scripts can run
		// set a property on the worker to a promise that is resolve when the proper message is returned from the worker
		this.#OffscreenWorker.init = new Promise((resolve, reject) => {
			this.offscreenWorkerInit = resolve
			this.#initReject = reject
		})

		this.initialized = this.#initScene(options)
	}

	// initialize the babylon scene
	async #initScene(config) {
		// initialize the offscreen worker
		this.#OffscreenWorker.postMessage({
			action: "init",
			canvas: this.#offscreenCanvas,
			width: config.canvas.clientWidth,
			height: config.canvas.clientHeight,
			options: config.options,
		}, [this.#offscreenCanvas])

		// handle messages from offscreen BabylonJS World
		this.#OffscreenWorker.onmessage = (e) => {
			if (this.#destroyed || this.#failure) return
			switch( e.data.action ) {
				case "error":
					this.#fail(new Error(e.data.message || 'DiceBox rendering worker failed'))
					break;
				case "init-complete":
					this.offscreenWorkerInit() //fulfill promise so other things can run
					break;
				case "connect-complete":
					break;
				case "theme-loaded":
					if(e.data.id){
						this.pendingThemePromises[e.data.id]?.resolve(e.data.id)
						delete this.pendingThemePromises[e.data.id]
					}
					break;
				case 'roll-result':
					this.onRollResult(e.data.die)
					break;
				case 'roll-complete':
					this.onRollComplete()
					break;
				case 'die-removed':
					this.onDieRemoved(e.data.rollId)
					break;
			}
		}
		// await Promise.all([this.#OffscreenWorker.init])
		this.#OffscreenWorker.onerror = event => {
			if (!this.#destroyed) this.#fail(new Error(event.message || 'DiceBox rendering worker failed'))
		}

		await this.#OffscreenWorker.init
		if (this.#destroyed) return
		if (this.#failure) throw this.#failure

		this.onInitComplete(true)

		return true
	}

	connect(port){
		if (this.#destroyed) { port.close(); return }
		// Setup the connection: Port 1 is for this.#OffscreenWorker
		this.#OffscreenWorker.postMessage({
			action : "connect",
			port
		},[ port ])
	}

	updateConfig(options){
		if (this.#destroyed) return
		this.#OffscreenWorker.postMessage({action: "updateConfig", options});
	}

	resize(options){
		if (this.#destroyed) return
		this.#OffscreenWorker.postMessage({action: "resize", options});
	}

	async loadTheme(options) {
		if (this.#destroyed) return
		if (this.#failure) throw this.#failure
		if (this.pendingThemePromises[options.theme]) return this.pendingThemePromises[options.theme].promise
		const pending = {}
		pending.promise = new Promise((resolve, reject) => Object.assign(pending, {resolve, reject}))
		this.pendingThemePromises[options.theme] = pending
		try {
			this.#OffscreenWorker.postMessage({action: "loadTheme", options})
		} catch (error) {
			delete this.pendingThemePromises[options.theme]
			pending.reject(error)
		}
		return pending.promise
	}

	#fail(error) {
		this.#failure = error
		this.#initReject(error)
		for (const pending of Object.values(this.pendingThemePromises)) pending.reject(error)
		this.pendingThemePromises = {}
	}

	clear(){
		if (this.#destroyed) return
		this.#OffscreenWorker.postMessage({action: "clearDice"})
	}

	add(options){
		if (this.#destroyed) return
		this.#OffscreenWorker.postMessage({action: "addDie", options})
	}
	
	addNonDie(options){
		if (this.#destroyed) return
		this.#OffscreenWorker.postMessage({action: "addNonDie", options})
	}

	remove(options){
		if (this.#destroyed) return
		// remove the die from the render
		this.#OffscreenWorker.postMessage({action: "removeDie", options})
	}
	// Terminating the worker releases its scene, engine, timers and transferred port.
	destroy() {
		if (this.#destroyed) return
		this.#destroyed = true
		this.#OffscreenWorker.onmessage = null
		this.#OffscreenWorker.onerror = null
		this.#OffscreenWorker.terminate()
		this.offscreenWorkerInit?.()
		for (const pending of Object.values(this.pendingThemePromises)) pending.resolve()
		this.pendingThemePromises = {}
		this.#offscreenCanvas = undefined
		this.onInitComplete = this.onRollResult = this.onRollComplete = this.onDieRemoved = () => {}
	}

}

export default WorldOffScreen