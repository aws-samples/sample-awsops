/**
 * StatCard — thin alias re-exporting StatTile for prop compatibility with
 * existing call sites that pass `{ label, value, accent? }`. New code should
 * import StatTile directly.
 */
export { default } from './StatTile';
export type { StatTileProps, StatTileVariant } from './StatTile';
