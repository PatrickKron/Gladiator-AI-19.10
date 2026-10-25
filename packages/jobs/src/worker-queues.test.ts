import { describe, expect, it } from 'vitest';
import { CANDLE_REFRESH_JOB, FAST_QUEUE_NAME, FAST_SCHEDULES, MONITOR_JOB, QUEUE_NAME, SCHEDULES } from './worker.js';

/**
 * Positions-Monitor (SL/TP, Trailing, Notfall) darf nie hinter CPU-schweren
 * Jobs (RL-Episoden, ML-Retrain, Optimierung) warten → eigene Queue + Worker.
 */
describe('Job-Queues', () => {
  it('Monitor läuft in der eigenen schnellen Queue, nicht in der Haupt-Queue', () => {
    expect(FAST_QUEUE_NAME).not.toBe(QUEUE_NAME);
    expect(FAST_SCHEDULES.map(([n]) => n)).toEqual([MONITOR_JOB]);
    expect(SCHEDULES.map(([n]) => n)).not.toContain(MONITOR_JOB);
  });

  it('Monitor tickt jede Minute', () => {
    expect(FAST_SCHEDULES.find(([n]) => n === MONITOR_JOB)?.[1]).toBe(60_000);
  });

  it('Kerzen-Refresh des Asset-Registers läuft alle 15 min in der Haupt-Queue', () => {
    expect(SCHEDULES.find(([n]) => n === CANDLE_REFRESH_JOB)?.[1]).toBe(15 * 60_000);
  });

  it('kein Job ist doppelt eingeplant', () => {
    const names = [...SCHEDULES, ...FAST_SCHEDULES].map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });
});
