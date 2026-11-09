/**
 * Simulation tests: throughput estimation from group transfer times +
 * proactive quality adaptation.
 *
 * Behavioural contract of a throughput estimator that drives proactive
 * quality decisions — downshift BEFORE stalls occur, based on how fast
 * groups actually cross the link versus the current track's bitrate.
 *
 * The estimator samples `{bytes, first byte → last byte}` per group: the
 * transfer time of the group's own stream, NOT the gap between groups. A
 * live publisher paces groups at the encoder's cadence, so the gap only
 * ever reproduces the track bitrate; the transfer time shows the link.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import type { ClockSource } from './types.js';

import { BandwidthEstimator } from './bandwidth-estimator.js';

/** Minimal virtual clock — advances only when told to. */
class SimClock implements ClockSource {
    private _nowUs = 0;
    now(): number { return this._nowUs; }
    advance(deltaUs: number): void { this._nowUs += deltaUs; }
}

/**
 * Simulate groups crossing a link of `linkKbps`.
 *
 * Each group is `groupSizeBytes` large; its stream opens, takes
 * `bytes * 8 / linkKbps` to arrive, and closes. `gapUs` of idle time
 * separates one group's end from the next group's start (the publisher's
 * pacing, which must not influence the estimate).
 */
function deliverGroups(
    estimator: BandwidthEstimator,
    clock: SimClock,
    opts: {
        count: number;
        groupSizeBytes: number;
        linkKbps: number;
        gapUs?: number;
    },
): void {
    const transferUs = Math.round((opts.groupSizeBytes * 8) / opts.linkKbps * 1000);
    for (let i = 0; i < opts.count; i++) {
        const firstByteUs = clock.now();
        clock.advance(transferUs);
        estimator.recordGroup(opts.groupSizeBytes, firstByteUs, clock.now());
        clock.advance(opts.gapUs ?? 0);
    }
}

describe('BandwidthEstimator — proactive quality adaptation', () => {

    /**
     * Test 1: Sustained low bandwidth.
     *
     * The link carries 500kbps, current track is 4090kbps. The estimator
     * must report throughput well below the track bitrate so the player
     * can proactively downshift BEFORE stalls occur.
     */
    it('reports low bandwidth when the link is well below the track bitrate', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // 125KB groups (one 2s GOP of a 500kbps track) over a 500kbps link:
        // each takes the full 2s to arrive — the link is saturated.
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes: 125_000,
            linkKbps: 500,
        });

        const estimateKbps = estimator.getEstimateKbps();
        expect(estimateKbps).toBeGreaterThan(400);
        expect(estimateKbps).toBeLessThan(600);
    });

    /**
     * Test 2: Adequate bandwidth.
     *
     * Groups of a 4090kbps track cross a 5000kbps link. The estimator must
     * report throughput comfortably above the track bitrate. No quality
     * action should be needed.
     */
    it('reports adequate bandwidth when the link exceeds the track bitrate', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // 1.02MB groups (2s of 4090kbps) over a 5000kbps link.
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes: 1_022_500,
            linkKbps: 5000,
            gapUs: 364_000, // the encoder's 2s cadence minus the transfer
        });

        const estimateKbps = estimator.getEstimateKbps();
        expect(estimateKbps).toBeGreaterThan(4000);
        expect(estimateKbps).toBeLessThan(6000);
    });

    /**
     * Test 3: Mid-stream bandwidth drop.
     *
     * The link starts at 2000kbps (adequate for a 1500kbps track), then
     * drops to 300kbps. The estimator must track the drop within a
     * reasonable window — not instantly (that would be noise), but within
     * 5-10 seconds of saturated transfer (fast enough to prevent stalls).
     */
    it('tracks a mid-stream bandwidth drop within 10 seconds', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // Phase 1: 2000kbps link for 20 seconds of transfer.
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes: 500_000, // 500KB per 2s GOP = 2000kbps
            linkKbps: 2000,
        });

        const beforeDrop = estimator.getEstimateKbps();
        expect(beforeDrop).toBeGreaterThan(1500);

        // Phase 2: link drops to 300kbps; the same 2s GOPs now shrink to
        // 75KB (the publisher dropped its bitrate too) and still take 2s.
        deliverGroups(estimator, clock, {
            count: 5,
            groupSizeBytes: 75_000, // 75KB per 2s GOP = 300kbps
            linkKbps: 300,
        });

        const afterDrop = estimator.getEstimateKbps();
        // Must have tracked the drop — estimate should be well below
        // the original 2000kbps. Doesn't need to be exactly 300kbps
        // (EWMA smoothing), but must be low enough to trigger a
        // downshift decision (below 1.5x a 500kbps track = 750kbps).
        expect(afterDrop).toBeLessThan(750);
    });

    /**
     * Test 4: Bursty delivery — the NAB conference WiFi test.
     *
     * Groups arrive in clumps (3 groups back-to-back, then a 4-second
     * pause, then 3 more). The pauses are the publisher's / relay's
     * pacing, not the link's: each group still crosses a ~30Mbps link in
     * 100ms. The estimator must read the transfers and NOT treat the gaps
     * between clumps as "bandwidth dropped to zero".
     *
     * Under the old inter-arrival model this scenario averaged ~1070kbps;
     * the 4s gaps dragged every fourth sample toward 0. With transfer-time
     * samples the gaps carry no information at all.
     */
    it('ignores idle gaps between groups and measures the transfers', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        for (let burst = 0; burst < 5; burst++) {
            // 3 groups of 375KB, each crossing the link in 100ms (30Mbps).
            deliverGroups(estimator, clock, { count: 3, groupSizeBytes: 375_000, linkKbps: 30_000 });
            // 4-second pause between bursts
            clock.advance(4_000_000);
        }

        const estimateKbps = estimator.getEstimateKbps();
        expect(estimateKbps).toBeGreaterThan(25_000);
        expect(estimateKbps).toBeLessThan(35_000);
    });

    /**
     * Test 5: Warm-up and degenerate samples.
     *
     * The estimate is 0 (unknown) until enough bytes have been sampled, so
     * the controller never corroborates an upshift on one lucky group; a
     * zero-length or instantaneous transfer is not a sample.
     */
    it('reports 0 until enough bytes are sampled and ignores empty or instant transfers', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator({ minTotalBytes: 200_000 });

        estimator.recordGroup(0, 0, 1_000_000);          // no bytes
        estimator.recordGroup(100_000, 5_000_000, 5_000_000); // no transfer time
        expect(estimator.getEstimateKbps()).toBe(0);

        deliverGroups(estimator, clock, { count: 1, groupSizeBytes: 125_000, linkKbps: 1000 });
        expect(estimator.getEstimateKbps()).toBe(0); // 125KB < 200KB warm-up

        deliverGroups(estimator, clock, { count: 1, groupSizeBytes: 125_000, linkKbps: 1000 });
        expect(estimator.getEstimateKbps()).toBeGreaterThan(900);
        expect(estimator.getEstimateKbps()).toBeLessThan(1100);

        estimator.reset();
        expect(estimator.getEstimateKbps()).toBe(0);
    });
});
