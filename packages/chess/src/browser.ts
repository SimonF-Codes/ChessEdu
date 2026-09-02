/**
 * The half of this package a browser can have.
 *
 * The default entry point also exports `link.ts`, which needs `node:crypto` — `randomBytes`
 * for the nonce and `timingSafeEqual` for comparing it, neither of which has a browser
 * equivalent worth faking. Bundling that into a client component fails the build, so client
 * code imports `@chessedu/chess/browser` and gets only what is portable.
 *
 * Everything here is pure. That is not a coincidence: the parts that are safe in a browser and
 * the parts that are I/O-free are the same parts.
 */

export * from './bot';
export * from './recommend';
export * from './classify';
export * from './outcome';
export * from './phase';
export * from './uci';
