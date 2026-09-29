/**
 * The opening tutor: explanations computed from stored engine facts and authored plans, with no
 * model call. See docs/adr/0008-computed-tutor-and-learn-mode.md.
 *
 * Browser-safe: nothing here imports the ECO book or `node:` modules.
 */

export * from './boundary';
export * from './detectors';
export * from './explain';
export type * from './types';
export * from './library';
