# SVTA Common Media Library adoption

This note records how Playa replaced hand-rolled utility code with the SVTA
Common Media Library packages (`@svta/cml-*`), one commit per package, delivered as a stack of pull requests. For
each step: what was replaced, the line delta, what stayed local and why, the
behaviour changes, and the issues worth raising upstream.

All CML packages are regular dependencies of the consuming package. Each
package's tsup config marks every dependency `noExternal`, so the CML code is
bundled into `dist/browser`; the root `NOTICE` file carries the attribution
that the Apache-2.0 license and `@svta/cml-abr`'s dash.js notice require.

Versions adopted: `cml-utils` 1.7.0, `cml-error-codes` 0.1.2.

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

## Verification

Before every commit: `pnpm install --frozen-lockfile`, `pnpm -r build`,
`pnpm test`, `pnpm --dir packages/<p> exec tsc --noEmit` for each touched
package (including `locmaf`, which CI omits), `pnpm typecheck:tests`,
`pnpm smoke:exports`, the conformance runner typecheck, `pnpm test:corpus`,
the examples build and the node-relay typecheck.
