import type { MoveProviderFactory } from './move-provider';
import { createStockfishProvider } from './stockfish-provider';

/**
 * Which opponent `/play` gets. The one place that decides.
 *
 * It is a single line today because Stockfish is the only provider built. ADR 0005 adds Maia v1
 * below Stockfish's 1320 floor, and when it lands the choice is made here — keyed on the rung,
 * once, at the top of the stack. `use-engine` learns nothing either way; that is what the seam
 * in move-provider.ts is for.
 */
export const createDefaultProvider: MoveProviderFactory = createStockfishProvider;
