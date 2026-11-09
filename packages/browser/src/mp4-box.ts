/**
 * MP4/ISO BMFF box parsing utilities.
 *
 * Pure functions for reading, writing, and filtering MP4 box structures.
 * Used by both CmafAssembler (moof/mdat pairing) and MseMediaSource
 * (init segment filtering).
 *
 * Box structure and field parsing is delegated to `@svta/cml-iso-bmff`
 * (readIsoBoxes with the tfhd/trun/trex/mdhd/hdlr/tkhd readers). What stays
 * local is Playa policy, not parsing:
 *
 *   - Top-level segment framing (`readSegmentTimeRanges`, `peekSegmentMetadata`,
 *     `locateMoofMdat`) keeps the tolerant walk that clamps an overrunning
 *     top-level moof to the buffer (the conformance corpus pins that
 *     behaviour), whereas CML stops at a box that overruns its container.
 *   - `tfdt` is read with a local reader through CML's custom-reader hook so
 *     `baseMediaDecodeTime` stays a `bigint`: CML's `readTfdt` returns a
 *     `number`, which loses precision above 2^53.
 *   - `trun` is read through a guard that bounds `sample_count` before CML's
 *     `readTrun` allocates one record per sample.
 *   - The sample-dropping rewriter (`rewriteFragmentDropSamples`) and the
 *     in-place tfdt patch are byte surgery on the original buffer; CML's
 *     writers produce new boxes and have no in-place or splice operations.
 *   - The HEVC NAL helpers are codec-layer, not ISO BMFF.
 *
 * Every function is TOTAL: malformed input yields null/empty, never a throw.
 * CML's readers throw (RangeError) on a box too short for its fields, so each
 * parse is wrapped and a thrown error is treated as "malformed".
 *
 * @see ISO/IEC 14496-12 (ISO Base Media File Format)
 * @module
 */

import {
  IsoBoxReadView,
  readHdlr,
  readIsoBoxes,
  readMdhd,
  readTfhd,
  readTkhd,
  readTrex,
  readTrun,
  type HandlerReferenceBox,
  type IsoBoxReaderMap,
  type MediaHeaderBox,
  type TrackExtendsBox,
  type TrackFragmentHeaderBox,
  type TrackHeaderBox,
  type TrackRunBox,
} from '@svta/cml-iso-bmff';

/** Read a big-endian uint32 from a Uint8Array at offset. */
export function readU32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) |
          (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

/** Write a big-endian uint32 into a Uint8Array at offset. */
export function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

/** Get the 4-character box type at offset. */
export function boxType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset + 4]!, data[offset + 5]!,
                             data[offset + 6]!, data[offset + 7]!);
}

/** Get box size at offset (supports standard 32-bit size only). */
export function boxSize(data: Uint8Array, offset: number): number {
  return readU32(data, offset);
}

// ─── CML parse layer ────────────────────────────────────────────────

/**
 * The shape every box parsed by {@link parseBoxes} shares: CML attaches the
 * box `size` and a `view` over the whole box (header included) to each parsed
 * box, and fills `boxes` for container types (moov, trak, mdia, mvex, moof,
 * traf, ...). Field readers add their own properties on top (see the typed
 * aliases below).
 */
interface ParsedBoxBase {
  readonly type: string;
  readonly size: number;
  readonly view: IsoBoxReadView;
  readonly boxes?: readonly ParsedBoxBase[];
}

type TfhdBox = ParsedBoxBase & TrackFragmentHeaderBox;
type TrunBox = ParsedBoxBase & TrackRunBox;
type TrexBox = ParsedBoxBase & TrackExtendsBox;
type MdhdBox = ParsedBoxBase & MediaHeaderBox;
type HdlrBox = ParsedBoxBase & HandlerReferenceBox;
type TkhdBox = ParsedBoxBase & TrackHeaderBox;

/** `tfdt` with a `bigint` baseMediaDecodeTime (CML's reader returns a number). */
interface Tfdt64 {
  readonly type: 'tfdt';
  readonly version: number;
  readonly flags: number;
  readonly baseMediaDecodeTime: bigint;
}
type TfdtBox = ParsedBoxBase & Tfdt64;

/**
 * Upper bound on `trun.sample_count` accepted by {@link readTrunGuarded}.
 * CML's `readTrun` allocates one record per declared sample even when the
 * trun carries no per-sample fields, so an unbounded count from a malformed
 * fragment would be a memory hazard. Real CMAF chunks carry tens to hundreds
 * of samples per trun.
 */
const MAX_TRUN_SAMPLE_COUNT = 100_000;

/**
 * tfdt reader for CML's reader map. Reads the 64-bit value as a `bigint` and
 * rejects versions other than 0/1 and a declared box too short for its value
 * (the DataView is bounded to the box, so a short box throws RangeError).
 */
function readTfdt64(view: IsoBoxReadView): Tfdt64 {
  const { version, flags } = view.readFullBox();
  if (version !== 0 && version !== 1) {
    throw new RangeError(`unsupported tfdt version ${version}`);
  }
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const baseMediaDecodeTime = version === 0
    ? BigInt(dv.getUint32(view.cursor))
    : dv.getBigUint64(view.cursor);
  view.jump(version === 0 ? 4 : 8);
  return { type: 'tfdt', version, flags, baseMediaDecodeTime };
}

/**
 * trun reader for CML's reader map. Checks that the declared sample table fits
 * the box and that `sample_count` is within {@link MAX_TRUN_SAMPLE_COUNT}
 * before handing the view to CML's `readTrun`.
 */
function readTrunGuarded(view: IsoBoxReadView): TrackRunBox {
  const start = view.cursor;
  const { flags } = view.readFullBox();
  const sampleCount = view.readUint(4);
  const prelude = ((flags & TRUN_FLAG_DATA_OFFSET) ? 4 : 0)
    + ((flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) ? 4 : 0);
  const recordSize = ((flags & TRUN_FLAG_SAMPLE_DURATION) ? 4 : 0)
    + ((flags & TRUN_FLAG_SAMPLE_SIZE) ? 4 : 0)
    + ((flags & TRUN_FLAG_SAMPLE_FLAGS) ? 4 : 0)
    + ((flags & TRUN_FLAG_SAMPLE_CTO) ? 4 : 0);
  if (sampleCount > MAX_TRUN_SAMPLE_COUNT) {
    throw new RangeError(`trun sample_count ${sampleCount} exceeds ${MAX_TRUN_SAMPLE_COUNT}`);
  }
  if (prelude + sampleCount * recordSize > view.bytesRemaining) {
    throw new RangeError('trun sample table exceeds the box');
  }
  view.jump(start - view.cursor);
  return readTrun(view);
}

/**
 * Reader maps, one per purpose. Each function hands CML only the readers for
 * the boxes it actually reads, so every other box stays raw (type, size,
 * view, children) and a malformed unrelated box — a short tkhd in an init
 * segment, say — cannot fail a trex lookup the way an all-boxes map would.
 */
/** moof → traf → tfhd / tfdt / trun. */
const MOOF_READERS: IsoBoxReaderMap = { tfhd: readTfhd, tfdt: readTfdt64, trun: readTrunGuarded };
/** moov → mvex → trex. */
const TREX_READERS: IsoBoxReaderMap = { trex: readTrex };
/** moov → trak → mdia → mdhd. */
const MDHD_READERS: IsoBoxReaderMap = { mdhd: readMdhd };
/** moov → trak → { tkhd, mdia → hdlr }, mvex → trex. */
const TRAK_READERS: IsoBoxReaderMap = { hdlr: readHdlr, tkhd: readTkhd, trex: readTrex };

/**
 * Parse the boxes tiling `data` (containers recursively) with CML.
 *
 * Returns null when a box covered by `readers` is too short for its fields
 * (CML throws). A box whose declared size overruns the buffer ends the walk
 * without an error, as do its following siblings — CML's iterator treats it
 * as truncation.
 */
function parseBoxes(data: Uint8Array, readers: IsoBoxReaderMap): readonly ParsedBoxBase[] | null {
  try {
    return readIsoBoxes(data, { readers }) as unknown as ParsedBoxBase[];
  } catch {
    return null;
  }
}

/** First child of `type` among `boxes`, typed by the caller. */
function firstBox<T extends ParsedBoxBase>(boxes: readonly ParsedBoxBase[] | undefined, type: string): T | undefined {
  return boxes?.find((b) => b.type === type) as T | undefined;
}

/** Every child of `type` among `boxes`, typed by the caller. */
function allBoxes<T extends ParsedBoxBase>(boxes: readonly ParsedBoxBase[] | undefined, type: string): T[] {
  return (boxes?.filter((b) => b.type === type) ?? []) as T[];
}

/** Offset of a parsed box's first header byte relative to `data`. */
function boxStart(box: ParsedBoxBase, data: Uint8Array): number {
  return box.view.byteOffset - data.byteOffset;
}

/** The parsed box's bytes (header included) as a view into `data`. */
function boxBytes(box: ParsedBoxBase, data: Uint8Array): Uint8Array {
  const start = boxStart(box, data);
  return data.subarray(start, start + box.view.byteLength);
}

// ─── Init segment filtering ─────────────────────────────────────────

/**
 * Find the handler type (hdlr box → handler_type) inside a parsed trak.
 * Returns 'vide', 'soun', or null.
 */
function trakHandlerType(trak: ParsedBoxBase): string | null {
  const mdia = firstBox(trak.boxes, 'mdia');
  const hdlr = firstBox<HdlrBox>(mdia?.boxes, 'hdlr');
  return hdlr?.handlerType ?? null;
}

/** Get track_id from tkhd inside a parsed trak. */
function trakTrackId(trak: ParsedBoxBase): number | null {
  return firstBox<TkhdBox>(trak.boxes, 'tkhd')?.trackId ?? null;
}

/** Build a container box from a type string and children. */
export function buildBox(type: string, children: Uint8Array[]): Uint8Array {
  const contentSize = children.reduce((sum, c) => sum + c.byteLength, 0);
  const box = new Uint8Array(8 + contentSize);
  writeU32(box, 0, 8 + contentSize);
  box[4] = type.charCodeAt(0);
  box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2);
  box[7] = type.charCodeAt(3);
  let offset = 8;
  for (const child of children) {
    box.set(child, offset);
    offset += child.byteLength;
  }
  return box;
}

/** Filter mvex to keep only trex entries matching keepTrackId. */
function filterMvex(data: Uint8Array, mvex: ParsedBoxBase, keepTrackId: number): Uint8Array {
  const children: Uint8Array[] = [];
  for (const child of mvex.boxes ?? []) {
    if (child.type === 'trex' && (child as TrexBox).trackId !== keepTrackId) continue;
    children.push(boxBytes(child, data));
  }
  return buildBox('mvex', children);
}

/**
 * Filter a multiplexed init segment to keep only the trak matching
 * the given handler type. MSE rejects moovs with non-matching traks.
 */
export function filterInitSegment(initData: Uint8Array, keepHandler: 'vide' | 'soun'): Uint8Array {
  const top = parseBoxes(initData, TRAK_READERS);
  const moov = top ? firstBox(top, 'moov') : undefined;
  if (!moov) return initData;

  let keepTrackId: number | null = null;
  const traks = allBoxes(moov.boxes, 'trak');
  for (const trak of traks) {
    if (trakHandlerType(trak) === keepHandler) keepTrackId = trakTrackId(trak);
  }
  if (traks.length <= 1 || keepTrackId === null) return initData;

  const moovChildren: Uint8Array[] = [];
  for (const child of moov.boxes ?? []) {
    if (child.type === 'trak') {
      if (trakHandlerType(child) === keepHandler) moovChildren.push(boxBytes(child, initData));
    } else if (child.type === 'mvex') {
      moovChildren.push(filterMvex(initData, child, keepTrackId));
    } else {
      moovChildren.push(boxBytes(child, initData));
    }
  }

  const moovStart = boxStart(moov, initData);
  const before = initData.subarray(0, moovStart);
  const after = initData.subarray(moovStart + moov.view.byteLength);
  const newMoov = buildBox('moov', moovChildren);
  const result = new Uint8Array(before.byteLength + newMoov.byteLength + after.byteLength);
  let offset = 0;
  result.set(before, offset); offset += before.byteLength;
  result.set(newMoov, offset); offset += newMoov.byteLength;
  result.set(after, offset);
  return result;
}

/** Debug: list top-level box types and sizes. */
export function describeBoxes(data: Uint8Array): string {
  const boxes: string[] = [];
  try {
    // Raw walk (no field readers) so a malformed leaf cannot abort the listing;
    // CML stops at a box that overruns the buffer.
    for (const box of new IsoBoxReadView(data) as Iterable<ParsedBoxBase>) {
      boxes.push(`${box.type}(${box.size})`);
      if (box.type === 'moov') {
        for (const child of box.boxes ?? []) boxes.push(`  ${child.type}(${child.size})`);
      }
    }
  } catch {
    // A trailing partial box: keep what was listed so far.
  }
  return boxes.join(', ');
}

// ─── tfdt helpers (for CMAF segment assembler) ──────────────────────

/**
 * Parse a whole moof (header included) and locate the tfdt of its first traf.
 *
 * The top-level moof must itself be fully present: a moof declaring more bytes
 * than the buffer holds is truncated and is rejected here rather than parsed
 * from partial content. Children are parsed by CML from the moof body, so a
 * tfdt declaring more than its traf holds, or one too short for its version's
 * value, yields null instead of reading into a sibling.
 */
function locateTfdt(moof: Uint8Array): { box: TfdtBox; offset: number } | null {
  if (moof.byteLength < 8 || boxType(moof, 0) !== 'moof') return null;
  const moofSize = boxSize(moof, 0);
  if (moofSize < 8 || moofSize > moof.byteLength) return null;
  const children = parseBoxes(moof.subarray(8, moofSize), MOOF_READERS);
  if (!children) return null;
  const traf = firstBox(children, 'traf');
  const tfdt = firstBox<TfdtBox>(traf?.boxes, 'tfdt');
  if (!tfdt) return null;
  return { box: tfdt, offset: boxStart(tfdt, moof) };
}

/**
 * Find the tfdt box offset inside a moof.
 * Walks: moof → traf → tfdt.
 *
 * @returns offset of the tfdt box start and its version, or null if not found
 */
export function findTfdtOffset(moof: Uint8Array): { offset: number; version: number } | null {
  const tfdt = locateTfdt(moof);
  return tfdt ? { offset: tfdt.offset, version: tfdt.box.version } : null;
}

/**
 * Read baseMediaDecodeTime from a moof's tfdt box.
 *
 * @returns baseMediaDecodeTime as bigint, or null if tfdt not found
 */
export function readBaseMediaDecodeTime(moof: Uint8Array): bigint | null {
  return locateTfdt(moof)?.box.baseMediaDecodeTime ?? null;
}

/**
 * Patch baseMediaDecodeTime in-place inside a moof's tfdt box.
 * Zero-copy — modifies the existing Uint8Array via DataView.
 *
 * @param moof The moof Uint8Array to modify in-place
 * @param newValue New baseMediaDecodeTime value
 */
export function patchBaseMediaDecodeTime(moof: Uint8Array, newValue: bigint): void {
  const tfdt = locateTfdt(moof);
  if (!tfdt) return;

  const version = tfdt.box.version;
  const max = version === 0 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
  if (newValue < 0n || newValue > max) {
    throw new RangeError(`baseMediaDecodeTime ${newValue} does not fit tfdt version ${version}`);
  }

  // tfdt layout: size(4) + type(4) + version(1) + flags(3) + baseMediaDecodeTime(4 or 8).
  // locateTfdt proved the declared box holds the value (CML's bounded view).
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  const valueOffset = tfdt.offset + 12;
  if (version === 0) {
    view.setUint32(valueOffset, Number(newValue));
  } else {
    view.setBigUint64(valueOffset, newValue);
  }
}

/**
 * Concatenate two Uint8Arrays into a single buffer.
 * Used for moof+mdat assembly.
 */
export function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

// ─── Segment-level time range (timeline-owned append) ───────────────
//
// Supports the MseMediaSource's timeline index by deriving each moof's
// [startTime, endTime) from tfdt + {trun per-sample | tfhd default |
// trex default}. Returns per-moof ranges so multi-moof payloads are
// handled correctly; returns null on any unscorable moof so the caller
// drops the whole payload (unscored bytes must not reach MSE).
//
// @see ISO/IEC 14496-12 §8.8.7 (tfhd), §8.8.8 (trun), §8.8.3 (trex)

export interface SegmentTimeRange {
  readonly startTime: bigint;
  readonly endTime: bigint;
  readonly sampleCount: number;
}

/**
 * Sample defaults from a track's trex box in the init segment.
 *
 * The trex box body has a fixed layout — `default_sample_duration`,
 * `default_sample_size`, and `default_sample_flags` are at known offsets
 * and are always present on the wire (per ISO/IEC 14496-12 §8.8.3).
 *
 * A value of 0 for any field is treated as "no usable default" by the
 * resolution priority in `iterateTrunSamples`: per-sample value in trun
 * (if its flag is set) → tfhd default → trex default → 0. A
 * well-authored encoder fills these fields; 0 here means either the
 * encoder didn't, or the value genuinely is 0 (which for duration
 * implies variable-rate with per-sample durations in trun).
 */
export interface TrexDefaults {
  readonly trackId: number;
  readonly defaultSampleDuration: number;
  readonly defaultSampleSize: number;
  readonly defaultSampleFlags: number;
}

/** Reasons `readSegmentTimeRanges` gives up on a specific moof. */
export type DiagnosticKind =
  | 'multi-traf'
  | 'no-tfdt'
  | 'no-trun'
  | 'no-duration'
  | 'malformed-moof';

// tfhd flags (ISO/IEC 14496-12 §8.8.7)
const TFHD_FLAG_BASE_DATA_OFFSET = 0x000001;

// trun flags (ISO/IEC 14496-12 §8.8.8)
const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;
const TRUN_FLAG_SAMPLE_SIZE = 0x000200;
const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;
const TRUN_FLAG_SAMPLE_CTO = 0x000800;

/**
 * Compute the total sample duration contributed by one parsed trun, using
 * per-sample durations if present, else the supplied defaults.
 *
 * @returns `{ totalDuration, sampleCount, scored }` — `scored: false`
 *          means no duration source was usable for this trun.
 */
function computeTrunDuration(
  trun: TrunBox,
  tfhdDefault: number | undefined,
  trexDefault: number | undefined,
): { totalDuration: bigint; sampleCount: number; scored: boolean } {
  const sampleCount = trun.sampleCount;
  if ((trun.flags & TRUN_FLAG_SAMPLE_DURATION) !== 0) {
    let total = 0n;
    for (const sample of trun.samples) total += BigInt(sample.sampleDuration ?? 0);
    return { totalDuration: total, sampleCount, scored: true };
  }

  const fallback = tfhdDefault ?? (trexDefault && trexDefault > 0 ? trexDefault : undefined);
  if (fallback === undefined) {
    return { totalDuration: 0n, sampleCount, scored: false };
  }
  return {
    totalDuration: BigInt(sampleCount) * BigInt(fallback),
    sampleCount,
    scored: true,
  };
}

/**
 * Read ranges from every moof in the payload.
 *
 * Tri-state return:
 *   - `null`: at least one moof was found but could not be fully
 *             scored (missing tfdt, missing trun, no duration source,
 *             multi-traf, malformed). Caller MUST drop the whole
 *             payload — appending unscored bytes would bypass the
 *             overlap check.
 *   - `[]`:   no moofs in the payload (init segment, mdat-only,
 *             unknown). Caller fails open.
 *   - `[r1,...]`: every moof scored successfully. Caller checks each
 *             range against its timeline before appending.
 *
 * The top-level walk is local and tolerant: a moof whose declared size
 * overruns the payload is clamped to the bytes present (the conformance
 * corpus pins this). Its children are parsed by CML.
 *
 * @param segment Payload bytes (may start with styp/sidx prefix).
 * @param trex Track's trex defaults from the init segment, if known.
 * @param onDiagnostic Optional callback for per-moof failure signals.
 *                     Caller is responsible for deduping (warn-once).
 */
export function readSegmentTimeRanges(
  segment: Uint8Array,
  trex?: TrexDefaults,
  onDiagnostic?: (kind: DiagnosticKind, detail: string) => void,
): readonly SegmentTimeRange[] | null {
  const ranges: SegmentTimeRange[] = [];
  let moofCount = 0;
  let anyUnscorable = false;

  const emit = (kind: DiagnosticKind, detail: string) => {
    onDiagnostic?.(kind, detail);
    anyUnscorable = true;
  };

  let pos = 0;
  while (pos + 8 <= segment.byteLength) {
    const type = boxType(segment, pos);
    const size = boxSize(segment, pos);
    if (size < 8) break; // malformed top level, stop walking
    if (type !== 'moof') {
      pos += size;
      continue;
    }

    moofCount++;
    const moofStart = pos;
    const moof = segment.subarray(pos, pos + size);
    pos += size;

    const children = parseBoxes(moof.subarray(8), MOOF_READERS);
    if (!children) {
      emit('malformed-moof', `moof at ${moofStart}: a child box is too short for its fields`);
      continue;
    }

    const trafs = allBoxes(children, 'traf');
    if (trafs.length === 0) {
      emit('no-trun', `moof at ${moofStart}: no traf`);
      continue;
    }
    if (trafs.length > 1) {
      emit('multi-traf', `moof at ${moofStart}: ${trafs.length} traf boxes (only first supported)`);
      continue;
    }

    const traf = trafs[0]!;
    const tfhdBox = firstBox<TfhdBox>(traf.boxes, 'tfhd');
    const tfdtBox = firstBox<TfdtBox>(traf.boxes, 'tfdt');
    const trunBoxes = allBoxes<TrunBox>(traf.boxes, 'trun');

    if (!tfdtBox) {
      emit('no-tfdt', `moof at ${moofStart}: traf has no tfdt`);
      continue;
    }
    if (trunBoxes.length === 0) {
      emit('no-trun', `moof at ${moofStart}: traf has no trun`);
      continue;
    }

    const bmd = tfdtBox.baseMediaDecodeTime;

    // Resolve per-sample duration source for this moof's truns.
    const tfhdDefault = tfhdBox?.defaultSampleDuration;
    const trexDefault = trex?.defaultSampleDuration;

    let totalDuration = 0n;
    let totalSamples = 0;
    let allTrunsScored = true;
    for (const trun of trunBoxes) {
      const r = computeTrunDuration(trun, tfhdDefault, trexDefault);
      if (!r.scored) {
        allTrunsScored = false;
        break;
      }
      totalDuration += r.totalDuration;
      totalSamples += r.sampleCount;
    }
    if (!allTrunsScored) {
      emit(
        'no-duration',
        `moof at ${moofStart}: no duration resolvable from trun/tfhd/trex`,
      );
      continue;
    }

    ranges.push({
      startTime: bmd,
      endTime: bmd + totalDuration,
      sampleCount: totalSamples,
    });
  }

  if (moofCount === 0) return [];
  if (anyUnscorable) return null;
  return ranges;
}

/**
 * Read trex defaults for every track declared in an init segment's
 * moov → mvex → trex chain.
 *
 * @returns Map keyed by track_id. Empty if no mvex present, or if the init is
 *          malformed (a box too short for its fields, or a trex declaring a
 *          size past its mvex, is never read from a following sibling).
 */
export function readTrexDefaults(initSegment: Uint8Array): Map<number, TrexDefaults> {
  const result = new Map<number, TrexDefaults>();
  const top = parseBoxes(initSegment, TREX_READERS);
  if (!top) return result;

  for (const moov of allBoxes(top, 'moov')) {
    for (const mvex of allBoxes(moov.boxes, 'mvex')) {
      for (const trex of allBoxes<TrexBox>(mvex.boxes, 'trex')) {
        result.set(trex.trackId, {
          trackId: trex.trackId,
          defaultSampleDuration: trex.defaultSampleDuration,
          defaultSampleSize: trex.defaultSampleSize,
          defaultSampleFlags: trex.defaultSampleFlags,
        });
      }
    }
  }

  return result;
}

/**
 * Read the media timescale from an init segment's
 * moov → trak → mdia → mdhd chain.
 *
 * CMAF init segments carry one track each, so the first mdhd found is
 * the track's timescale (video: e.g. 90000; audio: the sample rate).
 *
 * @returns The mdhd timescale, or null if no mdhd is present, its version is
 *          not 0 or 1, or its timescale is 0.
 */
export function readMdhdTimescale(initSegment: Uint8Array): number | null {
  const top = parseBoxes(initSegment, MDHD_READERS);
  if (!top) return null;
  for (const moov of allBoxes(top, 'moov')) {
    for (const trak of allBoxes(moov.boxes, 'trak')) {
      for (const mdia of allBoxes(trak.boxes, 'mdia')) {
        const mdhd = firstBox<MdhdBox>(mdia.boxes, 'mdhd');
        if (!mdhd) continue;
        if (mdhd.version !== 0 && mdhd.version !== 1) return null;
        return mdhd.timescale === 0 ? null : mdhd.timescale;
      }
    }
  }
  return null;
}

/**
 * Read the baseMediaDecodeTime from a CMAF segment that may have prefix
 * boxes (styp, sidx) before the moof.
 *
 * @returns { bmd, mdatSize } or null if no moof/tfdt found. mdatSize is
 *          the mdat box size if present (useful for diagnosing size
 *          anomalies); null if the segment doesn't include one.
 */
export function peekSegmentMetadata(segment: Uint8Array): {
  bmd: bigint | null;
  mdatSize: number | null;
} | null {
  if (segment.byteLength < 8) return null;

  // Walk top-level boxes to find moof + mdat.
  let moofOffset: number | null = null;
  let moofSize = 0;
  let mdatSize: number | null = null;

  let pos = 0;
  while (pos + 8 <= segment.byteLength) {
    const t = boxType(segment, pos);
    const s = boxSize(segment, pos);
    if (s < 8) break; // malformed
    if (t === 'moof' && moofOffset === null) {
      moofOffset = pos;
      moofSize = s;
    } else if (t === 'mdat' && mdatSize === null) {
      mdatSize = s;
    }
    pos += s;
  }

  if (moofOffset === null) return { bmd: null, mdatSize };
  const bmd = readBaseMediaDecodeTime(segment.subarray(moofOffset, moofOffset + moofSize));
  return { bmd, mdatSize };
}

// ─── HEVC NAL helpers ────────────────────────────────────────────────
//
// HEVC samples in CMAF use length-prefixed (HVCC) framing inside mdat:
// each NAL is preceded by a 4-byte big-endian length field (the
// "lengthSizeMinusOne" in hvcC is 3 → 4-byte lengths).
//
// HEVC NAL unit header (2 bytes):
//   forbidden_zero_bit (1) | nal_unit_type (6) | nuh_layer_id high (1)
//   nuh_layer_id low (5)   | nuh_temporal_id_plus1 (3)
//
// Relevant nal_unit_type values for splice / random-access decisions:
//   0    TRAIL_N        non-reference trailing picture
//   1    TRAIL_R        reference trailing picture
//   2-7  TSA_N..RADL_R  temporal sublayer / leading-decodable
//   8    RASL_N         non-reference leading-skipped picture
//   9    RASL_R         reference leading-skipped picture
//   16-18 BLA*          broken-link access (random-access)
//   19   IDR_W_RADL     IDR with possible RADL leading pictures
//   20   IDR_N_LP       IDR with no leading pictures
//   21   CRA            clean random access
//   32-34 VPS/SPS/PPS   parameter sets
//   35   AUD            access unit delimiter
//   39/40 PREFIX_SEI/SUFFIX_SEI
//
// VCL (video coding layer) range is 0..31. NAL types 32+ are non-VCL.
//
// @see ITU-T H.265 §7.3.1.2 (NAL unit header)
// @see ISO/IEC 14496-15 §8 (HEVC sample structure)

/** HEVC NAL unit type codes used by the RASL-strip path. */
export const HevcNalType = {
  RASL_N: 8,
  RASL_R: 9,
  IDR_W_RADL: 19,
  IDR_N_LP: 20,
  CRA: 21,
} as const;

/**
 * Extract the HEVC `nal_unit_type` from the first byte of a NAL unit's
 * RBSP. Returns -1 if the unit is too short to contain a valid header.
 */
export function getHevcNalType(nalUnit: Uint8Array): number {
  if (nalUnit.byteLength < 1) return -1;
  return (nalUnit[0]! >> 1) & 0x3f;
}

/** True for HEVC VCL NAL types (0..31). Non-VCL is 32+. */
export function isHevcVclNalType(nalType: number): boolean {
  return nalType >= 0 && nalType <= 31;
}

/** True for HEVC RASL pictures (NAL types 8 and 9). */
export function isHevcRaslNalType(nalType: number): boolean {
  return nalType === HevcNalType.RASL_N || nalType === HevcNalType.RASL_R;
}

/** True for HEVC CRA pictures (NAL type 21). */
export function isHevcCraNalType(nalType: number): boolean {
  return nalType === HevcNalType.CRA;
}

/**
 * Walk the length-prefixed (HVCC, 4-byte lengths) NAL units inside a
 * single sample's bytes and return the type of the first VCL NAL.
 * Returns null if no VCL NAL is found (e.g., a sample that contains
 * only parameter sets / SEIs — uncommon at the sample level but
 * possible in malformed feeds).
 *
 * Bounded walk: stops on length-zero or buffer underrun rather than
 * throwing, so a malformed sample yields null instead of crashing the
 * pipeline.
 */
export function firstHevcVclNalType(sampleBytes: Uint8Array): number | null {
  let pos = 0;
  while (pos + 5 <= sampleBytes.byteLength) {
    const len = readU32(sampleBytes, pos);
    pos += 4;
    if (len === 0 || pos + len > sampleBytes.byteLength) return null;
    const nalType = getHevcNalType(sampleBytes.subarray(pos, pos + 1));
    if (isHevcVclNalType(nalType)) return nalType;
    pos += len;
  }
  return null;
}

// ─── Per-sample iteration over trun ──────────────────────────────────

/** tfhd-derived defaults used by the sample iterator. */
export interface TfhdDefaults {
  readonly defaultSampleDuration?: number;
  readonly defaultSampleSize?: number;
  readonly defaultSampleFlags?: number;
}

/** Parse a single standalone moof-level box (header included) with CML. */
function parseSingleBox<T extends ParsedBoxBase>(box: Uint8Array, type: string): T | undefined {
  const parsed = parseBoxes(box, MOOF_READERS);
  const first = parsed?.[0];
  return first && first.type === type ? first as T : undefined;
}

/** The flags-gated defaults of a parsed tfhd, with only the present keys set. */
function tfhdDefaults(tfhd: TrackFragmentHeaderBox): TfhdDefaults {
  const out: { defaultSampleDuration?: number; defaultSampleSize?: number; defaultSampleFlags?: number } = {};
  if (tfhd.defaultSampleDuration !== undefined) out.defaultSampleDuration = tfhd.defaultSampleDuration;
  if (tfhd.defaultSampleSize !== undefined) out.defaultSampleSize = tfhd.defaultSampleSize;
  if (tfhd.defaultSampleFlags !== undefined) out.defaultSampleFlags = tfhd.defaultSampleFlags;
  return out;
}

/**
 * Parse tfhd flags-gated default fields. Layout per §8.8.7:
 *   header(8) + version(1) + flags(3) + track_ID(4) +
 *   [base_data_offset(8)            if 0x000001] +
 *   [sample_description_index(4)    if 0x000002] +
 *   [default_sample_duration(4)     if 0x000008] +
 *   [default_sample_size(4)         if 0x000010] +
 *   [default_sample_flags(4)        if 0x000020]
 *
 * Returns `{}` for a tfhd too short for the fields its flags announce.
 */
export function parseTfhdDefaults(box: Uint8Array): TfhdDefaults {
  const tfhd = parseSingleBox<TfhdBox>(box, 'tfhd');
  return tfhd ? tfhdDefaults(tfhd) : {};
}

/** One sample's metadata as resolved from trun + tfhd + trex. */
export interface TrunSample {
  /** Index within the trun (0-based). */
  readonly index: number;
  /** Byte offset into the mdat *payload* (i.e., after the 8-byte mdat header). */
  readonly mdatOffset: number;
  /** Sample size in bytes. */
  readonly size: number;
  /** Sample duration in track timescale ticks. */
  readonly duration: number;
  /**
   * Composition time offset (signed in v1, unsigned in v0).
   * 0 if not present and no default applies.
   */
  readonly ctsOffset: number;
  /**
   * 32-bit `sample_flags` word. 0 if neither per-sample flags nor a
   * tfhd/trex default are available. The first sample uses
   * `first_sample_flags` (trun flag 0x000004) when present.
   */
  readonly flags: number;
}

/**
 * Resolve the samples of a parsed trun against tfhd and trex defaults.
 *
 * Resolution priority (per §8.8.8 / §8.8.7):
 *   - per-sample value in trun (if its flag is set)
 *   - tfhd default (if its flag is set)
 *   - trex default (last resort)
 */
function resolveTrunSamples(trun: TrackRunBox, tfhd: TfhdDefaults, trex?: TrexDefaults): TrunSample[] {
  const defaultDuration = tfhd.defaultSampleDuration
    ?? (trex && trex.defaultSampleDuration > 0 ? trex.defaultSampleDuration : undefined);
  const defaultSize = tfhd.defaultSampleSize
    ?? (trex && trex.defaultSampleSize > 0 ? trex.defaultSampleSize : undefined);
  const defaultFlags = tfhd.defaultSampleFlags
    ?? (trex && trex.defaultSampleFlags > 0 ? trex.defaultSampleFlags : undefined);

  const out: TrunSample[] = [];
  let mdatOffset = 0;
  for (let i = 0; i < trun.sampleCount; i++) {
    const sample = trun.samples[i] ?? {};
    const duration = sample.sampleDuration ?? defaultDuration ?? 0;
    const size = sample.sampleSize ?? defaultSize ?? 0;
    // first_sample_flags overrides per-sample/default flags for sample 0
    const flags = i === 0 && trun.firstSampleFlags !== undefined
      ? trun.firstSampleFlags
      : sample.sampleFlags ?? defaultFlags ?? 0;
    const ctsOffset = sample.sampleCompositionTimeOffset ?? 0;
    out.push({ index: i, mdatOffset, size, duration, ctsOffset, flags });
    mdatOffset += size;
  }
  return out;
}

/**
 * Iterate samples described by a single trun box. Yields metadata
 * needed to slice the corresponding bytes out of mdat for re-packing.
 *
 * Resolution priority (per §8.8.8 / §8.8.7):
 *   - per-sample value in trun (if its flag is set)
 *   - tfhd default (if its flag is set)
 *   - trex default (last resort)
 *
 * Returns null if the trun is malformed (sample_count exceeds the
 * remaining bytes for the declared per-sample fields). Caller must
 * fall back to leaving the fragment untouched.
 */
export function iterateTrunSamples(
  trun: Uint8Array,
  tfhd: TfhdDefaults,
  trex?: TrexDefaults,
): readonly TrunSample[] | null {
  const parsed = parseSingleBox<TrunBox>(trun, 'trun');
  if (!parsed) return null;
  return resolveTrunSamples(parsed, tfhd, trex);
}

// ─── Fragment rewriter (drop samples by keep-mask) ──────────────────

/**
 * Locate the first moof and the immediately-following mdat in a CMAF
 * segment payload. Tolerates a styp / sidx prefix.
 *
 * Returns `null` if either box is missing or the segment is malformed.
 */
function locateMoofMdat(segment: Uint8Array): {
  moofOffset: number; moofSize: number;
  mdatOffset: number; mdatSize: number;
} | null {
  let pos = 0;
  let moofOffset = -1;
  let moofSize = 0;
  let mdatOffset = -1;
  let mdatSize = 0;
  while (pos + 8 <= segment.byteLength) {
    const t = boxType(segment, pos);
    const s = boxSize(segment, pos);
    if (s < 8) return null;
    if (t === 'moof' && moofOffset === -1) {
      moofOffset = pos;
      moofSize = s;
    } else if (t === 'mdat' && moofOffset !== -1 && mdatOffset === -1) {
      mdatOffset = pos;
      mdatSize = s;
    }
    pos += s;
  }
  if (moofOffset === -1 || mdatOffset === -1) return null;
  return { moofOffset, moofSize, mdatOffset, mdatSize };
}

/**
 * Locate the single traf inside a moof, plus its tfhd and trun. Returns
 * `null` for shapes the rewriter doesn't handle (multi-traf, multi-trun,
 * malformed). Caller falls back to leaving the fragment untouched.
 *
 * Offsets are relative to the moof's first byte.
 */
function locateTrafBoxes(moof: Uint8Array): {
  trafOffset: number; trafSize: number;
  tfhd: TfhdBox; tfhdOffset: number;
  trun: TrunBox; trunOffset: number; trunSize: number;
} | null {
  if (moof.byteLength < 8) return null;
  const children = parseBoxes(moof.subarray(8), MOOF_READERS);
  if (!children) return null;
  const trafs = allBoxes(children, 'traf');
  if (trafs.length !== 1) return null;
  const traf = trafs[0]!;

  const tfhd = firstBox<TfhdBox>(traf.boxes, 'tfhd');
  const truns = allBoxes<TrunBox>(traf.boxes, 'trun');
  if (!tfhd || truns.length !== 1) return null;
  const trun = truns[0]!;
  return {
    trafOffset: boxStart(traf, moof), trafSize: traf.view.byteLength,
    tfhd, tfhdOffset: boxStart(tfhd, moof),
    trun, trunOffset: boxStart(trun, moof), trunSize: trun.view.byteLength,
  };
}

/**
 * Build a new trun box that keeps only the samples for which
 * `keepMask[i] === true`. Preserves the original version, the
 * `data_offset` and `first_sample_flags` prelude flags, and the
 * `sample_size` / `sample_flags` / `sample_cto` per-sample fields.
 *
 * The output **always** has `TRUN_FLAG_SAMPLE_DURATION` set with
 * explicit per-sample durations, even when the input relied on
 * `default_sample_duration` from tfhd/trex. Resolved per-sample
 * durations come from `samples[i].duration` (which `iterateTrunSamples`
 * already factored in defaults for). This lets the rewriter extend the
 * last kept sample's duration to absorb dropped samples' decode time —
 * otherwise the fragment ends short and the next fragment's bmd leaves
 * a presentation-time gap that stalls MSE-style demuxers.
 *
 * `data_offset` (when its flag is set) is signed and, in CMAF profiles
 * that use `default_base_is_moof` (the norm), measured from moof start.
 * Since rewriting the trun is the only thing that changes the moof
 * size, the mdat that follows shifts earlier (or later) by exactly the
 * trun's size delta — so `data_offset` is rebased by the same delta to
 * keep pointing at the same mdat byte.
 *
 * Caller is responsible for validating that `keepMask.length` matches
 * the original sample_count and that `samples.length` matches too.
 */
function rewriteTrun(
  trun: Uint8Array,
  keepMask: readonly boolean[],
  samples: readonly TrunSample[],
  bumpLastDurationBy: number,
): Uint8Array {
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const inFlags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);

  // Input layout: size(4) + 'trun'(4) + version+flags(4) + sample_count(4)
  // = 16 bytes; followed by optional data_offset(4), first_sample_flags(4),
  // then per-sample records in field order [duration?, size?, flags?, cto?].
  const hasDataOffset = (inFlags & TRUN_FLAG_DATA_OFFSET) !== 0;
  const hasFirstSampleFlags = (inFlags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) !== 0;
  const inHasPerDuration = (inFlags & TRUN_FLAG_SAMPLE_DURATION) !== 0;
  const hasPerSize = (inFlags & TRUN_FLAG_SAMPLE_SIZE) !== 0;
  const hasPerFlags = (inFlags & TRUN_FLAG_SAMPLE_FLAGS) !== 0;
  const hasPerCto = (inFlags & TRUN_FLAG_SAMPLE_CTO) !== 0;
  const prelude = 16 + (hasDataOffset ? 4 : 0) + (hasFirstSampleFlags ? 4 : 0);
  const inRecordSize = (inHasPerDuration ? 4 : 0) + (hasPerSize ? 4 : 0)
    + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);

  // Output layout always carries per-sample durations. Other field flags
  // are preserved from the input.
  const outFlags = inFlags | TRUN_FLAG_SAMPLE_DURATION;
  const outRecordSize = 4 /* sample_duration */
    + (hasPerSize ? 4 : 0) + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);

  let keptCount = 0;
  let lastKeptIndex = -1;
  for (let i = 0; i < keepMask.length; i++) {
    if (keepMask[i]) { keptCount++; lastKeptIndex = i; }
  }

  const newSize = prelude + keptCount * outRecordSize;
  const trunDelta = newSize - trun.byteLength; // negative when shrinking, 0 if no-op
  const out = new Uint8Array(newSize);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Copy prelude (box size, type, version+flags, sample_count, optional
  // data_offset + first_sample_flags). We patch fields below.
  out.set(trun.subarray(0, prelude), 0);
  writeU32(out, 0, newSize);
  // Patch flags to include TRUN_FLAG_SAMPLE_DURATION if input lacked it.
  out[9] = (outFlags >> 16) & 0xff;
  out[10] = (outFlags >> 8) & 0xff;
  out[11] = outFlags & 0xff;
  // Patch sample_count
  writeU32(out, 12, keptCount);
  // Re-anchor data_offset by the trun's overall size change. The
  // surrounding moof shrinks/grows by `trunDelta`, mdat shifts by the
  // same amount, so the offset (relative to moof start under
  // default_base_is_moof) must shift by `trunDelta`.
  if (hasDataOffset && trunDelta !== 0) {
    const oldOffset = view.getInt32(16);
    outView.setInt32(16, oldOffset + trunDelta);
  }

  // Write per-sample records. Duration is always written first
  // (sourced from samples[i].duration so defaults are honored).
  // Subsequent fields are byte-copied from the input record.
  let writePos = prelude;
  for (let i = 0; i < keepMask.length; i++) {
    if (!keepMask[i]) continue;
    const baseDuration = samples[i]!.duration;
    const duration = (i === lastKeptIndex)
      ? baseDuration + bumpLastDurationBy
      : baseDuration;
    writeU32(out, writePos, duration);
    writePos += 4;

    // Copy size / flags / cto verbatim from input record (skip its
    // duration field if it had one).
    let srcOffset = prelude + i * inRecordSize + (inHasPerDuration ? 4 : 0);
    const tailLen = (hasPerSize ? 4 : 0) + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);
    out.set(trun.subarray(srcOffset, srcOffset + tailLen), writePos);
    writePos += tailLen;
  }
  return out;
}

/**
 * Rewrite a CMAF fragment to drop a subset of samples chosen by
 * `shouldDrop(sample, sampleBytes)`. Returns the new segment bytes
 * (preserving any styp/sidx prefix and trailing boxes verbatim) or
 * `null` if:
 *   - the segment has no moof/mdat,
 *   - the moof has multi-traf or multi-trun,
 *   - the trun is malformed,
 *   - mdat is too small to contain the declared samples,
 *   - no samples would be dropped (caller can short-circuit on null).
 *
 * Pure: does not mutate the input.
 *
 * Sample-table surgery includes:
 *   - rewriting `trun.sample_count` and per-sample arrays
 *   - shrinking the mdat by the dropped samples' bytes
 *   - patching mdat box size, traf box size, and moof box size in turn
 *
 * Note on `tfhd.base_data_offset` / `trun.data_offset`: when the moof
 * shrinks, any absolute `base_data_offset` would need re-anchoring.
 * We do NOT support fragments that set tfhd flag 0x000001
 * (BASE_DATA_OFFSET) — return `null` in that case so the caller falls
 * back to the original. CMAF segments routinely use the
 * `default_base_is_moof` flag (0x020000) instead, where mdat data is
 * implicitly relative to moof; our rewrite preserves that.
 */
export function rewriteFragmentDropSamples(
  segment: Uint8Array,
  shouldDrop: (sample: TrunSample, sampleBytes: Uint8Array) => boolean,
  trex?: TrexDefaults,
): Uint8Array | null {
  const loc = locateMoofMdat(segment);
  if (!loc) return null;

  const moof = segment.subarray(loc.moofOffset, loc.moofOffset + loc.moofSize);
  const mdatPayload = segment.subarray(
    loc.mdatOffset + 8,
    loc.mdatOffset + loc.mdatSize,
  );

  const traf = locateTrafBoxes(moof);
  if (!traf) return null;

  // Reject fragments using absolute base_data_offset — re-anchoring is
  // out of scope for this rewriter.
  if ((traf.tfhd.flags & TFHD_FLAG_BASE_DATA_OFFSET) !== 0) return null;

  const trunBox = moof.subarray(traf.trunOffset, traf.trunOffset + traf.trunSize);
  const samples = resolveTrunSamples(traf.trun, tfhdDefaults(traf.tfhd), trex);

  // Validate mdat is large enough for the declared samples
  let totalSampleBytes = 0;
  for (const s of samples) totalSampleBytes += s.size;
  if (totalSampleBytes > mdatPayload.byteLength) return null;

  // Build keep-mask. Track dropped sample bytes (for mdat resize) and
  // dropped sample durations (so we can extend the last kept sample to
  // absorb the time hole — otherwise the next fragment's bmd leaves a
  // presentation-time gap that stalls MSE-style demuxers).
  const keepMask: boolean[] = new Array(samples.length);
  let droppedCount = 0;
  let droppedBytes = 0;
  let droppedDuration = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const bytes = mdatPayload.subarray(s.mdatOffset, s.mdatOffset + s.size);
    const drop = shouldDrop(s, bytes);
    keepMask[i] = !drop;
    if (drop) {
      droppedCount++;
      droppedBytes += s.size;
      droppedDuration += s.duration;
    }
  }
  if (droppedCount === 0) return null;

  // Rewrite trun with kept samples only. Bumps the last kept sample's
  // duration so the fragment ends where the publisher said it would.
  // Output trun always includes per-sample durations (added if absent
  // in the input), sourced from the resolved `samples[i].duration`.
  const newTrun = rewriteTrun(trunBox, keepMask, samples, droppedDuration);
  const trunDelta = newTrun.byteLength - trunBox.byteLength; // can be + or -

  // Rewrite traf: copy through, splicing newTrun in place of old trun
  const newTrafSize = traf.trafSize + trunDelta;
  const newTraf = new Uint8Array(newTrafSize);
  // Copy traf header + everything before trun
  const trunRelInTraf = traf.trunOffset - traf.trafOffset;
  newTraf.set(moof.subarray(traf.trafOffset, traf.trafOffset + trunRelInTraf), 0);
  // Copy newTrun
  newTraf.set(newTrun, trunRelInTraf);
  // Copy everything after old trun (trailing boxes, e.g., sbgp, subs)
  const oldTrunEnd = traf.trunOffset + traf.trunSize;
  const trafEnd = traf.trafOffset + traf.trafSize;
  newTraf.set(
    moof.subarray(oldTrunEnd, trafEnd),
    trunRelInTraf + newTrun.byteLength,
  );
  // Patch traf size
  writeU32(newTraf, 0, newTrafSize);

  // Rewrite moof: copy through, splicing newTraf in place of old traf
  const newMoofSize = loc.moofSize + trunDelta;
  const newMoof = new Uint8Array(newMoofSize);
  const trafRelInMoof = traf.trafOffset; // moof is moof.subarray, traf.trafOffset is relative to moof start
  newMoof.set(moof.subarray(0, trafRelInMoof), 0);
  newMoof.set(newTraf, trafRelInMoof);
  newMoof.set(
    moof.subarray(trafRelInMoof + traf.trafSize, loc.moofSize),
    trafRelInMoof + newTrafSize,
  );
  writeU32(newMoof, 0, newMoofSize);

  // Rewrite mdat: keep only the bytes of kept samples, in order
  const newMdatPayloadSize = mdatPayload.byteLength - droppedBytes;
  const newMdat = new Uint8Array(8 + newMdatPayloadSize);
  writeU32(newMdat, 0, 8 + newMdatPayloadSize);
  newMdat[4] = 0x6d; newMdat[5] = 0x64; newMdat[6] = 0x61; newMdat[7] = 0x74; // 'mdat'
  let writePos = 8;
  for (let i = 0; i < samples.length; i++) {
    if (!keepMask[i]) continue;
    const s = samples[i]!;
    newMdat.set(mdatPayload.subarray(s.mdatOffset, s.mdatOffset + s.size), writePos);
    writePos += s.size;
  }

  // Stitch back: prefix (styp/sidx) + newMoof + newMdat + trailing
  const prefix = segment.subarray(0, loc.moofOffset);
  const trailing = segment.subarray(loc.mdatOffset + loc.mdatSize);
  const out = new Uint8Array(
    prefix.byteLength + newMoof.byteLength + newMdat.byteLength + trailing.byteLength,
  );
  let o = 0;
  out.set(prefix, o); o += prefix.byteLength;
  out.set(newMoof, o); o += newMoof.byteLength;
  out.set(newMdat, o); o += newMdat.byteLength;
  out.set(trailing, o);
  return out;
}
