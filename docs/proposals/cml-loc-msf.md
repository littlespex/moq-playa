# Proposal: Move LOC and MSF from Playa into the SVTA Common Media Library

Status: draft for the SVTA Players and Playback working group and the CML Project Managers.
Requested by Casey Occhialini. Source repository: `openmoq/moq-playa` at version 0.6.1.

If the group wants to proceed, this document becomes `rfc/moq-loc-msf.md` in the CML repository with `status: draft` frontmatter, following `rfc/README.md`. The CML RFC outline (Summary, Motivation, Guide-level, Reference-level, Drawbacks, Alternatives, Unresolved questions) maps onto sections 1, 4, 5, 6, 13 below. Sections 7 through 12 would move to `plans/moq-loc-msf/` since CML keeps implementation detail out of RFCs.

## 1. Summary and motivation

Playa is Red5's TypeScript implementation of Media over QUIC Transport. Two of its packages are not transport code at all. `@openmoq/loc` parses and encodes Low Overhead Container header properties and produces WebCodecs chunk descriptors. `@openmoq/msf` parses MoQ Streaming Format catalogs, applies delta updates, selects tracks and parses timeline tracks. Both are pure TypeScript with no browser dependency, and both implement IETF drafts rather than Playa policy.

That is exactly the kind of code CML exists to hold. `SCOPING.md` names a home for SDKs for emerging standards, with C2PA and MoQ as its examples, as in scope. It also gives the reason for the whole library: hls.js, dash.js and Shaka each wrote their own ID3, 608 and CMCD code, and bugs fixed in one player survived in the others. MoQ players are now at the same point. Every MoQ client has to parse the catalog JSON and decode LOC properties, and today each one does it alone. moq-rs, LibMoQ and Playa already disagree on details that a shared library would settle once, such as how a duplicate property id resolves or whether `"draft-01"` is an acceptable catalog version string.

Why now. The code is small enough to review in full (1,041 source lines for LOC, 2,444 for the parts of MSF proposed here, 511 for the wire primitives), and a conformance corpus of 139 relevant vectors already exists, written against the drafts rather than against the implementation. Waiting for the drafts to become RFCs means every MoQ player ships its own parser first and then has to migrate.

## 2. Scope: three packages

The proposal moves three units, published as three npm packages.

**`@svta/cml-moq-wire`.** The MoQT integer and property-block primitives: `packages/transport/src/primitives/varint.ts` (RFC 9000 QUIC varint, a branded `bigint`), `vi64.ts` (the draft-18 vi64 integer) and `property-block.ts` (the ordered Key-Value-Pair codec with three wire profiles). LOC needs these; nothing else in CML provides them. `@svta/cml-utils` has hex, base64 and UUID helpers but no byte readers or varints. I considered `@svta/cml-varint`, but that name is wrong for a package whose main export is a property-block codec and whose vi64 codec is MoQT-specific, not QUIC. `moq-wire` says what it is and leaves room for a future `cml-moq-transport` without implying one exists.

**`@svta/cml-loc`.** All of `packages/loc/src`.

**`@svta/cml-msf`.** `packages/msf/src` minus the catalogformat-01 code (section 5).

CML names libraries by the short name of the standard: `cmcd`, `cmsd`, `webvtt`, `iso-bmff`. LOC and MSF have short names, so `cml-loc` and `cml-msf` follow the rule. The alternative is a `moq-` prefix on all three, which groups them in `libs/`. I recommend the unprefixed names because the docs site already groups packages through `site/scripts/groups.ts`, so grouping does not need to live in the package name.

Dependency direction follows CML practice: inter-library dependencies are `peerDependencies` set to `*` in the repo, which the Publish workflow rewrites to a caret range. `cml-loc` declares a peer on `cml-moq-wire` for `decodePropertyBlock`, `encodePropertyBlock` and the `PropertyWireProfile`, `PropertyEntry` and `PropertyMap` types. These are the only four symbols `packages/loc/src/headers.ts` and `property-map.ts` import from transport. `cml-msf` has no peers. `cml-moq-wire` has no peers. No package has a runtime `dependencies` field.

## 3. Non-goals

**`@openmoq/transport`, `@openmoq/webtransport`, `@openmoq/quic`.** Transport is a sans-I/O MoQT state machine for four draft versions. It is a protocol stack, not a utility, and it is still changing on every draft. CML's scoping document excludes "a working media player"; a transport implementation is the same kind of thing one level down. The 511 lines of primitives are extracted precisely so that transport does not have to come along.

**`@openmoq/playback`, `@openmoq/player`, `@openmoq/browser`, `@openmoq/playa`.** These are the player. Out of scope by the scoping document.

**`@openmoq/locmaf`.** LOCMAF (draft-einarsson-moq-locmaf) is an individual draft, not a working-group document, and the Eyevinn reference implementation is the de facto spec. It can be proposed later if it is adopted. One consequence for MSF is covered in section 4: the `LOCMAF_VERSION` constant that `packages/msf/src/types.ts` duplicates from `packages/locmaf/src/fields.ts` does not move.

**catalogformat-01.** See section 5.

## 4. API surface per package

### `@svta/cml-moq-wire`

Exports from the three primitive files: `varint`, `readVarint`, `writeVarint`, `varintEncodingLength`, `MAX_VARINT`, the `Varint` brand type; `readVi64`, `writeVi64`, `vi64EncodingLength`, `MAX_VI64`; `decodePropertyBlock`, `encodePropertyBlock`, `propertyBlockEncodingLength`, `canonicalOrder`, `MAX_ODD_VALUE_BYTES`, `PropertyWireError`, and the types `PropertyValue`, `PropertyEntry`, `PropertyMap`, `PropertyWireProfile`, `PropertyErrorCategory`. No renames. `PropertyWireError` already carries a machine-readable `category`, which is the error pattern I propose for the other two packages.

### `@svta/cml-loc`

The current export list from `packages/loc/src/index.ts` is 10 types and 18 values (Appendix A). Proposed changes:

- Drop `LocExtensionId`. It is a deprecated alias of `Loc01PropertyId` and CML has no reason to inherit a deprecation.
- Rename `LocExtensionValue` to `LocPropertyValue`. "Extension header" is draft-16 transport vocabulary. LOC-04 and the rest of this API say "property".
- Drop `LocHeaderOptions.deltaEncoded`. `wireProfile` subsumes it, and a three-value union is better for autocomplete than a boolean plus an override. The default stays `d16-delta-varint`.
- Keep `bigint`. Property ids are 64-bit on draft-18 and `LocHeaders.unknown` preserves them losslessly. LOC-04 `timestamp` in arbitrary `timescale` units is also not safely a `number`. The WebCodecs boundary already converts: `toVideoChunkInit` returns `timestamp: number` and keeps the exact value in `SourceTimestamp`.
- Keep `LocHeaderError` and `LocEncodeError` as classes. They carry a `field` name, which is what callers log on. Add a `code` union to each so tests and conformance vectors compare on codes rather than message text. The conformance corpus README already mandates this rule for its own vectors.
- Fix silent truncation on import. `parseVideoFrameMarking` and `parseAudioLevel` in `video.ts` and `audio.ts` mask oversize integers to 16 or 8 bits. Two corpus vectors pin this as a regression. The proposal is to throw `LocHeaderError` for out-of-range values and re-author those two vectors as normative.

### `@svta/cml-msf`

The current export list from `packages/msf/src/index.ts` is 27 types and 27 values (Appendix A). Proposed changes:

- Drop `parseCatalog`. It is a backward-compat alias of `parseMsfCatalog`.
- Drop `parseCatalogFormat01`, `applyCf01Patch`, `Cf01ParseResult` and `parseCatalogAuto`. The first three are catalogformat-01. `parseCatalogAuto` only exists to dispatch to cf01 by sniffing for a `streamingFormat` key; without cf01 it is `parseMsfCatalog`.
- Drop `LOCMAF_VERSION` and `SUPPORTED_LOCMAF_VERSIONS`. `isTrackPackagingSupported` gets an options parameter, `{ locmafVersions?: readonly string[] }`, and the caller that cares about LOCMAF supplies the list. This removes the duplicate constant and the hidden coupling to a package that is not moving.
- Rename the MSF-00 delta dialect for symmetry with MSF-01: `CatalogDelta` to `Msf00Delta`, `parseDeltaUpdate` to `parseMsf00Delta`, `applyCatalogUpdate` to `applyMsf00Delta`, `isDelta` to `isMsf00Delta`. Section 6 explains the naming rule.
- Record the source profile. `Catalog` and `CatalogState` gain `readonly profile: 'msf-00' | 'msf-01'`, set from whether `version` was the numeric `1` (MSF-00) or the string `"1"` or `"draft-01"` (MSF-01). The parser already distinguishes these in `normalizeMsfVersion` in `catalog-msf00.ts` and then throws the information away. The player's `CatalogManager` has to know which delta dialect to expect, and today it guesses from the next document. CMSF is deliberately not a profile value: a CMSF catalog is an MSF catalog with extra fields, and detecting it from content would be a heuristic.
- Keep `number`. Catalog values arrive through `JSON.parse`, which produces doubles. Converting to `bigint` after the fact would add no precision, and all MSF numeric fields (bitrate, width, milliseconds) fit comfortably in 53 bits.
- Replace bare `Error` with one `MsfCatalogError` class carrying `code` and `path`. The MSF parser currently throws `Error` with the draft section number embedded in the message. CML's API guidance says error messages must name the parameter, the expected values and the received value; a code field makes that checkable.
- Keep `buildCatalog` but tag it `@beta`. It does not emit `contentProtections`, `publishTracks`, `template`, `targetLatency` or `depends`, so it cannot round-trip a catalog the parser accepts. Completing it is an issue to file, not a reason to leave it behind.
- Keep selection (`groupByRender`, `groupByAlt`, `selectVideoAltGroup`, `selectTrack`, `resolveDependencies`). This is not ABR. It implements the `renderGroup`, `altGroup` and `depends` semantics that the MSF draft defines, and `@svta/cml-abr`, which picks a ladder index from throughput and buffer, does not cover it. Keep timeline parsing for the same reason: the formats are MSF sections 7 and 8 and a CMSF section.
- Keep the CMSF content-protection types (`CmsfContentProtection`, `CmsfDrmSystem`, `CmsfUrlRef`) with `pssh` and `systemID` as opaque strings. `@svta/cml-drm` already has `parsePsshList` and the key-system UUID constants, and a consumer can hand the strings to it. MSF should not grow a second PSSH parser.
- Keep `catalog-validate.ts` internal. Its finite-number walk stops silently at depth 8. On import it should throw at the limit instead, since a silent stop means a deep enough document bypasses the check.

## 5. Dependency plan

**Severing transport.** `cml-loc` imports its four symbols from `cml-moq-wire`. In Playa, `@openmoq/transport` re-exports the same primitives from `@svta/cml-moq-wire` so that the 31 transport source files that import `primitives/varint.js`, `vi64.js` or `property-block.js` keep working. The `Varint` brand survives because the brand is defined in `varint.ts`, which moves whole. Phase 0 in section 12 does this refactor inside Playa before anything goes to CML, so the extraction is tested in the repository that depends on it most.

**fast-json-patch.** This is the only third-party runtime dependency in the Playa workspace. It is used in one function, `applyCf01Patch` in `packages/msf/src/catalog-cf01.ts`, for RFC 6902 JSON Patch. CML libraries have no third-party runtime dependencies. Three options:

1. Drop catalogformat-01 from the CML package. 619 source lines and 830 test lines stay in Playa.
2. Inline a minimal RFC 6902 subset (`add`, `remove`, `replace`, `move`, `copy`, `test` over JSON Pointer), about 150 lines plus tests.
3. Publish `@svta/cml-msf-cf01` separately with the dependency.

Recommendation: option 1. catalogformat-01 is the superseded predecessor of MSF. The file header in `catalog-cf01.ts` describes it as "the legacy catalog format used by draft-14 era servers". It carries a different delta model from either MSF dialect, it is the only reason `parseCatalogAuto` exists, and it is a fifth of the MSF source. CML should not take on a format that the working group has already replaced. Option 2 is the fallback if the group disagrees, and it is cheap. Option 3 violates CML's no-third-party-dependency rule for no gain. In Playa, cf01 moves into `packages/player` next to its only consumer, `catalog-manager.ts`.

## 6. Specification and draft-version policy

CML has no precedent for tracking IETF drafts. CMCD and CMSD are published CTA specs; C2PA is a versioned spec with a conformance program. LOC and MSF will change under us, so the policy has to be written down before the first release.

**Code targets.** Today the code implements LOC-01 and LOC-04 (`LocVersion = 1 | 4` in `types.ts`), MSF-00 and MSF-01 (numeric and string `version`), the CMSF-00 and CMSF-01 extension fields, and MoQT property wire profiles for drafts 14, 16 and 18. LOC-02 and LOC-03 are not implemented. The conformance corpus README documents interpretation policies for LOC-02 that have no code behind them yet.

**Version numbers and release tags.** Publish all three at 0.x and stay there until the LOC and MSF drafts reach RFC. In 0.x a minor bump may remove a draft; after 1.0 it requires a major. Within each package, the version-neutral API is `@public`: `parseLocHeaders`, `LocHeaders`, `parseMsfCatalog`, `Catalog`, selection and timeline functions. Anything whose name carries a draft number is `@beta` until that draft is in working-group last call: `Loc01PropertyId`, `Loc04PropertyId`, `parseMsf00Delta`, `parseMsf01Delta`, `locWireProfileForDraft`. CML already runs api-extractor, so the tags appear in `config/cml-<name>.api.md` and reviewers see every change.

**Supported-draft window.** Support the current working-group draft plus any earlier draft with a deployed implementation that the group names. Today that is LOC-01 (deployed) and LOC-04 (current in the code), MSF-00 and MSF-01. Dropping a draft needs a CHANGELOG migration note and a release of the package before the removal, which matches the existing CML changelog rule.

**Naming.** A draft-specific export carries the two-digit draft number: `Loc04PropertyId`, `Msf01Delta`, `applyMsf01Delta`. A version-neutral export does not: `parseLocHeaders` auto-detects, `parseMsfCatalog` accepts both version spellings. Type names for the profile field use the same tokens the conformance corpus uses: `'loc-01'`, `'loc-04'`, `'msf-00'`, `'msf-01'`.

## 7. Conventions migration checklist

Everything here is mechanical but not small. CML's one-unit-per-file rule turns 7 LOC files into roughly 30 and 9 MSF files into roughly 70.

- Formatting: tabs, no semicolons, single quotes. Playa uses semicolons and mixes 2-space (`property-map.ts`, `catalog-builder.ts`) and 4-space indentation. `vp fmt` fixes all of it.
- Import extensions: `.ts`, not `.js`. Every relative import changes.
- One unit per file, named for the export: `parseLocHeaders.ts`, `LocHeaders.ts`, `Loc04PropertyId.ts`. `headers.ts` becomes five files; `types.ts` becomes one file per type. Internal helpers that are not exported from `index.ts` (for example `validateReferences` and `extractRecognizedOptionalFields` in `catalog-msf00.ts`) get their own files but stay out of the index.
- Named exports, PascalCase types, camelCase functions. Already true.
- TSDoc: add `@public` or `@beta` to every export, add `@example` blocks using `{@includeCode ../test/<file>.test.ts#example}`, and mark the example regions in tests with `// #region example`. The existing `@see draft-ietf-moq-loc-04 §2.3` references are fine and should stay.
- Prose: CML's writing rules forbid em dashes and the `§` sign is fine, but the box-drawing section banners (`// ─── Types ───`) and the many em dashes in comments go.
- Lint: `vp lint --type-aware` will reject the `(result as any).layerId` cast in `video.ts` and the `as` narrowing in `catalog-cf01.ts`. Fix the first; the second does not move.
- Tests: `vitest` to `vp test`, which is Vitest-compatible. Tests move from co-located `src/*.test.ts` to `libs/<name>/test/`, and they import from the built package name rather than from source, because CML tests run against `dist/`.
- Per-package `CHANGELOG.md` with an `## [Unreleased]` section, `README.md` with a `## When to use` section of one to eight bullets naming exports, `NOTICE.md`, `LICENSE`, `tsdoc.json`, `tsconfig.json`, `config/` for the api-extractor report, and an entry in `site/scripts/groups.ts`.
- Node 24 for development, `npm` not `pnpm`, TypeScript 6.0.3 in the repo while the public types must stay valid under TypeScript 5.7.
- DCO sign-off on every commit (`git commit -s`) and Conventional Commits. Playa has neither; none of its 126 commits carry a Signed-off-by trailer.

## 8. Test and fixture migration

**Unit suites.** All seven LOC test files move (1,402 lines). For MSF, ten of twelve test files move (4,326 lines); `catalog-cf01.test.ts` and `catalog-detect.test.ts` stay with cf01. For the wire package, `property-block.test.ts`, `varint.test.ts` and `vi64.test.ts` move (636 lines). The LOC tests currently import `varint`, `writeVarint` and `decodePropertyBlock` from `@openmoq/transport`; they import from `@svta/cml-moq-wire` instead.

**Conformance vectors.** `conformance/media` is a language-neutral corpus, schema `moq-media-corpus/1`, with one `manifest.json` per domain and a JSON Schema in `conformance/media/schema/corpus-manifest.schema.json`. Three domains are relevant: `properties` (33 property-block decode vectors across transport drafts 14, 16 and 18), `loc` (51 vectors, 47 property-level and 4 semantic, all spec-derived), and `catalog` (55 vectors, of which 3 are cf-01 and 14 are the LibMoQ imports). Each vector carries a `provenance` block (class, source draft, section, generator, source hash) and an `expectationBasis` of normative, interpretation or regression.

Proposal: keep the format. Each CML package gets `test/fixtures/manifest.json` in the same schema plus the vector files, a copy of the schema, and one test that loads the manifest and runs the package's exec seam. The corpus runner's `loc-exec.ts`, `property-exec.ts` and `catalog-exec.ts` are the templates, minus their differential and probe-protocol plumbing, which is Playa-specific. The provenance blocks move unchanged; they are the record that the expectations were authored from the drafts and not captured from Playa, which is the property that makes them worth having in a shared library. Wide integers stay decimal strings, as the schema requires.

**LibMoQ fixtures.** Fourteen catalog vectors were copied byte-for-byte from `openmoq/moq5` at commit `455318c`, path `media/msf/tests/fixtures`, and `conformance/media/provenance/LIBMOQ-MSF-FIXTURES.md` pins their hashes. Neither that file nor its JSON sibling records a license. They cannot enter CML until one of three things happens: the moq5 repository's license is confirmed as Apache-2.0 or another permissive license and recorded in the provenance file and in `cml-msf/NOTICE.md`, following the pattern `libs/iso-bmff/NOTICE.md` uses for codem-isoboxer; or the LibMoQ authors grant explicit permission; or the fourteen are left out and replaced with spec-derived equivalents, which is feasible because every one of them exercises a shape the 41 spec-derived vectors could cover with a few additions. The Eyevinn LOCMAF vectors are MIT-licensed but belong to `locmaf`, which does not move.

**Property-based tests.** `fast-check` is a Playa root devDependency but neither `loc` nor `msf` uses it. `packages/transport/src/primitives/codec-properties.test.ts` (109 lines) already has round-trip properties for varint and vi64, using arbitraries from `packages/transport/src/testkit/arbitraries.ts`, and can move with the wire package. I recommend adding `fast-check` as a CML root devDependency, extending those properties to the property block over all three profiles, and adding one for LOC (`encodeLocHeaders` then `parseLocHeaders` is identity under LOC-04). These are the tests that catch the value-64 boundary bugs that the draft-18 vi64 wiring had. MSF gains less; a parser-does-not-crash property over arbitrary JSON is enough. CML has no property-testing dependency today, so this is a policy question for the Project Managers.

## 9. Documentation plan

Each package follows the CML README template: description, install, quick start, `## When to use` with export names per bullet, closing paragraph. `scripts/agentDocs.ts` reads that section to regenerate `skills/common-media-library`, and the site publishes `llms.txt` from the same material, so the `When to use` bullets are the `llms.txt` entry.

Guides under `libs/<name>/docs/`, each a typechecked TypeScript example with a `.context.d.ts` for reader-supplied values:

- `cml-loc`: "Parsing LOC properties across MoQT drafts" (choosing a `PropertyWireProfile`, LOC-01 versus LOC-04 detection, track-scoped defaults) and "Building WebCodecs chunks from LOC objects" (`toVideoChunkInit`, `SourceTimestamp`).
- `cml-msf`: "Catalog lifecycle" (independent catalog, then MSF-00 or MSF-01 deltas into a `CatalogState`) and "Choosing tracks" (`renderGroup`, `altGroup`, `depends`).
- `cml-moq-wire`: one guide on the property block, mostly for people writing the next MoQ container format.

TypeDoc picks up the TSDoc, with `tsdoc.json` extending `typedoc/tsdoc.json` as in the other libraries. Every `@see draft-ietf-moq-...` tag should carry the datatracker URL so the site renders a link.

## 10. Governance and people

**Authorship and license.** Playa is Apache-2.0 with the license text in `LICENSE.txt`, copyright OpenMOQ, authored primarily by Raymond Lucke at Red5. Of the commits touching `packages/loc`, `packages/msf` and the three primitive files, 17 are by Raymond Lucke, 4 by Paul Gregoire and 1 by Todd Anderson. Apache-2.0 into Apache-2.0 needs no relicensing. Each package's `NOTICE.md` records "Contains code derived from Playa (openmoq/moq-playa)" with the OpenMOQ copyright line, the same way `libs/iso-bmff/NOTICE.md` credits codem-isoboxer.

**DCO.** CML requires a Signed-off-by trailer on every commit. Playa has none. The DCO's clause (b) lets a contributor certify that the contribution is based on prior work under a compatible open-source license, so the person opening the import PR can sign for it. It is still better practice to have the three authors above add their own sign-off or an acknowledgement on the PR, and I recommend asking.

**Committers and reviewers.** Committers must represent SVTA member companies, and every PR needs two SVTA-approved reviewers. Whether Red5 is an SVTA member decides whether Raymond Lucke can be a committer or only a contributor; I could not confirm it and it is an open question. Casey Occhialini is a CML author and reviewer but should not be the PR author, so that she can count as one of the two reviewers. The second reviewer needs enough MoQ context to check a property-block decoder against draft-18; the group should name that person before phase 2.

**Maintenance.** Proposed: Red5 maintains the code and tracks the drafts, and the CML Project Managers approve releases per the governance model. If Red5 cannot hold a committer role, Red5 contributes and Paramount sponsors the committer seat. Adopting a new codebase is a Project Manager decision on contributor consensus, which is what this document asks for.

## 11. Relationship to `@openmoq/*` afterwards

Playa already has a pattern for this. `packages/compat-loc` and `packages/compat-msf` are thin packages that re-export `@openmoq/loc` and `@openmoq/msf` under the old `@moqt/*` names, and `scripts/smoke-compatibility.mjs` checks that the re-exports are identical. The same pattern applies one level up.

- `@openmoq/loc` becomes a re-export of `@svta/cml-loc` for one minor release, then is deprecated on npm using the `_migration/step9_deprecate_old_scopes.sh` approach (a registry deprecation notice, not an unpublish).
- `@openmoq/msf` becomes a re-export of `@svta/cml-msf` plus nothing else, since cf01 moves to `packages/player`. Same deprecation path.
- `@openmoq/transport` re-exports the primitives from `@svta/cml-moq-wire` indefinitely. Its public API already exposes `varint`, `readVi64` and the property-block functions, so consumers do not change.
- Playa's own imports in `packages/player`, `packages/playback`, `packages/browser` and `packages/playa` switch to `@svta/*` directly. The vitest aliases in `vitest.config.ts` that point `@openmoq/loc` and `@openmoq/msf` at workspace source are removed, because the source is no longer in the workspace.

Renames in section 4 land on the Playa side in the same change: `parseDeltaUpdate` becomes `parseMsf00Delta`, `isTrackPackagingSupported` takes its options, and `CatalogManager` reads `catalog.profile` instead of sniffing.

## 12. Phased plan

**Phase 0: sever the dependency inside Playa.** Create `packages/moq-wire` in Playa with the three primitive files and their tests; make `@openmoq/loc` and `@openmoq/transport` depend on it. Acceptance: `packages/loc/src` imports nothing from `@openmoq/transport`; `pnpm test` and `pnpm test:corpus` pass; `pnpm smoke:exports` shows no change in the public export set of `@openmoq/transport`.

**Phase 1: RFC.** Open `rfc/moq-loc-msf.md` in CML with `status: draft` on branch `rfc/moq-loc-msf`, PR titled `[RFC] MoQ LOC and MSF`. Acceptance: Final Decision recorded, status `accepted`, the open questions in section 13 answered.

**Phase 2: `@svta/cml-moq-wire`.** Acceptance: builds; unit tests and the 33 `properties` vectors pass; api.md reviewed; README with `When to use`; CHANGELOG; `groups.ts` entry; first manual publish and trusted publisher configured per AGENTS.md.

**Phase 3: `@svta/cml-loc`.** Acceptance: the 51 `loc` vectors pass, including the two re-authored truncation vectors; no import from any transport package; draft-specific exports tagged `@beta`; the two guides typecheck.

**Phase 4: `@svta/cml-msf`.** Acceptance: the 38 spec-derived non-cf01 `catalog` vectors pass; the 14 LibMoQ vectors are included only if the license question is closed; no `dependencies` field; `profile` populated on every parsed catalog; `buildCatalog` tagged `@beta` with issues filed for the missing fields.

**Phase 5: Playa switches.** `@openmoq/loc` and `@openmoq/msf` become re-exports; cf01 moves to `packages/player`; all Playa imports use `@svta/*`. Acceptance: `pnpm test`, `pnpm test:corpus` and `pnpm smoke:exports` pass; the browser acceptance suite passes.

**Phase 6: deprecation.** One Playa minor release after phase 5, the `@openmoq/loc` and `@openmoq/msf` packages carry an npm deprecation notice pointing to `@svta/*`.

## 13. Risks and open questions

**Draft churn.** A LOC-05 or MSF-02 that changes property ids or the delta shape will land while this migration is in flight. Mitigation: the version-neutral API is small and the draft-specific exports are `@beta`, so a new draft is additive until the group chooses to drop an old one. Risk remains that two repositories carry the code for the duration of phases 2 through 5 and fixes have to be applied twice. Keeping that window to one release cycle is the mitigation.

**Reviewer bandwidth.** CML needs two SVTA-approved reviewers who can check a vi64 decoder and a catalog parser against the drafts. If the group cannot name a second reviewer, the proposal stalls at phase 2 regardless of code quality.

**Red5 membership.** Open. Decides committer status and therefore who merges and releases.

**LibMoQ fixtures.** Open. Decides whether 14 of 55 catalog vectors come along or get re-authored.

**The truncation fix and the regression pins.** Changing `parseVideoFrameMarking` and `parseAudioLevel` to throw on oversize values is a behavior change, and the corpus has two regression vectors that pin the current masking. The proposal is to make the change on import and re-author the vectors as normative. The group may prefer to keep the lenient behavior; either is fine as long as the vectors say which.

**Toolchain gap.** CML develops on Node 24, TypeScript 6.0.3 and Vite+. Playa is on Node 20, TypeScript 5.7 and tsup. Public types must stay valid for TypeScript 5.7 consumers, which the api-extractor report will catch, but the 5.7 floor has to be tested, not assumed.

**fast-check as a CML devDependency.** A policy decision for the Project Managers, not a technical one.

**`buildCatalog` completeness.** Shipping an encoder that cannot produce what the decoder accepts is a known gap. `@beta` is honest about it. Holding the builder back until it is complete would leave publishers with nothing, so I do not recommend it.

**Interop disputes become CML issues.** The 36 catalog vectors with `expectationBasis: interpretation` document Playa's reading where the drafts are ambiguous. Once the code is shared, moq-rs and LibMoQ will contest some of them, and the group should expect that.

## Appendix A: export mapping

### `@openmoq/loc` to `@svta/cml-loc`

| Current export | Kind | Proposed home | Rename or action |
|---|---|---|---|
| `VideoFrameMarking` | type | `cml-loc` | none |
| `AudioLevel` | type | `cml-loc` | none |
| `LocHeaders` | type | `cml-loc` | none |
| `LocExtensionValue` | type | `cml-loc` | rename to `LocPropertyValue` |
| `LocTrackContext` | type | `cml-loc` | none |
| `LocVersion` | type | `cml-loc` | none, `@beta` |
| `SourceTimestamp` | type | `cml-loc` | none |
| `VideoChunkInit` | type | `cml-loc` | none |
| `AudioChunkInit` | type | `cml-loc` | none |
| `LocHeaderOptions` | type | `cml-loc` | drop `deltaEncoded` field |
| `LocExtensionId` | const | dropped | deprecated alias of `Loc01PropertyId` |
| `Loc01PropertyId` | const | `cml-loc` | none, `@beta` |
| `Loc04PropertyId` | const | `cml-loc` | none, `@beta` |
| `LocHeaderError` | class | `cml-loc` | add `code` |
| `LocEncodeError` | class | `cml-loc` | add `code` |
| `parseLocHeaders` | function | `cml-loc` | none |
| `encodeLocHeaders` | function | `cml-loc` | none |
| `toVideoChunkInit` | function | `cml-loc` | none |
| `toAudioChunkInit` | function | `cml-loc` | none |
| `locWireProfileForDraft` | function | `cml-loc` | none, `@beta` |
| `resolveLocHeaders` | function | `cml-loc` | none |
| `locHeadersToPropertyMap` | function | `cml-loc` | none |
| `parseVideoFrameMarking` | function | `cml-loc` | throw on value above 16 bits |
| `encodeVideoFrameMarking` | function | `cml-loc` | none |
| `parseVideoFrameMarkingBytes` | function | `cml-loc` | none |
| `encodeVideoFrameMarkingBytes` | function | `cml-loc` | none |
| `parseAudioLevel` | function | `cml-loc` | throw on value above 8 bits |
| `encodeAudioLevel` | function | `cml-loc` | none |

### `@openmoq/msf` to `@svta/cml-msf`

| Current export | Kind | Proposed home | Rename or action |
|---|---|---|---|
| `Packaging` | type | `cml-msf` | none |
| `TrackRole` | type | `cml-msf` | none |
| `CatalogTrack` | type | `cml-msf` | none |
| `Catalog` | type | `cml-msf` | add `profile` |
| `RemoveTrackRef` | type | `cml-msf` | none |
| `CatalogDelta` | type | `cml-msf` | rename to `Msf00Delta`, `@beta` |
| `CatalogObject` | type | `cml-msf` | rename to `Msf00CatalogObject`, `@beta` |
| `CatalogState` | type | `cml-msf` | add `profile` |
| `RenderGroup` | type | `cml-msf` | none |
| `AltGroup` | type | `cml-msf` | none |
| `TrackConstraints` | type | `cml-msf` | none |
| `MediaTimelineEntry` | type | `cml-msf` | none |
| `EventIndex` | type | `cml-msf` | none |
| `EventTimelineRecord` | type | `cml-msf` | none |
| `SapTimelineEntry` | type | `cml-msf` | none |
| `MsfMediaTemplate` | type | `cml-msf` | none, `@beta` |
| `MsfInitDataEntry` | type | `cml-msf` | none, `@beta` |
| `CmsfUrlRef` | type | `cml-msf` | none, `@beta` |
| `CmsfDrmSystem` | type | `cml-msf` | none, `@beta` |
| `CmsfContentProtection` | type | `cml-msf` | none, `@beta` |
| `Msf01Delta` | type | `cml-msf` | none, `@beta` |
| `Msf01DeltaOp` | type | `cml-msf` | none, `@beta` |
| `Msf01DeltaOpKind` | type | `cml-msf` | none, `@beta` |
| `Cf01ParseResult` | type | stays in Playa (`packages/player`) | catalogformat-01 |
| `CatalogBuilderTrack` | type | `cml-msf` | `@beta` |
| `CatalogBuilderInitDataEntry` | type | `cml-msf` | `@beta` |
| `BuildCatalogOptions` | type | `cml-msf` | `@beta` |
| `MSF_VERSION` | const | `cml-msf` | none |
| `CATALOG_TRACK_NAME` | const | `cml-msf` | none |
| `CMSF_SAP_EVENT_TYPE` | const | `cml-msf` | none, `@beta` |
| `LOCMAF_VERSION` | const | dropped | belongs to `@openmoq/locmaf` |
| `SUPPORTED_LOCMAF_VERSIONS` | const | dropped | replaced by an options parameter |
| `parseMsfCatalog` | function | `cml-msf` | sets `profile` |
| `isDelta` | function | `cml-msf` | rename to `isMsf00Delta`, `@beta` |
| `parseCatalog` | function | dropped | alias of `parseMsfCatalog` |
| `parseCatalogFormat01` | function | stays in Playa (`packages/player`) | catalogformat-01 |
| `applyCf01Patch` | function | stays in Playa (`packages/player`) | catalogformat-01, uses fast-json-patch |
| `parseCatalogAuto` | function | dropped | only existed to dispatch to cf01 |
| `parseMsf01Delta` | function | `cml-msf` | none, `@beta` |
| `applyMsf01Delta` | function | `cml-msf` | none, `@beta` |
| `buildCatalog` | function | `cml-msf` | `@beta`, incomplete field coverage |
| `parseDeltaUpdate` | function | `cml-msf` | rename to `parseMsf00Delta`, `@beta` |
| `applyCatalogUpdate` | function | `cml-msf` | rename to `applyMsf00Delta`, `@beta` |
| `groupByRender` | function | `cml-msf` | none |
| `groupByAlt` | function | `cml-msf` | none |
| `selectVideoAltGroup` | function | `cml-msf` | none |
| `selectTrack` | function | `cml-msf` | none |
| `resolveDependencies` | function | `cml-msf` | none |
| `isTrackPackagingSupported` | function | `cml-msf` | add `{ locmafVersions }` options |
| `parseMediaTimeline` | function | `cml-msf` | none |
| `parseEventTimeline` | function | `cml-msf` | none |
| `parseSapTimeline` | function | `cml-msf` | none, `@beta` |
| `findLocationForPts` | function | `cml-msf` | none |
| `mergeMediaTimeline` | function | `cml-msf` | none |

New in `cml-msf`: `MsfCatalogError` class with `code` and `path`; `profile` field on `Catalog` and `CatalogState`.

## Appendix B: files that move

Line counts from `wc -l` at Playa 0.6.1. Each source file is split per CML's one-unit-per-file rule on arrival, so the destination file count is larger.

### To `@svta/cml-moq-wire`

| File | Lines |
|---|---:|
| `packages/transport/src/primitives/property-block.ts` | 241 |
| `packages/transport/src/primitives/varint.ts` | 171 |
| `packages/transport/src/primitives/vi64.ts` | 99 |
| `packages/transport/src/primitives/property-block.test.ts` | 187 |
| `packages/transport/src/primitives/varint.test.ts` | 315 |
| `packages/transport/src/primitives/vi64.test.ts` | 134 |
| `conformance/media/vectors/properties/manifest.json` (33 vectors) | |
| Source total | 511 |
| Test total | 636 |

### To `@svta/cml-loc`

| File | Lines |
|---|---:|
| `packages/loc/src/audio.ts` | 48 |
| `packages/loc/src/errors.ts` | 24 |
| `packages/loc/src/headers.ts` | 242 |
| `packages/loc/src/index.ts` | 47 |
| `packages/loc/src/property-map.ts` | 232 |
| `packages/loc/src/types.ts` | 289 |
| `packages/loc/src/video.ts` | 159 |
| `packages/loc/src/audio.test.ts` | 88 |
| `packages/loc/src/chunk-timestamp.test.ts` | 99 |
| `packages/loc/src/compatibility.test.ts` | 61 |
| `packages/loc/src/headers.test.ts` | 658 |
| `packages/loc/src/property-map.test.ts` | 139 |
| `packages/loc/src/types.test.ts` | 35 |
| `packages/loc/src/video.test.ts` | 322 |
| `conformance/media/vectors/loc/` (manifest plus 10 `.bin` files, 51 vectors) | |
| Source total | 1,041 |
| Test total | 1,402 |

### To `@svta/cml-msf`

| File | Lines |
|---|---:|
| `packages/msf/src/catalog-builder.ts` | 133 |
| `packages/msf/src/catalog-delta-msf01.ts` | 245 |
| `packages/msf/src/catalog-msf00.ts` | 566 |
| `packages/msf/src/catalog-validate.ts` | 68 |
| `packages/msf/src/delta.ts` | 399 |
| `packages/msf/src/index.ts` | 78 |
| `packages/msf/src/selection.ts` | 241 |
| `packages/msf/src/timeline.ts` | 291 |
| `packages/msf/src/types.ts` | 423 |
| `packages/msf/src/catalog-builder.test.ts` | 211 |
| `packages/msf/src/catalog-delta-msf01.test.ts` | 325 |
| `packages/msf/src/catalog-finite-numbers.test.ts` | 147 |
| `packages/msf/src/catalog-msf00.test.ts` | 1,029 |
| `packages/msf/src/catalog-msf01.test.ts` | 279 |
| `packages/msf/src/catalog.test.ts` | 917 |
| `packages/msf/src/delta.test.ts` | 612 |
| `packages/msf/src/selection.test.ts` | 438 |
| `packages/msf/src/timeline.test.ts` | 334 |
| `packages/msf/src/video-alt-group.test.ts` | 34 |
| `conformance/media/vectors/catalog/` (38 spec-derived non-cf01 vectors; 14 LibMoQ vectors pending license) | |
| `conformance/media/schema/corpus-manifest.schema.json` (copied into each package) | |
| Source total | 2,444 |
| Test total | 4,326 |

### Stays in Playa

| File | Lines | Reason |
|---|---:|---|
| `packages/msf/src/catalog-cf01.ts` | 619 | catalogformat-01, fast-json-patch; moves to `packages/player` |
| `packages/msf/src/catalog-detect.ts` | 50 | cf01 dispatcher |
| `packages/msf/src/catalog.ts` | 8 | `parseCatalog` alias |
| `packages/msf/src/catalog-cf01.test.ts` | 830 | |
| `packages/msf/src/catalog-detect.test.ts` | 83 | |
| `conformance/media/vectors/catalog/` cf-01 vectors (3) | | |
| `conformance/media/vectors/locmaf/` | | locmaf is out of scope |
| `conformance/media/runner/` | | Playa-specific differential and probe plumbing |
