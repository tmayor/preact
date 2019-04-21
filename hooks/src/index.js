import { options } from 'preact';
import { USE_STATE, USE_REDUCER, USE_EFFECT, USE_LAYOUT_EFFECT, USE_REF, USE_MEMO, USE_CALLBACK, USE_CONTEXT } from './constants';

/** @type {number} */
let currentIndex;

/** @type {import('./internal').Component} */
let currentComponent;

/** @type {Array<import('./internal').Component>} */
let afterPaintEffects = [];

let oldBeforeRender = options.render;
options.render = vnode => {
	if (oldBeforeRender) oldBeforeRender(vnode);

	currentComponent = vnode._component;
	currentIndex = 0;

	if (!currentComponent.__hooks) return;
	currentComponent.__hooks._pendingEffects = handleEffects(currentComponent.__hooks._pendingEffects);
};


let oldAfterDiff = options.diffed;
options.diffed = vnode => {
	if (oldAfterDiff) oldAfterDiff(vnode);

	const c = vnode._component;
	if (!c) return;

	const hooks = c.__hooks;
	if (!hooks) return;

	// TODO: Consider moving to a global queue. May need to move
	// this to the `commit` option
	hooks._pendingLayoutEffects = handleEffects(hooks._pendingLayoutEffects);
};


let oldBeforeUnmount = options.unmount;
options.unmount = vnode => {
	if (oldBeforeUnmount) oldBeforeUnmount(vnode);

	const c = vnode._component;
	if (!c) return;

	const hooks = c.__hooks;
	if (!hooks) return;

	hooks._list.forEach(hook => hook._cleanup && hook._cleanup());
};

function dispatchHook(hook) {
	if (options.hooked) options.hooked(hook);
}

/**
 * Get a hook's state from the currentComponent
 * @param {number} index The index of the hook to get
 * @returns {import('./internal').HookState}
 */
function getHookState(index) {
	// Largely inspired by:
	// * https://github.com/michael-klein/funcy.js/blob/f6be73468e6ec46b0ff5aa3cc4c9baf72a29025a/src/hooks/core_hooks.mjs
	// * https://github.com/michael-klein/funcy.js/blob/650beaa58c43c33a74820a3c98b3c7079cf2e333/src/renderer.mjs
	// Other implementations to look at:
	// * https://codesandbox.io/s/mnox05qp8

	const hooks = currentComponent.__hooks || (currentComponent.__hooks = { _list: [], _pendingEffects: [], _pendingLayoutEffects: [] });

	if (index >= hooks._list.length) {
		hooks._list.push({});
	}
	return hooks._list[index];
}

export function useState(initialState) {
	dispatchHook(USE_STATE);
	return useReducer(invokeOrReturn, initialState);
}

export function useReducer(reducer, initialState, init) {
	dispatchHook(USE_REDUCER);

	/** @type {import('./internal').ReducerHookState} */
	const hookState = getHookState(currentIndex++);
	if (hookState._component == null) {
		hookState._component = currentComponent;

		hookState._value = [
			init == null ? invokeOrReturn(null, initialState) : init(initialState),

			action => {
				const nextValue = reducer(hookState._value[0], action);
				if (hookState._value[0]!==nextValue) {
					hookState._value[0] = nextValue;
					hookState._component.setState({});
				}
			}
		];
	}

	return hookState._value;
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useEffect(callback, args) {
	dispatchHook(USE_EFFECT);

	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++);
	if (argsChanged(state._args, args)) {
		state._value = callback;
		state._args = args;

		currentComponent.__hooks._pendingEffects.push(state);
		afterPaint(currentComponent);
	}
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useLayoutEffect(callback, args) {
	dispatchHook(USE_LAYOUT_EFFECT);

	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++);
	if (argsChanged(state._args, args)) {
		state._value = callback;
		state._args = args;
		currentComponent.__hooks._pendingLayoutEffects.push(state);
	}
}

export function useRef(initialValue) {
	dispatchHook(USE_REF);

	const state = getHookState(currentIndex++);
	if (state._value == null) {
		state._value = { current: initialValue };
	}

	return state._value;
}

/**
 * @param {() => any} callback
 * @param {any[]} args
 */
export function useMemo(callback, args) {
	dispatchHook(USE_MEMO);

	/** @type {import('./internal').MemoHookState} */
	const state = getHookState(currentIndex++);
	if (argsChanged(state._args, args)) {
		state._args = args;
		state._callback = callback;
		return state._value = callback();
	}

	return state._value;
}

/**
 * @param {() => void} callback
 * @param {any[]} args
 */
export function useCallback(callback, args) {
	dispatchHook(USE_CALLBACK);
	return useMemo(() => callback, args);
}

/**
 * @param {import('./internal').PreactContext} context
 */
export function useContext(context) {
	dispatchHook(USE_CONTEXT);

	const provider = currentComponent.context[context._id];
	if (provider == null) return context._defaultValue;
	const state = getHookState(currentIndex++);
	if (state._value == null) {
		state._value = true;
		provider.sub(currentComponent);
	}
	return provider.props.value;
}

/**
 * Display a custom label for a custom hook for the devtools panel
 * @type {<T>(value: T, cb?: (value: T) => string | number) => void}
 */
export function useDebugValue(value, formatter) {
	if (options.useDebugValue) {
		options.useDebugValue(formatter ? formatter(value) : value);
	}
}

// Note: if someone used Component.debounce = requestAnimationFrame,
// then effects will ALWAYS run on the NEXT frame instead of the current one, incurring a ~16ms delay.
// Perhaps this is not such a big deal.
/**
 * Invoke a component's pending effects after the next frame renders
 * @type {(component: import('./internal').Component) => void}
 */
let afterPaint = () => {};

/**
 * After paint effects consumer.
 */
function flushAfterPaintEffects() {
	afterPaintEffects.forEach(component => {
		component._afterPaintQueued = false;
		if (!component._parentDom) return;
		component.__hooks._pendingEffects = handleEffects(component.__hooks._pendingEffects);
	});
	afterPaintEffects = [];
}

function scheduleFlushAfterPaint() {
	setTimeout(flushAfterPaintEffects, 0);
}

if (typeof window !== 'undefined') {
	afterPaint = (component) => {
		if (!component._afterPaintQueued && (component._afterPaintQueued = true) && afterPaintEffects.push(component) === 1) {
			/* istanbul ignore next */
			if (options.requestAnimationFrame) {
				options.requestAnimationFrame(flushAfterPaintEffects);
			}
			else {
				requestAnimationFrame(scheduleFlushAfterPaint);
			}
		}
	};
}

function handleEffects(effects) {
	effects.forEach(invokeCleanup);
	effects.forEach(invokeEffect);
	return [];
}

function invokeCleanup(hook) {
	if (hook._cleanup) hook._cleanup();
}

/**
 * Invoke a Hook's effect
 * @param {import('./internal').EffectHookState} hook
 */
function invokeEffect(hook) {
	const result = hook._value();
	if (typeof result === 'function') hook._cleanup = result;
}

function argsChanged(oldArgs, newArgs) {
	return oldArgs == null || newArgs.some((arg, index) => arg !== oldArgs[index]);
}

function invokeOrReturn(arg, f) {
	return typeof f === 'function' ? f(arg) : f;
}
