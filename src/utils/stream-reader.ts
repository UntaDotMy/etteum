/**
 * The reader type that `ReadableStream<Uint8Array>.getReader()` actually
 * returns in this runtime.
 *
 * why: `@types/node` (pulled in transitively) and `bun-types` both declare a
 * global `ReadableStreamDefaultReader`, and node's lacks Bun's `readMany`.
 * Annotating a variable with the bare global name picks whichever declaration
 * won resolution, which then mismatches the value tsc infers from getReader()
 *TS2741 "Property 'readMany' is missing" at every stream seam. Deriving the
 * type from getReader() itself is always the runtime-correct one.
 */
export type Utf8StreamReader = ReturnType<ReadableStream<Uint8Array>["getReader"]>;
