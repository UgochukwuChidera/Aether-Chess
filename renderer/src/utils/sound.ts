/**
 * Sound utilities using Web Audio API - synthesized chess sounds.
 * No external audio files needed.
 */
import { useSettingsStore } from '../stores/settingsStore';

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.3): void {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

export const Sound = {
  move: () => {
    if (!useSettingsStore.getState().soundEnabled) return;
    playTone(440, 0.1, 'sine', 0.15);
  },

  capture: () => {
    if (!useSettingsStore.getState().soundEnabled) return;
    playTone(220, 0.15, 'square', 0.12);
    setTimeout(() => playTone(180, 0.1, 'square', 0.08), 50);
  },

  check: () => {
    if (!useSettingsStore.getState().soundEnabled) return;
    playTone(880, 0.2, 'square', 0.2);
    setTimeout(() => playTone(660, 0.3, 'square', 0.2), 150);
  },

  checkmate: () => {
    if (!useSettingsStore.getState().soundEnabled) return;
    const freqs = [523, 659, 784, 1047];
    freqs.forEach((f, i) => {
      setTimeout(() => playTone(f, 0.25, 'square', 0.25), i * 180);
    });
  },

  illegal: () => {
    if (!useSettingsStore.getState().soundEnabled) return;
    playTone(150, 0.15, 'sawtooth', 0.15);
  },
};