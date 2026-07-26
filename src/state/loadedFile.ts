import type { LoadedFile } from "./workspace";
import type { WorkerResponse } from "../worker/messages";

/** The worker's `parsed` message. */
type ParsedMessage = Extract<WorkerResponse, { type: "parsed" }>;

/**
 * The optional format-detection fields a `parsed` message carries through to
 * the stored {@link LoadedFile}. Both sides declare them optional, so they are
 * copied only when present — an explicit `undefined` would make
 * `"dateFormat" in file` true and read as "detected: nothing" rather than
 * "not detected".
 *
 * Listed once here because the two interfaces are structurally parallel: a new
 * detection added to the worker has to appear in `LoadedFile`, in
 * `ParsedMessage`, and in this list, and forgetting the third silently drops it
 * on the floor. The `satisfies` below makes that a compile error instead.
 */
const CARRIED_FIELDS = [
  "report",
  "placeLayout",
  "dateFormat",
  "datePlaceholder",
  "sourceLayout",
  "detectedFormats",
  "pageMediaStyle",
  "nameLayout",
  "unknownNameStyle",
  "marriedNameTag",
  "coordUsage",
] as const satisfies readonly (keyof LoadedFile & keyof ParsedMessage)[];

/**
 * Build the workspace's `LoadedFile` from a worker `parsed` message, carrying
 * across every detection the message actually reported and omitting the rest.
 */
export function loadedFileFromParsed(msg: ParsedMessage): LoadedFile {
  const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
  for (const key of CARRIED_FIELDS) {
    const value = msg[key];
    // Falsy detections are omitted deliberately: the worker sends "" / false /
    // undefined for "no convention detected", and the UI tests these fields for
    // presence rather than value.
    if (value) (file[key] as unknown) = value;
  }
  return file;
}
