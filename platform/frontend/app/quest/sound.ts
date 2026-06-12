/**
 * Coin chime — WebAudio synthesis, no assets, ported verbatim-adapted from
 * design/player/prototype.jsx. Two triangle notes (B5, E6) with a fast decay.
 */
let ctx: AudioContext | null = null;

export function coinChime(): void {
  try {
    ctx = ctx ?? new AudioContext();
    [987.77, 1318.5].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const at = ctx!.currentTime + i * 0.085;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    // No sound is never an error.
  }
}
