/**
 * Coin chimes — WebAudio synthesis, no assets, ported verbatim-adapted from
 * design/player/prototype.jsx. Gain: two ascending triangle notes (B5, E6);
 * spend: the same pair descending and quieter. Fast decay in both.
 */
let ctx: AudioContext | null = null;

function chime(freqs: [number, number], peak: number): void {
  try {
    ctx = ctx ?? new AudioContext();
    freqs.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const at = ctx!.currentTime + i * 0.085;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    // No sound is never an error.
  }
}

export function coinChime(): void {
  chime([987.77, 1318.5], 0.12);
}

/** Coin spend (hint purchase): descending, softer than the gain chime. */
export function spendChime(): void {
  chime([1318.5, 987.77], 0.08);
}
