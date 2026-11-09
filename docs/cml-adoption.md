# SVTA Common Media Library adoption

This note records how Playa replaced hand-rolled utility code with the SVTA
Common Media Library packages (`@svta/cml-*`), one commit per package, delivered as a stack of pull requests. For
each step: what was replaced, the line delta, what stayed local and why, the
behaviour changes, and the issues worth raising upstream.

All CML packages are regular dependencies of the consuming package. Each
package's tsup config marks every dependency `noExternal`, so the CML code is
bundled into `dist/browser`; the root `NOTICE` file carries the attribution
that the Apache-2.0 license and `@svta/cml-abr`'s dash.js notice require.

Versions adopted: `cml-utils` 1.7.0, `cml-error-codes` 0.1.2, `cml-iso-bmff`
1.0.7, `cml-drm` 1.1.12 (+ peer `cml-xml` 1.2.2), `cml-throughput` 1.2.0,
`cml-abr` 0.3.0.

---

## 1. `@svta/cml-utils` — base64 and hex

**Replaced.** `encodeBase64` / `decodeBase64` take over the
`btoa(String.fromCharCode(...))` and `Uint8Array.from(atob(...), ...)` idioms
in `packages/player/src/player.ts` (three sites: the LOCMAF frame description,
the inline init decode, the CMAF pending-init decode),
`packages/player/src/player-pipeline.ts` (video and audio `configure`), and
`packages/browser/src/webcodecs-video-decoder.ts` (`toBase64`).
`arrayBufferToHex` replaces the one hex formatter whose output is
byte-for-byte identical, the contiguous `hexPreview` in the same file.

**Lines.** +26 / −14 in source (+39 / −14 with NOTICE and manifests).

**Stayed local.** The space-separated hex dumps in
`packages/browser/src/mse-adapter.ts` (`describeBoxes` head bytes, append
previews) and the example fork `examples/shared/browser/mse-adapter.ts`:
`arrayBufferToHex` has no separator option, so the output would change.

**Behaviour.** None. `decodeBase64` delegates to `atob`, so an invalid string
still throws and `decodeResolvedInlineInitData` still reports "inline init
data is not valid base64". `encodeBase64` chunks the `fromCharCode` call, which
also removes the argument-count limit the spread form had on large
descriptions.

**Upstream candidates.**
- `arrayBufferToHex(buffer: ArrayBuffer)` takes an `ArrayBuffer`, not a
  `BufferSource`/`Uint8Array`; callers with a typed-array view must copy
  (`view.slice().buffer`). A `Uint8Array` overload and an optional separator
  would cover the remaining Playa sites.

---

## 2. `@svta/cml-error-codes` — SVTA2070 mapping

**Added.** `toSvtaErrorCode(code: PlayerErrorCodeValue): SvtaErrorCode` in
`packages/player/src/errors.ts`, exported from the package index, plus an
optional `PlayerError.svtaCode` field that `createPlayerError` always stamps.
The Playa codes (0x1000+, clear of the IANA MoQT range) are unchanged.

| Playa code | SVTA2070 |
|---|---|
| CONTROL_STREAM_LOST, CONNECTION_LOST | 3001 NO_NETWORK_CONNECTION |
| DATA_STREAM_RESET | 3007 DOWNLOAD_ERROR |
| DATAGRAM_DECODE_ERROR | 2006 SEGMENT_PARSE_ERROR |
| REQUEST_UPDATE_FAILED | 3000 NETWORK_UNKNOWN |
| MEDIA_STARVED | 2034 FRAGMENT_TIMEOUT_ERROR |
| VIDEO_DECODE_ERROR / AUDIO_DECODE_ERROR | 2007 / 2008 |
| MEDIA_ELEMENT_WEDGED | 2027 BUFFER_NUDGE_ON_STALL |
| MEDIA_GAP_UNRECOVERABLE | 2026 BUFFER_SEEK_OVER_HOLE |
| CODEC_UNSUPPORTED | 2013 NO_MATCHING_CODEC |
| CATALOG_PARSE_ERROR | 2005 MANIFEST_PARSE_ERROR |
| CATALOG_DELTA_ERROR | 2018 SECONDARY_MANIFEST_PARSE_ERROR |
| CMAF_INIT_INVALID, CMAF_INIT_TIMEOUT | 2031 INITIALIZATION_SEGMENT_ERROR |
| CATALOG_WAIT_TIMEOUT | 2015 PRIMARY_MANIFEST_LOAD_TIMEOUT |
| SEEK_FAILED | 2035 LIVE_TIMESHIFT_OUT_OF_BOUNDS |
| LOAD_FAILED | 2020 TRACK_LOAD_ERROR |
| SUBSCRIPTION_REFUSED | 3010 RESOURCE_DENIED |
| ALL_TRACKS_REFUSED | 1001 MEDIA_UNAVAILABLE |

**Lines.** +86 / −1 in `errors.ts`, +38 test lines.

**Behaviour.** Additive only. `svtaCode` is optional on the interface so
hand-built `PlayerError` values stay valid.

**Upstream candidates.**
- SVTA2070 has no code for a protocol-level request failure on a persistent
  transport (REQUEST_UPDATE, SUBSCRIBE refused by a relay) nor for "catalog
  update failed"; the nearest fits (3000, 3010, 2018) are approximations. A
  MoQ/WebTransport-aware category or a "session control error" code would
  help.

---

## 3. `@svta/cml-iso-bmff` — box parsing

**Replaced in `packages/browser/src/mp4-box.ts`.** Box structure and field
parsing now go through `readIsoBoxes` with CML's `readTfhd`, `readTrun`,
`readTrex`, `readMdhd`, `readHdlr` and `readTkhd`: init-segment filtering by
handler and track_ID (`filterInitSegment`, mvex/trex filtering), trex defaults,
mdhd timescale, tfdt lookup for read and in-place patch, segment time ranges,
tfhd defaults, trun sample iteration, and the rewriter's traf/tfhd/trun
locator. The hand-written `boundedBoxes` walker and all fixed-offset field
reads are gone. Each function hands CML only the readers for the boxes it
reads (`MOOF_READERS`, `TREX_READERS`, `MDHD_READERS`, `TRAK_READERS`), so an
unrelated malformed box cannot fail an otherwise valid lookup, and each parse
is wrapped so the module's total (null, never throw) contract holds.

**Replaced in `packages/locmaf`.** `track-context.ts` reads the mdhd, hdlr
and trex fields of the CMAF Header with CML readers through a small
`readFields` adapter that converts a CML `RangeError` into the LOCMAF section 6
error at the box offset.

**Lines.** mp4-box.ts 1339 → 1208 lines (−357 / +226 after the rewrite);
track-context.ts 193 → 214. Commit total +422 / −506.

**Stayed local, and why.**
- *Top-level segment framing* in `readSegmentTimeRanges`,
  `peekSegmentMetadata` and `locateMoofMdat`: Playa clamps an overrunning
  top-level moof to the buffer (corpus vector `bmff/box-overrun` pins it),
  while CML's iterator stops at any box that overruns its container.
- *A local tfdt reader* (plugged into CML's reader map) that keeps
  `baseMediaDecodeTime` a `bigint`. CML's `readTfdt` returns a `number`,
  lossy above 2^53; unit test case 9 and corpus vector
  `bmff/frag-tfdt-v1-large` (9007199254740993) need the exact value.
- *A trun guard* (also via the reader map) that bounds `sample_count` at
  100 000 and checks the sample table against the box before CML's `readTrun`
  allocates one record per declared sample.
- *The in-place tfdt patch* and the *sample-dropping rewriter's* byte surgery
  (`rewriteFragmentDropSamples`, `rewriteTrun`): CML writers produce new boxes
  and have no splice or in-place operation; the rewriter must preserve
  unknown trailing boxes verbatim and rebase `data_offset`.
- *HEVC NAL helpers*: codec layer, not ISO BMFF.
- *LOCMAF's box walker* (`iso-box.ts`) and its section-numbered error
  reporting (`cmaf-chunk.ts`, `chunk-samples.ts`, `emsg.ts`): the unit tests
  and the corpus pin section and byte offset on malformation, and CML's
  reader silently stops on truncation (no position), misparses a box whose
  size is 1..7, treats an unknown emsg version as v0, and returns 64-bit
  values as `number`.
- *tkhd track_ID* in `track-context.ts`: CML's `readTkhd` needs the whole
  80/92-byte box; LOCMAF needs one leading field, and two synthetic fixtures
  in the repo (and plausibly minimal real headers) stop 4 bytes short.
- *tenc / frma / schm* in `track-context.ts`: CML's `readTenc` lumps
  reserved + pattern + isProtected into one 3-byte field and omits the
  version-1 pattern fields and the constant IV; `frma.dataFormat` and
  `schm.schemeType` are numbers, not fourcc strings.
- *`codecDescriptionFromInit`* (`frame.ts`): CML's `readAudioSampleEntryBox`
  does not handle the QuickTime v1/v2 sound description extensions (44/64
  fixed bytes), and sample entries of types without a reader (`av01`,
  `Opus`, `vp09`, `fLaC`, ...) come back raw with no children.

**Behaviour.** The documented contracts hold (all 1196 lines of mp4-box tests,
the BMFF corpus, the fuzz and regression suites pass unchanged). Differences
only on malformed input: CML reads a nested box with `size == 0` ("to end")
or `size == 1` (largesize) as the spec says where Playa's walker stopped; a
nested box too short for its fields now fails the enclosing parse (null)
instead of being skipped; `readMdhdTimescale` still rejects versions other
than 0/1 through an explicit check. `@openmoq/locmaf` now has a runtime
dependency (its index.ts note was updated).

**Upstream candidates.**
- 64-bit fields (`tfdt.baseMediaDecodeTime`, `emsg.presentationTime`,
  `sidx`, `mdhd` v1 times) are `number`; a `bigint` option or overload.
- `readTrun` allocates `sample_count` records with no bound check against the
  box; a trun whose flags declare no per-sample fields and a huge count is a
  memory hazard. Validate `sampleCount * recordSize <= bytesRemaining` and
  cap or lazily iterate.
- The `IsoBoxReadView` iterator throws a `RangeError` on 1..7 trailing bytes
  (header read past the end) instead of treating them as truncation, and
  misparses a box whose declared size is 1..7 (cursor moves backwards).
- Parse errors carry no byte offset or box path; spec-section style error
  reporting needs that.
- `readTenc`: expose `defaultIsProtected`, the version-1
  `defaultCryptByteBlock` / `defaultSkipByteBlock`, and `defaultConstantIv`.
- `readAudioSampleEntryBox`: honour the QuickTime v1/v2 extension sizes
  before reading child boxes.
- `frma.dataFormat` / `schm.schemeType` as fourcc strings (or export the
  inverse of `fourCcToUint32`).
- `ParsedBox` typing: a custom reader's return type is not assignable to
  `ParsedIsoBox` unless it matches an `IsoBoxMap` entry, so consumers cast.

---

## 4. `@svta/cml-drm` — EME and license requests

**Replaced in `packages/browser/src/mse-adapter.ts`.**
- Key system access goes through `getKeySystemAccess` with a configuration
  from `createMediaKeySystemConfiguration`, built from the codec strings that
  `initialize()` receives for the selected tracks (`video/mp4; codecs="…"`,
  `audio/mp4; codecs="…"`, robustness `''`, `initDataTypes: ['cenc']`). The
  former constants (`avc1.640028`, `avc3.640028`, `mp4a.40.2`) survive only as
  the fallback when an `encrypted` event arrives before `initialize()` or
  when `DrmConfig.videoCodecs` / `audioCodecs` (new optional fields) are not
  given. A video-only initialization no longer requests an audio capability.
- The default key system is `WIDEVINE_KEY_SYSTEM`.
- The license POST is a cml-drm `LicenseRequest`. For PlayReady key systems
  the challenge and HTTP headers are unwrapped from the XML key message with
  `getLicenseRequestFromMessage` / `getRequestHeadersFromMessage`; Widevine
  and ClearKey messages are posted verbatim.

**Lines.** +126 / −17 in mse-adapter.ts, +99 test lines.

**Stayed local / not adopted.**
- `getSupportedKeySystemConfiguration` relies on the legacy
  `MediaKeys.isTypeSupported` and returns nothing on current UAs.
- `parsePsshList` / `getPsshForKeySystem`: Playa never decodes the catalog's
  CMSF `contentProtections[].drmSystem.pssh` strings (the msf types document
  them as opaque, the player passes them through, and the EME path takes
  its init data from the browser's `encrypted` event). Adopting the parser
  without a consumer would be dead code. Follow-up: when the init segment
  carries no pssh, decode the catalog pssh for the selected key system and
  start the session from it; that needs a path from the player's catalog to
  the adapter's `initialize()` config.
- `getKeySystemAccess` swallows the UA's rejection reason, so the adapter
  reports its own error naming the key system and the content types it
  asked for.

**Behaviour.** `DrmConfig` is backward compatible. Setup still starts in the
constructor; it waits for the codecs from `initialize()`, and an `encrypted`
event before that resolves the wait with the defaults, so every existing
lifecycle test passes unchanged. The configuration now carries the EME
defaults explicitly (`distinctiveIdentifier`/`persistentState: 'optional'`,
`sessionTypes: ['temporary']`), which is what an unspecified configuration
meant before.

**Upstream candidates.**
- `getKeySystemAccess` should surface the last rejection (or accept an
  `onReject` callback) instead of returning `null`.
- `createMediaKeySystemConfiguration` has no `initDataTypes` parameter;
  callers spread it in.
- A PSSH-list helper that accepts base64 strings (the CMSF/DASH catalog form)
  directly would fit MoQ catalogs.

---

## 5. `@svta/cml-throughput` and `@svta/cml-abr` — estimation and ABR

**Replaced in `packages/playback`.**
- `BandwidthEstimator` (`bandwidth-estimator.ts`) is now a thin wrapper over
  `EwmaEstimator` (fast 2 s / slow 5 s half-lives, min 128 KB sampled, min
  16 KB per group, min 5 ms transfer, estimate = min(fast, slow), 0 while
  unknown). The sample is `{encodedBodySize: group bytes, duration: last
  byte − first byte}` of the group's own subgroup stream.
- `BufferBasedController` (`buffer-based-controller.ts`) keeps its interface
  (`evaluate` → `commitUpshift` / `commitDownshift`, `index`, `currentTrack`,
  `lowThresholdUs`, `highThresholdUs`, `setIndex`) and keeps Playa's buffer
  policy, but answers "does the throughput sustain a higher rung" with
  `createThroughputSelector`. Units: the ladder is reversed into cml-abr's
  ascending `bandwidth` (bps) rungs, the buffer depth is divided by 10^6, and
  `upshiftBandwidthMultiple` (2.25) becomes `upgradeFactor = 1 / 2.25` with
  `safetyFactor = max(0.9, upgradeFactor)`, which reproduces the former
  "throughput > next.bitrate × 2.25" rule exactly. A track without a bitrate
  is given 1 bps (the former rule degenerated to "throughput > 0" for it).

**Changed in `packages/player`.**
- What is measured. The three `recordGroup(bytes, now)` call sites (LOC per
  object, LOCMAF per accumulated group, CMAF per object) are gone. The player
  now times each subgroup stream of the current session: `onDataStream`
  stamps the header arrival, the raw `onObject` hook sums the bytes it
  carries, and `onStreamClosed` with `fin` on a confirmed video alias
  records one sample. Reset or locally discarded streams and audio streams
  record nothing; datagram delivery has no stream and records nothing.
- Thresholds. `abrLowBufferMs` (500), `abrHighBufferMs` (4000) and
  `abrUpshiftBandwidthMultiple` (2.25) are new `QualityConfig` options with
  defaults in `DEFAULT_PLAYER_CONFIG`; `syncBufferAbrController` reads them.
  The 15 s post-downshift stability window stays a constant.

**Lines.** bandwidth-estimator.ts 79 → 108, buffer-based-controller.ts
131 → 196, player.ts +18 / −33 at the call sites, config.ts +21. Commit
total +437 / −169 (tests and NOTICE included).

**Tests.** `buffer-based-abr.sim.test.ts` passes unchanged.
`bandwidth-adaptation.sim.test.ts` was rewritten for the new sample: it now
models a link rate (transfer time = bytes × 8 / link) with idle gaps between
groups, keeps the four original scenarios (low link, adequate link, mid-stream
drop within 10 s, bursty delivery) and adds a warm-up / degenerate-sample
case. The bursty scenario changed meaning deliberately: the 4 s gaps now
carry no information at all, so the estimate equals the per-group transfer
rate instead of a gap-diluted average. The player's ABR harness
(`feedGroups` in `player.test.ts`) models the stream open, a 200 ms transfer
and the FIN for each group so the "upshift when healthy + high bandwidth"
case still exercises an estimate. A new player test checks that a group is
sampled as bytes over header-to-FIN time and that reset and audio streams are
ignored. One assertion in `player-catalog-bootstrap.test.ts` that compared
the private `subgroupStreams` entry with `toEqual` now uses `toMatchObject`
on the ownership fields, because the entry also carries the transfer timing.

**Behaviour.**
- Estimates no longer track the current track's bitrate in steady live
  delivery because the inter-group gap is out of the measurement. When the
  publisher paces a group at real time over a long-lived stream, the transfer
  time equals the media duration and the estimate equals the track bitrate,
  which is a floor on capacity rather than the capacity; whenever a group is
  sent faster than real time (joining fetch, catch-up, a relay flushing), the
  estimate shows the link.
- A warm-up of 128 KB (and 16 KB per sample) replaces the former "5 groups"
  warm-up.
- Upshift decisions are unchanged for one-step moves; cml-abr may rate
  several rungs as sustainable, the controller still recommends the next one.

**Upstream candidates.**
- `BitrateSelector` has no way to declare the current rung except through
  `sample()`, so a controller that owns the index must send a bandwidth-only
  sample before each `select()`. A `select` input field (or a `setCurrent`)
  would remove that.
- A MoQ-friendly throughput sample. CML's `ResourceTiming` models a request
  with `startTime`, `duration`, `responseStart`. A subgroup stream has a
  header time, a FIN time, the bytes carried, and the media duration those
  bytes represent. An estimator that knows the media duration could discard
  samples where transfer time ≈ media duration (publisher-paced, says nothing
  about the link) and keep only bandwidth-bound transfers, or report a
  "lower bound" flag. Playa's `BandwidthEstimator.recordGroup` is the shape
  such a sample would take.
- `createThroughputSelector` throws `RangeError` on a ladder with a
  non-positive bandwidth; manifests with unknown bitrates are common in MoQ
  catalogs, so a documented "unknown" convention would help.

---

## Verification

Before every commit: `pnpm install --frozen-lockfile`, `pnpm -r build`,
`pnpm test`, `pnpm --dir packages/<p> exec tsc --noEmit` for each touched
package (including `locmaf`, which CI omits), `pnpm typecheck:tests`,
`pnpm smoke:exports`, the conformance runner typecheck, `pnpm test:corpus`,
the examples build and the node-relay typecheck.
