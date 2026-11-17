/** Shared `@jsquash` glue for the decoder and the test-only encoders. */

/** An `@jsquash` `init` called with a compiled module. */
export type InitWithModule = (module: WebAssembly.Module) => Promise<unknown>;

/**
 * Every `@jsquash` codec's `init` accepts a `WebAssembly.Module` (see its decode.js /
 * encode.js), but the published typings only declare the options overload.
 */
export function initWithModule(init: unknown): InitWithModule {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS accepts a Module; the .d.ts omits that overload
	return init as InitWithModule;
}
