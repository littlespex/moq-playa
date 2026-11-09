/**
 * Error taxonomy — structured error classification for the player.
 *
 * Classifies all errors by severity (transient/degraded/fatal),
 * source (connection/pipeline/decoder/catalog/player/subscription), and numeric code.
 *
 * Error codes use 0x1000+ range to avoid collision with IANA-assigned
 * MOQT error codes (§13.4) which live in 0x0–0xFFF.
 *
 * Each code also maps to the closest SVTA2070 (Common Media Library) error
 * code through {@link toSvtaErrorCode}, so applications that aggregate errors
 * from several players can classify Playa errors alongside everything else.
 *
 * @see draft-ietf-moq-transport-16 §13.4 (IANA Error Codes)
 * @see https://github.com/streaming-video-technology-alliance/common-media-library (cml-error-codes)
 * @module
 */

import {
  SVTA_BUFFER_NUDGE_ON_STALL,
  SVTA_BUFFER_SEEK_OVER_HOLE,
  SVTA_AUDIO_DECODE_ERROR,
  SVTA_DOWNLOAD_ERROR,
  SVTA_FRAGMENT_TIMEOUT_ERROR,
  SVTA_INITIALIZATION_SEGMENT_ERROR,
  SVTA_LIVE_TIMESHIFT_OUT_OF_BOUNDS,
  SVTA_MANIFEST_PARSE_ERROR,
  SVTA_MEDIA_UNAVAILABLE,
  SVTA_NETWORK_UNKNOWN,
  SVTA_NO_MATCHING_CODEC,
  SVTA_NO_NETWORK_CONNECTION,
  SVTA_PRIMARY_MANIFEST_LOAD_TIMEOUT,
  SVTA_RESOURCE_DENIED,
  SVTA_SECONDARY_MANIFEST_PARSE_ERROR,
  SVTA_SEGMENT_PARSE_ERROR,
  SVTA_TRACK_LOAD_ERROR,
  SVTA_VIDEO_DECODE_ERROR,
  type SvtaErrorCode,
} from '@svta/cml-error-codes';

// ─── Severity ─────────────────────────────────────────────────────────

/**
 * How bad is it?
 *
 * - `transient`: Momentary glitch, self-recoverable (e.g., single datagram decode error).
 * - `degraded`: Quality or functionality reduced but playback continues (e.g., data stream reset).
 * - `fatal`: Playback cannot continue (e.g., control stream lost).
 */
export type ErrorSeverity = 'transient' | 'degraded' | 'fatal';

// ─── Source ───────────────────────────────────────────────────────────

/**
 * Where did the error originate?
 *
 * - `connection`: Network/protocol layer (MoqtConnection).
 * - `pipeline`: Playback pipeline (jitter buffer, gap detection, sync).
 * - `decoder`: Browser decoder (WebCodecs VideoDecoder/AudioDecoder).
 * - `catalog`: Catalog parsing (MSF catalog or delta update).
 * - `player`: Player lifecycle (load, destroy, state machine).
 * - `subscription`: Media track subscription refusal.
 */
export type ErrorSource = 'connection' | 'pipeline' | 'decoder' | 'catalog' | 'player' | 'subscription';

// ─── Error Codes ──────────────────────────────────────────────────────

/**
 * Structured error codes in the 0x1000+ range.
 *
 * Organized by source:
 * - 0x1000–0x10FF: Connection errors
 * - 0x1100–0x11FF: Decoder errors
 * - 0x1200–0x12FF: Catalog errors
 * - 0x1300–0x13FF: Player errors
 * - 0x1400–0x14FF: Pipeline errors
 */
export const PlayerErrorCode = {
  // ── Connection (0x1000) ───────────────────────────────────
  /** Control stream lost — session is dead. @see §3.2 */
  CONTROL_STREAM_LOST: 0x1000,
  /** Data stream reset by publisher. @see §10.4 */
  DATA_STREAM_RESET: 0x1001,
  /** Datagram decode error (unreliable, non-fatal). @see §10.3 */
  DATAGRAM_DECODE_ERROR: 0x1002,
  /** WebTransport connection lost. */
  CONNECTION_LOST: 0x1003,
  /** REQUEST_UPDATE failed — forward state change not sent. @see §9.11 */
  REQUEST_UPDATE_FAILED: 0x1004,
  /** Media delivery starved and the restart ladder was exhausted. */
  MEDIA_STARVED: 0x1005,

  // ── Decoder (0x1100) ──────────────────────────────────────
  /** Video decoder error (WebCodecs). */
  VIDEO_DECODE_ERROR: 0x1100,
  /** Audio decoder error (WebCodecs). */
  AUDIO_DECODE_ERROR: 0x1101,
  /**
   * MSE media element wedged beyond recovery (Safari frozen-playhead class):
   * the adapter's nudge/pulse/seek ladder was exhausted — the MediaSource
   * must be rebuilt (fresh tune-in). Fatal.
   */
  MEDIA_ELEMENT_WEDGED: 0x1102,
  /**
   * Buffered-gap recovery was unrecoverable. Two conditions share this
   * code (the error message distinguishes them): a buffered hole exceeded
   * the MSE adapter's bounded-skip policy and persisted at the playhead,
   * or a bounded skip was performed but its landing never resumed
   * playback. Either way the stream cannot proceed; the MediaSource must
   * be rebuilt (fresh tune-in). Fatal.
   */
  MEDIA_GAP_UNRECOVERABLE: 0x1104,
  /**
   * MediaSource.isTypeSupported() rejected a selected track's codec string —
   * MSE cannot be configured on this UA. Fatal.
   */
  CODEC_UNSUPPORTED: 0x1103,

  // ── Catalog (0x1200) ──────────────────────────────────────
  /** Initial catalog parse failed — cannot proceed. @see MSF §5.1 */
  CATALOG_PARSE_ERROR: 0x1200,
  /** Delta catalog update failed — degraded. @see MSF §5.2 */
  CATALOG_DELTA_ERROR: 0x1201,
  /**
   * A selected CMAF track's bootstrap metadata is invalid: codec string
   * missing, or inline initData that is not valid base64 / decodes to zero
   * bytes. Detected BEFORE any media SUBSCRIBE is issued. Fatal.
   * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers)
   */
  CMAF_INIT_INVALID: 0x1202,
  /**
   * CMAF bootstrap deadline expired: media objects are arriving but no init
   * segment materialized from initData/initTrack/in-band ftyp+moov within
   * cmafBootstrapTimeoutMs — or MSE initialized but no frame rendered.
   * Fatal.
   */
  CMAF_INIT_TIMEOUT: 0x1203,
  /** Catalog delivery is still pending after the diagnostic deadline; nonfatal. */
  CATALOG_WAIT_TIMEOUT: 0x1204,

  // ── Playback (0x1300) ────────────────────────────────────
  /** Seek failed — timeline lookup or REQUEST_UPDATE error. @see MSF §7 */
  SEEK_FAILED: 0x1300,

  /** Media track subscription failed during load (subscribeToMediaTracks rejection). */
  LOAD_FAILED: 0x1301,
  /** Media track subscription refused by relay (REQUEST_ERROR). @see §9.8 */
  SUBSCRIPTION_REFUSED: 0x1302,
  /** All media track subscriptions refused — no playable content. @see §9.8 */
  ALL_TRACKS_REFUSED: 0x1303,
  // 0x1400 reserved: BUFFER_OVERFLOW (when pipeline backpressure lands)
} as const;

/** Type of a PlayerErrorCode value. */
export type PlayerErrorCodeValue = typeof PlayerErrorCode[keyof typeof PlayerErrorCode];

// ─── SVTA2070 mapping ─────────────────────────────────────────────────

/**
 * Closest SVTA2070 error code for every {@link PlayerErrorCode}.
 *
 * The Playa codes stay in the 0x1000+ range (they must not collide with the
 * IANA MoQT codes); this table is a one-way projection onto the SVTA
 * categories (1xxx media content, 2xxx playback, 3xxx network) for
 * cross-player error reporting. Several Playa codes legitimately share one
 * SVTA code because SVTA2070 has no finer distinction.
 */
const SVTA_ERROR_CODE_BY_PLAYER_CODE: Readonly<Record<PlayerErrorCodeValue, SvtaErrorCode>> = {
  // Connection — the MoQT session or a delivery stream failed.
  [PlayerErrorCode.CONTROL_STREAM_LOST]: SVTA_NO_NETWORK_CONNECTION,
  [PlayerErrorCode.DATA_STREAM_RESET]: SVTA_DOWNLOAD_ERROR,
  [PlayerErrorCode.DATAGRAM_DECODE_ERROR]: SVTA_SEGMENT_PARSE_ERROR,
  [PlayerErrorCode.CONNECTION_LOST]: SVTA_NO_NETWORK_CONNECTION,
  [PlayerErrorCode.REQUEST_UPDATE_FAILED]: SVTA_NETWORK_UNKNOWN,
  [PlayerErrorCode.MEDIA_STARVED]: SVTA_FRAGMENT_TIMEOUT_ERROR,
  // Decoder / media element.
  [PlayerErrorCode.VIDEO_DECODE_ERROR]: SVTA_VIDEO_DECODE_ERROR,
  [PlayerErrorCode.AUDIO_DECODE_ERROR]: SVTA_AUDIO_DECODE_ERROR,
  [PlayerErrorCode.MEDIA_ELEMENT_WEDGED]: SVTA_BUFFER_NUDGE_ON_STALL,
  [PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE]: SVTA_BUFFER_SEEK_OVER_HOLE,
  [PlayerErrorCode.CODEC_UNSUPPORTED]: SVTA_NO_MATCHING_CODEC,
  // Catalog — the MSF catalog is Playa's manifest.
  [PlayerErrorCode.CATALOG_PARSE_ERROR]: SVTA_MANIFEST_PARSE_ERROR,
  [PlayerErrorCode.CATALOG_DELTA_ERROR]: SVTA_SECONDARY_MANIFEST_PARSE_ERROR,
  [PlayerErrorCode.CMAF_INIT_INVALID]: SVTA_INITIALIZATION_SEGMENT_ERROR,
  [PlayerErrorCode.CMAF_INIT_TIMEOUT]: SVTA_INITIALIZATION_SEGMENT_ERROR,
  [PlayerErrorCode.CATALOG_WAIT_TIMEOUT]: SVTA_PRIMARY_MANIFEST_LOAD_TIMEOUT,
  // Playback / subscription.
  [PlayerErrorCode.SEEK_FAILED]: SVTA_LIVE_TIMESHIFT_OUT_OF_BOUNDS,
  [PlayerErrorCode.LOAD_FAILED]: SVTA_TRACK_LOAD_ERROR,
  [PlayerErrorCode.SUBSCRIPTION_REFUSED]: SVTA_RESOURCE_DENIED,
  [PlayerErrorCode.ALL_TRACKS_REFUSED]: SVTA_MEDIA_UNAVAILABLE,
};

/**
 * Map a Playa error code to the closest SVTA2070 error code.
 *
 * Pure and total over {@link PlayerErrorCodeValue}; every Playa code has an
 * entry, so the result is always one of the named `@svta/cml-error-codes`
 * constants.
 */
export function toSvtaErrorCode(code: PlayerErrorCodeValue): SvtaErrorCode {
  return SVTA_ERROR_CODE_BY_PLAYER_CODE[code];
}

// ─── PlayerError ──────────────────────────────────────────────────────

/**
 * Structured player error — all errors flow through this type.
 *
 * Application code can switch on `severity` for recovery decisions,
 * `source` for routing to the right handler, and `code` for
 * specific error identification.
 */
export interface PlayerError {
  /** How bad is it? */
  readonly severity: ErrorSeverity;
  /** Where did it come from? */
  readonly source: ErrorSource;
  /** Numeric code for programmatic matching. */
  readonly code: PlayerErrorCodeValue;
  /**
   * Closest SVTA2070 error code for {@link code} (see {@link toSvtaErrorCode}).
   * Always set by {@link createPlayerError}; optional only so hand-built
   * PlayerError values from before this field existed remain valid.
   */
  readonly svtaCode?: SvtaErrorCode;
  /** Human-readable description. */
  readonly message: string;
  /** Original error, if wrapping. */
  readonly cause?: Error;
  /** When it happened (ms since epoch). */
  readonly timestampMs: number;
  /** Additional context (streamId, errorCode, mediaType, etc.). */
  readonly context?: Record<string, unknown>;
}

// ─── Factory ──────────────────────────────────────────────────────────

/**
 * Create a well-formed PlayerError.
 *
 * Stamps `timestampMs` and the SVTA2070 `svtaCode` automatically. Accepts
 * optional `cause` and `context`.
 */
export function createPlayerError(
  severity: ErrorSeverity,
  source: ErrorSource,
  code: PlayerErrorCodeValue,
  message: string,
  options?: { cause?: Error; context?: Record<string, unknown> },
): PlayerError {
  return {
    severity,
    source,
    code,
    svtaCode: toSvtaErrorCode(code),
    message,
    ...(options?.cause ? { cause: options.cause } : {}),
    timestampMs: Date.now(),
    ...(options?.context ? { context: options.context } : {}),
  };
}
