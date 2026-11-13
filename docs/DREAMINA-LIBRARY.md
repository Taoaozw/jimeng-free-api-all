# Dreamina library adapter

The Flowxy library routes require private-account mode (`JIMENG_API_KEY` and `JIMENG_ACCOUNT_TOKEN`), a persistent `JIMENG_LIBRARY_DIR`, and a stable, non-secret `JIMENG_LIBRARY_ACCOUNT` namespace. Keep that namespace unchanged when refreshing a session; use a new namespace when replacing the upstream account. Mount the directory outside the container. One process owns each directory; shared multi-process writers are not supported.

The private proxy accepts a trusted `X-Flowxy-Library-Owner` organization ID. Only the gateway/private proxy administrator may call these routes. Do not expose the private proxy key to end users. Flowxy authenticates end users, signs encrypted account-bound library handles, and replaces the organization header.

Routes under `/v1/videos/library`:

- `GET /metadata`: categories and limits.
- `GET /assets`, `POST /assets` (name, base64 data URL, width/height for images).
- `GET /assets/:id/content`: authenticated original file stream.
- `PATCH /assets/:id` (name), `DELETE /assets/:id` (409 while used by an element).
- `GET /elements`, `POST /elements`, `PATCH /elements/:id`, `DELETE /elements/:id`.
- Element fields: name (20 characters), category, description, assetIds. Up to nine images plus one optional audio voice, or one standalone video. Categories are returned by metadata.

Uploads support PNG/JPEG/WebP, MP4/MOV and MP3/WAV, up to 50 MiB. Each organization can store up to 500 assets and 500 elements per account namespace. Lists expose only registered organization-owned objects, never the entire shared Dreamina account. Original media and registry JSON are private files; include both in backups. Registry updates use serialized atomic replacement. Upstream mutations and local persistence are not a distributed transaction: a disk failure after an upstream mutation requires reconciliation before retrying.

`POST /v1/videos/generations` accepts `library_id` and `references` (1–50 distinct local asset/element IDs) for `jimeng-video-seedance-2.5`. Prompt placeholders `@1`, `@2` refer to selection order; unknown indices fail. Cannot mix library references with frame files. Assets become native image/video/audio draft materials, elements become native subject data including selected voice. Generation uses the existing polling, errors, and output resolution behavior.

Duration in the registry/Subject API is seconds. VOD upload metadata and draft video/audio resources use milliseconds. International non-US VOD uses the observed official `vod-normal-sg.capcutapi.com` endpoint. Reference videos can incur additional upstream input-video credits. Material management does not generate videos or charge generation credits.

Validation: `node --test tests/*.test.cjs` and `npm run build`. Use synthetic fixtures for live verification and remove test elements before deleting their referenced assets.

Errors: missing/foreign materials return 404, invalid selections 400, referenced-asset deletion 409. Nonzero Dreamina `ret` is HTTP 502 even if the provider returned HTTP 200. Terminal generation rejection retains the provider failure code; generic uncategorized exceptions return HTTP 500. Never treat an error body as a successful generation.
