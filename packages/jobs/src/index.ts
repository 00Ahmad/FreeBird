/**
 * @mrog/jobs: the Job Bot's logic as plain functions. No server, database, browser or Electron code: the harness
 * wires these to the outside world (a test checks nothing here imports it).
 */
export * from "./dedupe";
export * from "./ladder";
export * from "./leads";
export * from "./learn";
export * from "./links";
export * from "./match";
export type * from "./page";
export * from "./profile";
export * from "./searches";
export * from "./source-check";
export * from "./sources";
export * from "./text";
export * from "./warnings";
