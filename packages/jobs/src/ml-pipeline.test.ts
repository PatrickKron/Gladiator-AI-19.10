import { describe, it, expect } from 'vitest';
import { computeAllFeatures, autoLabelSignals, retrainModel } from './ml-pipeline.js';

// These functions require a live DB connection.
// Unit tests verify the export shape; integration tests run on the server.

describe('ml-pipeline exports', () => {
  it('computeAllFeatures is a function', () => {
    expect(typeof computeAllFeatures).toBe('function');
  });

  it('autoLabelSignals is a function', () => {
    expect(typeof autoLabelSignals).toBe('function');
  });

  it('retrainModel is a function', () => {
    expect(typeof retrainModel).toBe('function');
  });
});
