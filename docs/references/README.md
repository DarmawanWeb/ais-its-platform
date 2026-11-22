# Methodology catalog (`docs/references`)

This folder holds the machine-readable methodology catalog of AIS Maritime Intelligence v2
(spec `docs/PLATFORM_SPEC.md` §17):

| File | Content |
|---|---|
| `references.json` | Every source cited by a method: regulations, guidelines, standards, papers, books, reports, datasets, software and the legacy MVP code. |
| `methods.json` | Every formula, empirical constant, threshold and rule of the platform (109 methods; 149 references in `references.json`), with its equation, variables, constants, sources, v2 owner and legacy location. |

Together with `docs/METHODOLOGY.md` (the human-readable "Metodologi & Referensi", Bahasa Indonesia
with an English abstract) they are the **single source of truth** for:

- the contracts package `@darmawanweb/ais-its-contracts`, subpath `./references` (`REFERENCES`,
  `METHODS`, `getMethod`, `getReference`, `methodsByDomain`, `referencesOfMethod`). Inside the contracts
  repository (`packages/ais-its-contracts/packages/contracts`) `pnpm run references:sync` validates both
  files with `validateCatalog` (zod schemas, unique ids, no dangling `referenceIds`, every method cites a
  reference or is marked `needsCitation`) and regenerates `src/references/data/*.ts`;
  `pnpm run references:check` fails CI when the generated modules are outdated, and `pnpm run schemas`
  emits the JSON Schemas `schemas/methodology.{references,methods}.json`;
- the "Methodology & references" section of every service README (method ids + links
  `docs/METHODOLOGY.md#<method-id>`), the `@method <id>` TSDoc tags in `src/domain/**` and
  `src/detectors/**`, `GET /api/v2/emission/methodology`, `GET /api/v2/{safety,surveillance}/detectors`,
  the `methodIds` of CII/SEEMP responses and the `methodId` of detector events and alerts;
- the web page **Metodologi & Referensi** (KaTeX formulas, variables, units, external links, filter by
  domain, id/en) and the "ⓘ Sumber" popovers next to computed figures.

Never copy values from these files into code or documents by hand: import them from the contracts
package or link to the method anchor.

## Relationship with `METHODOLOGY.md`

The method sections, the method index, the list of methods that still need a citation and the
bibliography of `METHODOLOGY.md` were rendered from these two files (the prose of §1-2 and §15-19 and the
section introductions are hand-written). The citation numbers `[n]` in the document are the 1-based
positions in `references.json` (references are ordered by first citation in the document; references
cited nowhere follow at the end). Method anchors are the method ids (`METHODOLOGY.md#cii.required`).
The renderer used for version 1.0 is a one-off script that is not part of this repository yet (suggested
home: `tools/methodology/`); until it is added, change the JSON first and then apply the same change to
the document by hand, keeping the citation numbers in step with the array order. §20 of the document
(the 18 methods and 9 references added with contracts 0.4.0) was rendered from the JSON with the same
block layout.

`pnpm --filter @darmawanweb/ais-its-contracts run references:verify` (in `packages/ais-its-contracts`)
checks the catalog against the code: every `implemented` method's `implementedBy.module` file and symbol
exist under `services/<service>/` (or the contracts package for `contracts`) and carry its
`@method <id>` tag, every tag in the services names a catalogued method, a tagged method is not left
`planned` / `not_implemented`, and every implemented method has an owner.

## `references.json`

An array of objects; keys in this order:

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Stable id, pattern `^[a-z0-9]+(?:[._-][a-z0-9]+)*$` (e.g. `imo-mepc-353-78`). Never reuse or rename an id that has been published. |
| `type` | string | `regulation`, `guideline`, `standard`, `paper`, `book`, `thesis`, `report`, `dataset`, `software`, `website` or `legacy_code` (open vocabulary of the contracts package; lowercase token). Indonesian laws and decrees use `regulation`; API documentation pages use `website`. |
| `title` | string | Full title in the original language. |
| `issuerOrAuthors` | string | Issuing body or authors. |
| `year` | integer \| null | Year of publication or adoption; `null` when undated (details such as "Rev.1: 2026" go to `identifier`/`notes`). |
| `identifier` | string \| null | Resolution, standard, DOI, ISBN, report or version identifier, incl. adoption / entry-into-force dates. |
| `url` | string \| null | Where the source can be consulted (http/https). `null` when no URL was confirmed. |
| `license` | string \| null | Licence or terms of use. |
| `accessed` | date \| null | When the source (or its search-engine record) was consulted: `2026-11-20` for the research pass, `2026-11-21` for the collision-risk sources (COLREG, MSC.192(79), A.823(19), Lenart, Bole et al., Wawruch); `null` when there is no URL. |
| `verification` | string | `verified` — the cited content was seen in the source or an official copy; `corrected` — the entry was corrected during verification (identity, year, URL or content) and the corrections are applied; `unverified` — identity or content could not be confirmed. `verified` and `unverified` are known values of the contracts vocabulary; `corrected` is accepted by the open vocabulary and is shown by its id until a label is added there (suggested label: "Verified with corrections" / "Terverifikasi dengan koreksi"). |
| `notes` | string \| null | English: what the source supports, which section is used, corrections applied, and what is still unconfirmed. |

Notes on the content: IMO PDFs could not be opened directly from the research machine; IMO values come
from search extracts of the IMO texts and secondary copies, so re-verify them verbatim before regulatory
use. Three references are internal: `legacy-mvp-backend` and `legacy-mvp-frontend` (type `legacy_code`,
the MVP whose numerics v2 keeps in parity) and `platform-spec-v1-1` (the v2 design rules). They show
where a value is implemented or decided, not where it comes from: such methods stay `needsCitation`.
There is no entry for the thesis itself because its title, year and bibliography were not available.

## `methods.json`

An array of objects; keys in this order:

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Stable method id (same pattern), identical to the research inventory, e.g. `cii.attained_accumulation`, `collision.cpa_tcpa`. Used by `@method` tags, events, alerts and API responses. (The `cii.attained` in spec §17 is only an example.) |
| `domain` | string | `ais`, `geo`, `safety`, `surveillance`, `emission`, `seemp`, `telemetry`, `notification` or `security` (known values of the contracts vocabulary). The finer topic is the id prefix: `geo.`, `navstatus.`, `data.`, `ews.`, `collision.`, `fuel.`, `telemetry.`, `resistance.`, `weather.`, `emission.`, `cii.`, `seemp.`, `transhipment.`, `anomaly.`, `dark.`, `fishing.`. |
| `name` | `{ id, en }` | Short name in Bahasa Indonesia and English. |
| `summary` | `{ id, en }` | What is computed, as implemented (legacy parity). |
| `formulaLatex` | string \| null | Equation in LaTeX for KaTeX (backslashes are escaped in JSON); `null` for data entries without an equation. |
| `variables` | array | `{ symbol, name: {id,en}, description: {id,en}, unit, source }`: `symbol` in LaTeX, `unit` or `null` when dimensionless, `source` = where the value comes from (AIS field, fleet column, or another method id). `name` is what the contracts schema requires; `description` and `source` are documentation extensions (ignored by the contracts schema, used by `METHODOLOGY.md`). |
| `constants` | array | `{ symbol, name: {id,en}, value, unit, referenceIds, needsCitation }`: `value` is a number or a text (tables, vectors, expressions); `referenceIds` are the sources of the value; `needsCitation: true` when the value has no verified external source. |
| `referenceIds` | string[] | Sources of the method (ids of `references.json`). |
| `implementedBy` | `{ service, module }` \| null | v2 owner: `contracts` (shared function in `@darmawanweb/ais-its-contracts`), `ais-pipeline`, `fleet`, `telemetry`, `emission`, `geo`, `safety`, `surveillance`, `notification` or `auth`; `module` is `<path>[#<symbol>][ (<remark>)]` relative to the owner's root (`src/domain/<file>.ts#<function>` for pure functions, `src/detectors/<detector>/…` for detectors, `src/shared/domain/…` in the two-process ais-pipeline), checked by `references:verify`. `null` when the method is not carried into v2. |
| `legacy` | string[] | `path:function` in the read-only MVP checkout (`be-legacy/…` = backend `ais-its-mvp-api`, `fe-legacy/…` = MVP web app; data files and Postman collections without a function). Empty for v2-only methods. |
| `status` | string | `implemented` (the owner runs it; the module carries the `@method` tag), `not_implemented` (intentionally not in v2, e.g. the hard-coded CII seed or display-only MVP rules; labelled since contracts 0.4.0). `planned` is still accepted but no method uses it since contracts 0.4.0 (all 82 former `planned` methods are implemented). |
| `needsCitation` | boolean | `true` when the method or any of its values comes from the thesis (or is a v2 design default) without a verified external source. Rendered as "⚠️ Perlu sitasi" in the document and the web page. |
| `notes` | `{ id, en }` \| null | Legacy deviations, open parity-vs-fix decisions, questions for the thesis author. |

## Editing rules

1. Add the reference first (with `verification` stated honestly), then cite it. Never cite a source for
   a value that the source was not verified to contain; mark the value `needsCitation: true` instead.
2. Keep ids stable; a renamed method breaks `@method` tags, stored events and alerts.
3. Numbers in JSON and formulas use a decimal point; units follow SI or the maritime convention
   (nm = 1852 m, kn, t, g CO2/(capacity·nm)).
4. After editing: bring `docs/METHODOLOGY.md` in line (see above), run `pnpm run references:sync` (or
   `references:check`) in the contracts package, and update the golden tests of the affected service when
   a formula changes (spec §11 and §15).
