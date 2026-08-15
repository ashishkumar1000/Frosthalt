/**
 * TurboModule TS spec for NativeConfigStore (Story 1.4).
 *
 * This file is BOTH the codegen input and the JS-side contract. App-level
 * codegen (see `codegenConfig` in package.json: name `FrosthaltSpecs`,
 * type `modules`, jsSrcsDir `src/native/specs`) reads this spec and generates
 * the native `<NativeConfigStoreSpec>` protocol header that the Obj-C++ glue
 * in `macos/Frosthalt-macOS/NativeConfigStore.mm` conforms to.
 *
 * The native module is a DUMB STRING-FILE ADAPTER (AD-11): it knows nothing
 * about the config shape and does not parse/validate JSON. `readConfig`
 * returns the raw file string (data null/absent when the file is missing);
 * `writeConfig(json)` writes the given string atomically. JSON parse +
 * serialize + missing/corrupt -> empty resilience live in the typed JS port
 * `src/config/configStore.ts`.
 *
 * Every native method returns the uniform `{ ok, error?, data? }` envelope
 * over JSI (AC 4, Consistency Conventions / Error shape).
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Uniform result envelope for every native ConfigStore call (AC 4).
 *
 * - `ok` is always present.
 * - `error` is present only when `ok === false` (a short human/readable
 *   reason; not localised in v1).
 * - `data` is the raw file string on a successful `readConfig`; absent/null
 *   when the file is missing. Absent on `writeConfig` (no payload).
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility:
 * codegen treats an exported object type alias as a value struct and emits
 * the matching native record/protocol.
 */
export type ConfigResult = {
  ok: boolean;
  error?: string;
  data?: string;
};

export interface Spec extends TurboModule {
  /**
   * Reads `~/Library/Application Support/Frosthalt/config.json` and returns
   * its raw contents. Returns `{ ok: true, data: null }` (data absent) when
   * the file is missing — that is NOT an error. Returns `{ ok: false, error }`
   * on an unrecoverable IO error. Never parses JSON.
   */
  readConfig(): ConfigResult;
  /**
   * Atomically writes the given string to config.json (temp file + rename),
   * creating the `Frosthalt` directory if absent. Returns `{ ok: true }` on
   * success or `{ ok: false, error }` on an IO error (target file unchanged,
   * temp discarded). Never parses or validates the string.
   */
  writeConfig(json: string): ConfigResult;
}

/**
 * JS-side handle to the native module. `getEnforcing` throws if the module is
 * not registered in the native binary — that is a build/link failure, not a
 * runtime user error, and is the right thing to surface loudly.
 */
export default TurboModuleRegistry.getEnforcing<Spec>('NativeConfigStore');
