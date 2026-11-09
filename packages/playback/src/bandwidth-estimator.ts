/**
 * BandwidthEstimator — throughput estimation from group transfer times,
 * backed by `@svta/cml-throughput`'s EwmaEstimator.
 *
 * MoQ/QUIC has no HTTP request/response cycle to time, but each group's
 * subgroup stream still has a first byte and a last byte. The sample fed to
 * the estimator is the group's bytes over that transfer time:
 *
 *   instantaneous_bps = group_bytes * 8 / (last_byte_us - first_byte_us)
 *
 * Earlier versions divided by the gap between group arrivals instead. In live
 * delivery that gap is the encoder's group cadence, so the quotient converged
 * on the current track's bitrate and could never show headroom for an upshift,
 * while a pause between groups looked like a bandwidth collapse. The transfer
 * time measures the link whenever a group is sent faster than real time
 * (catch-up, a joining fetch, a relay flushing a buffered group). A group the
 * publisher paces at real time still measures only the track's own bitrate,
 * which is a floor on capacity rather than the capacity itself; see
 * docs/cml-adoption.md for why that is a MoQ-specific gap in CML's model.
 *
 * EwmaEstimator weights each sample by its transfer duration and reports the
 * lower of a fast and a slow half-life average (shaka-player's scheme), so a
 * burst of short samples cannot swing the estimate as one long one can.
 *
 * @module
 */

import { EwmaEstimator } from '@svta/cml-throughput';

/** Tuning for {@link BandwidthEstimator}. The defaults follow shaka-player. */
export interface BandwidthEstimatorOptions {
    /** Half-life of the fast average, in seconds of transfer time. Default 2. */
    readonly fastHalfLifeSec?: number;
    /** Half-life of the slow average, in seconds of transfer time. Default 5. */
    readonly slowHalfLifeSec?: number;
    /**
     * Bytes that must be sampled before {@link BandwidthEstimator.getEstimateKbps}
     * reports a measurement instead of 0. Default 128_000.
     */
    readonly minTotalBytes?: number;
    /** Smallest group, in bytes, that counts as a sample. Default 16_000. */
    readonly minGroupBytes?: number;
    /**
     * Shortest transfer, in microseconds, that counts as a sample. A group
     * that lands within a few milliseconds says nothing about the link.
     * Default 5_000 (5 ms).
     */
    readonly minTransferUs?: number;
}

export class BandwidthEstimator {
    private readonly options: Required<BandwidthEstimatorOptions>;
    private estimator: EwmaEstimator;

    constructor(options: BandwidthEstimatorOptions = {}) {
        this.options = {
            fastHalfLifeSec: options.fastHalfLifeSec ?? 2,
            slowHalfLifeSec: options.slowHalfLifeSec ?? 5,
            minTotalBytes: options.minTotalBytes ?? 128_000,
            minGroupBytes: options.minGroupBytes ?? 16_000,
            minTransferUs: options.minTransferUs ?? 5_000,
        };
        this.estimator = this.createEstimator();
    }

    private createEstimator(): EwmaEstimator {
        const o = this.options;
        return new EwmaEstimator({
            fastHalfLife: o.fastHalfLifeSec,
            slowHalfLife: o.slowHalfLifeSec,
            minTotalBytes: o.minTotalBytes,
            minBodySize: o.minGroupBytes,
            minTransferDuration: o.minTransferUs / 1000,
            defaultEstimate: 0,
        });
    }

    /**
     * Record a completed group transfer. Call once per group, when the stream
     * that carried it has finished.
     *
     * @param bytes Total bytes of the group.
     * @param firstByteUs Clock time (µs) at which the group's stream delivered
     *                    its first byte (its header).
     * @param lastByteUs Clock time (µs) at which the stream finished.
     */
    recordGroup(bytes: number, firstByteUs: number, lastByteUs: number): void {
        this.estimator.sample({
            startTime: firstByteUs / 1000,
            encodedBodySize: bytes,
            duration: (lastByteUs - firstByteUs) / 1000,
        });
    }

    /**
     * Current smoothed throughput estimate in kbps.
     * Returns 0 until `minTotalBytes` have been sampled.
     */
    getEstimateKbps(): number {
        const bps = this.estimator.getEstimate();
        return Number.isFinite(bps) && bps > 0 ? bps / 1000 : 0;
    }

    /** Reset all state. */
    reset(): void {
        this.estimator = this.createEstimator();
    }
}
