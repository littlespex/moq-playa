/**
 * Error taxonomy tests — createPlayerError factory and types.
 *
 * @see draft-ietf-moq-transport-16 §13.4 (Error Codes)
 * @module
 */

import { describe, it, expect } from 'vitest';
import * as svta from '@svta/cml-error-codes';
import { createPlayerError, PlayerErrorCode, toSvtaErrorCode, type PlayerError } from './errors.js';

describe('Error Taxonomy', () => {
  it('createPlayerError produces well-formed error', () => {
    const err = createPlayerError(
      'fatal', 'connection', PlayerErrorCode.CONTROL_STREAM_LOST,
      'Control stream lost',
    );

    expect(err.severity).toBe('fatal');
    expect(err.source).toBe('connection');
    expect(err.code).toBe(PlayerErrorCode.CONTROL_STREAM_LOST);
    expect(err.message).toBe('Control stream lost');
    expect(err.timestampMs).toBeGreaterThan(0);
    expect(err.cause).toBeUndefined();
    expect(err.context).toBeUndefined();
  });

  it('stamps timestampMs automatically', () => {
    const before = Date.now();
    const err = createPlayerError(
      'transient', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR, 'test',
    );
    const after = Date.now();

    expect(err.timestampMs).toBeGreaterThanOrEqual(before);
    expect(err.timestampMs).toBeLessThanOrEqual(after);
  });

  it('passes through cause error', () => {
    const original = new Error('WebCodecs decode failed');
    const err = createPlayerError(
      'degraded', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
      'Video decode error',
      { cause: original },
    );

    expect(err.cause).toBe(original);
  });

  it('passes through context object', () => {
    const err = createPlayerError(
      'degraded', 'connection', PlayerErrorCode.DATA_STREAM_RESET,
      'Stream reset',
      { context: { streamId: 42n, errorCode: 0x1 } },
    );

    expect(err.context).toEqual({ streamId: 42n, errorCode: 0x1 });
  });

  it('error codes are in 0x1000+ range (no IANA collision)', () => {
    for (const [, code] of Object.entries(PlayerErrorCode)) {
      expect(code).toBeGreaterThanOrEqual(0x1000);
    }
  });

  it('error codes are unique', () => {
    const codes = Object.values(PlayerErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('MEDIA_STARVED lives in the connection block', () => {
    expect(PlayerErrorCode.MEDIA_STARVED).toBe(0x1005);
  });

  it('MEDIA_ELEMENT_WEDGED lives in the decoder block', () => {
    expect(PlayerErrorCode.MEDIA_ELEMENT_WEDGED).toBe(0x1102);
  });

  it('CODEC_UNSUPPORTED lives in the decoder block', () => {
    expect(PlayerErrorCode.CODEC_UNSUPPORTED).toBe(0x1103);
  });

  it('CMAF bootstrap codes live in the catalog block', () => {
    expect(PlayerErrorCode.CMAF_INIT_INVALID).toBe(0x1202);
    expect(PlayerErrorCode.CMAF_INIT_TIMEOUT).toBe(0x1203);
  });

  it('all severity values are valid', () => {
    const severities = ['transient', 'degraded', 'fatal'] as const;
    for (const severity of severities) {
      const err = createPlayerError(
        severity, 'player', PlayerErrorCode.CONTROL_STREAM_LOST, 'test',
      );
      expect(err.severity).toBe(severity);
    }
  });

  it('all source values are valid', () => {
    const sources = ['connection', 'pipeline', 'decoder', 'catalog', 'player', 'subscription'] as const;
    for (const source of sources) {
      const err = createPlayerError(
        'transient', source, PlayerErrorCode.CONTROL_STREAM_LOST, 'test',
      );
      expect(err.source).toBe(source);
    }
  });

  describe('SVTA2070 mapping', () => {
    const svtaConstants = new Map<number, string>();
    for (const [name, value] of Object.entries(svta)) {
      if (name.startsWith('SVTA_') && typeof value === 'number') svtaConstants.set(value, name);
    }

    it('every PlayerErrorCode maps to a named @svta/cml-error-codes constant', () => {
      for (const [name, code] of Object.entries(PlayerErrorCode)) {
        const mapped = toSvtaErrorCode(code);
        expect(svtaConstants.has(mapped), `${name} → ${mapped}`).toBe(true);
        // SVTA2070 category prefix: 1 media content, 2 playback, 3 network.
        expect(Math.floor(mapped / 1000), `${name} → ${mapped}`).toBeGreaterThanOrEqual(1);
        expect(Math.floor(mapped / 1000), `${name} → ${mapped}`).toBeLessThanOrEqual(3);
      }
    });

    it('maps the representative codes to their SVTA counterparts', () => {
      expect(toSvtaErrorCode(PlayerErrorCode.VIDEO_DECODE_ERROR)).toBe(svta.SVTA_VIDEO_DECODE_ERROR);
      expect(toSvtaErrorCode(PlayerErrorCode.AUDIO_DECODE_ERROR)).toBe(svta.SVTA_AUDIO_DECODE_ERROR);
      expect(toSvtaErrorCode(PlayerErrorCode.CATALOG_PARSE_ERROR)).toBe(svta.SVTA_MANIFEST_PARSE_ERROR);
      expect(toSvtaErrorCode(PlayerErrorCode.CODEC_UNSUPPORTED)).toBe(svta.SVTA_NO_MATCHING_CODEC);
      expect(toSvtaErrorCode(PlayerErrorCode.CONNECTION_LOST)).toBe(svta.SVTA_NO_NETWORK_CONNECTION);
      expect(toSvtaErrorCode(PlayerErrorCode.SUBSCRIPTION_REFUSED)).toBe(svta.SVTA_RESOURCE_DENIED);
      expect(toSvtaErrorCode(PlayerErrorCode.ALL_TRACKS_REFUSED)).toBe(svta.SVTA_MEDIA_UNAVAILABLE);
    });

    it('createPlayerError stamps svtaCode from the code', () => {
      const err = createPlayerError(
        'fatal', 'catalog', PlayerErrorCode.CMAF_INIT_INVALID, 'bad init',
      );
      expect(err.svtaCode).toBe(svta.SVTA_INITIALIZATION_SEGMENT_ERROR);
      expect(err.svtaCode).toBe(toSvtaErrorCode(err.code));
    });
  });
});
