/**
 * BufferBasedController — hybrid ABR using buffer depth as the primary
 * signal and a throughput estimate as a secondary corroboration signal.
 *
 * Buffer depth directly measures stall risk (the thing we care about).
 * Throughput measures the link (a proxy for stall risk that can be noisy
 * on bursty networks). Combining them:
 *
 *   buffer < LOW  → downshift immediately (emergency, throughput irrelevant)
 *   buffer in [LOW, HIGH] → hold steady (buffer is fine, don't react to noise)
 *   buffer > HIGH AND throughput sustains a higher rung → upshift (both agree)
 *   buffer > HIGH AND throughput insufficient → hold (don't burn buffer)
 *
 * The buffer policy is Playa's. The "does the throughput sustain a higher
 * rung" question is answered by `@svta/cml-abr`'s rate-based selector
 * (createThroughputSelector): it picks the highest rung whose bandwidth fits
 * `throughput * safetyFactor`, and demands `throughput * upgradeFactor` for a
 * rung above the current one. `upshiftBandwidthMultiple` (default 2.25) maps
 * onto that upgrade factor as `1 / multiple`, so the former rule
 * "throughput > next.bitrate × 2.25" is preserved exactly.
 *
 * Unit adaptation: cml-abr ladders ascend with `bandwidth` in bits per
 * second and a buffer level in seconds; Playa's ladder is highest-first with
 * `bitrateKbps` and a buffer depth in microseconds. Playa index `i` is
 * cml-abr rung `ladder.length - 1 - i`.
 *
 * Evaluate-then-commit: {@link evaluate} never mutates the index; the player
 * calls {@link commitUpshift} / {@link commitDownshift} once a switch has
 * actually completed.
 *
 * @module
 */

import { createThroughputSelector, DEFAULT_SAFETY_FACTOR, type BitrateSelector, type LadderRung } from '@svta/cml-abr';
import type { ClockSource } from './types.js';

/** One entry in the ABR quality ladder. */
export interface AbrTrack {
    readonly name: string;
    readonly bitrateKbps: number;
}

/** Configuration for the buffer-based controller. */
export interface BufferBasedConfig {
    readonly clock: ClockSource;
    /** Quality ladder sorted highest-bitrate-first (index 0 = best). */
    readonly ladder: readonly AbrTrack[];
    /** Starting index into the ladder. */
    readonly initialIndex: number;
    /** Buffer depth below this → emergency downshift (µs). */
    readonly lowThresholdUs: number;
    /** Buffer depth above this → consider upshift (µs). */
    readonly highThresholdUs: number;
    /** Throughput must exceed this multiple of the target track's bitrate
     *  for an upshift to be approved. Default 2.25. */
    readonly upshiftBandwidthMultiple?: number;
}

/** Input signals for an ABR evaluation. */
export interface AbrSignals {
    /** Current buffer depth in microseconds. */
    readonly bufferDepthUs: number;
    /** Throughput estimate in kbps (0 = unknown). */
    readonly bandwidthEstimateKbps: number;
}

/** ABR decision. */
export interface AbrDecision {
    readonly action: 'downshift' | 'upshift' | 'hold';
    /** Target ladder index (only set for downshift/upshift). */
    readonly targetIndex?: number;
}

/**
 * Bandwidth (bps) given to cml-abr for a track with no usable bitrate. The
 * selector requires a positive finite bandwidth per rung; 1 bps keeps the
 * former semantics for such tracks (any throughput > 0 "sustains" them).
 */
const UNKNOWN_BITRATE_BPS = 1;

export class BufferBasedController {
    private readonly clock: ClockSource;
    private readonly ladder: readonly AbrTrack[];
    readonly lowThresholdUs: number;
    /** Kept for future temporal-buffer mode (playout buffer, not jitter buffer). */
    readonly highThresholdUs: number;
    private readonly upshiftMultiple: number;
    /** The ladder as cml-abr sees it: ascending, bits per second. */
    private readonly rungs: readonly LadderRung[];
    private readonly selector: BitrateSelector;
    private currentIndex: number;

    constructor(config: BufferBasedConfig) {
        this.clock = config.clock;
        this.ladder = config.ladder;
        this.lowThresholdUs = config.lowThresholdUs;
        this.highThresholdUs = config.highThresholdUs;
        this.upshiftMultiple = config.upshiftBandwidthMultiple ?? 2.25;
        this.currentIndex = config.initialIndex;
        this.rungs = [...config.ladder].reverse().map((track) => ({
            bandwidth: track.bitrateKbps > 0 ? track.bitrateKbps * 1000 : UNKNOWN_BITRATE_BPS,
        }));
        // cml-abr wants 0 < upgradeFactor <= safetyFactor <= 1.
        const upgradeFactor = Math.min(1, 1 / this.upshiftMultiple);
        this.selector = createThroughputSelector({
            safetyFactor: Math.max(DEFAULT_SAFETY_FACTOR, upgradeFactor),
            upgradeFactor,
        });
    }

    /** Current ladder index. */
    get index(): number { return this.currentIndex; }

    /** Current track. */
    get currentTrack(): AbrTrack | undefined { return this.ladder[this.currentIndex]; }

    /** cml-abr rung position of a Playa ladder index. */
    private rungOf(index: number): number {
        return this.ladder.length - 1 - index;
    }

    /**
     * Ask cml-abr which rung the throughput sustains from the current one.
     *
     * The selector learns the current rung from `sample()` (there is no other
     * way to declare it), so a bandwidth-only sample with no timing precedes
     * each pick. Returns the current rung when the ladder cannot be evaluated.
     */
    private sustainableRung(throughputKbps: number, bufferDepthUs: number): number {
        const current = this.rungOf(this.currentIndex);
        try {
            this.selector.sample({
                timing: { startTime: 0, encodedBodySize: 0, duration: 0 },
                bandwidth: this.rungs[current]!.bandwidth,
                duration: 0,
                bufferLevel: bufferDepthUs / 1_000_000,
            });
            return this.selector.select({
                ladder: this.rungs,
                bufferLevel: bufferDepthUs / 1_000_000,
                throughput: throughputKbps * 1000,
                now: this.clock.now() / 1000,
            }).index;
        } catch {
            return current; // a ladder cml-abr rejects (not ascending) cannot corroborate an upshift
        }
    }

    /**
     * Evaluate buffer depth + throughput and return an ABR recommendation.
     *
     * Does NOT mutate internal state — the caller must call
     * {@link commitDownshift} or {@link commitUpshift} after a
     * confirmed switch. This prevents index drift when async switches
     * fail or are aborted.
     */
    evaluate(signals: AbrSignals): AbrDecision {
        // Emergency: buffer critically low → recommend downshift
        if (signals.bufferDepthUs < this.lowThresholdUs) {
            if (this.currentIndex < this.ladder.length - 1) {
                return { action: 'downshift', targetIndex: this.currentIndex + 1 };
            }
            return { action: 'hold' }; // already at lowest
        }

        // Upshift: buffer must be above the high threshold — asymmetric
        // hysteresis so upshift is much harder to trigger than downshift.
        // AND the throughput must corroborate (unknown throughput never does).
        // The player switches one level at a time, so a pick several rungs
        // up still recommends the next-higher track only.
        if (this.currentIndex > 0 && signals.bufferDepthUs >= this.highThresholdUs
            && signals.bandwidthEstimateKbps > 0) {
            const pick = this.sustainableRung(signals.bandwidthEstimateKbps, signals.bufferDepthUs);
            if (pick > this.rungOf(this.currentIndex)) {
                return { action: 'upshift', targetIndex: this.currentIndex - 1 };
            }
        }

        return { action: 'hold' };
    }

    /** Confirm a downshift — advances index to the lower track. */
    commitDownshift(): void {
        if (this.currentIndex < this.ladder.length - 1) this.currentIndex++;
    }

    /** Confirm an upshift — moves index to the higher track. */
    commitUpshift(): void {
        if (this.currentIndex > 0) this.currentIndex--;
    }

    /** Reset to a specific ladder index (e.g., after manual selection). */
    setIndex(index: number): void {
        this.currentIndex = Math.max(0, Math.min(index, this.ladder.length - 1));
    }
}
