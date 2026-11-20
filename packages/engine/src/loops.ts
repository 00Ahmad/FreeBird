/**
 * Noticing a bot going round in circles: the same call with the same result again and again (A, A, A), or the same
 * few calls in turn (A, B, A, B, A, B: back and forth between two pages, or a write and a read that never changes).
 */

/** The longest round of calls that counts as a circle. */
export const MAX_CYCLE = 3;

/** Signatures kept: enough to see the longest circle repeated. */
export const keptSignatures = (times: number) => MAX_CYCLE * times;

/**
 * Whether the newest calls are one round of 1 to MAX_CYCLE calls repeated `times` times in a row. A round of several
 * calls must hold more than one kind of call, so A, A, A, A, A, A is found as a round of one, not of two.
 */
export function goesRoundInCircles(signatures: readonly string[], times: number): boolean {
  for (let length = 1; length <= MAX_CYCLE; length++) {
    const span = length * times;
    if (signatures.length < span) return false;
    const tail = signatures.slice(-span);
    const round = tail.slice(0, length);
    if (length > 1 && new Set(round).size === 1) continue;
    if (tail.every((signature, index) => signature === round[index % length])) return true;
  }
  return false;
}
