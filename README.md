# @mgcrea/mcp-cloudkit

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **CloudKit
management API** — the schema surface behind the CloudKit Console and `xcrun cktool`. Read a
container's schema, diff Development against Production, and deploy the way the Console's
**Deploy Schema Changes** button does, from an MCP client.

This is a **separate service from App Store Connect**, with its own host and its own
credential — an App Store Connect API key gives no access to CloudKit, and this token gives
no access to App Store Connect. See [@mgcrea/mcp-appstore-connect](https://github.com/mgcrea/mcp-appstore-connect)
for versions, builds, TestFlight, and the rest of a release.

The server is **read-only by default**. Mutating tools are not merely refused when writes are
off — they are never registered, so an agent cannot call them at all.

## Why this exists

`NSPersistentCloudKitContainer` (Core Data or SwiftData) creates new record types and fields in
the **Development** environment only. It cannot alter Production, and it does not report that it
did nothing — so a build that ships a new attribute before the schema is deployed saves it
locally, syncs everything else, and drops that one field on the floor. Nothing surfaces to the
user; the record just arrives on the other device with the field absent.

The fix is one Console click, but it is a click nobody can script safely without seeing the diff
first: **the schema becomes additive-only the moment it is first pushed to Production, and stays
that way forever** — a field can be added, never removed, renamed or retyped. This server exists
to make that click scriptable without losing the safety property that matters: `cloudkit_deploy_schema`
always fetches and returns the diff before promoting anything, exactly what the Console shows
you before you press the button.

## The API is undocumented

Apple ships no public docs or OpenAPI spec for the CloudKit management API. The routes here were
read out of the `cktool` binary Xcode installs (`strings $(xcrun -f cktool)`), and the way it calls
them — headers, methods, bodies — out of a live `cktool` session under a debugger, because
`strings` alone gets that wrong:

- A management token goes in **`X-ACP-API-TOKEN`**. `X-Apple-CloudKit-User-Token`, the only
  header name `strings` finds, is for _user_ tokens; a management token sent there gets
  `401 Failed to validate user token`.
- Containers are listed at **`/teams/{teamId}/containers`**, the one route outside `/v1/database`.
- A `.ckdb` goes up as a **multipart** body with one part named `file`, never `text/plain` (415).
  Validate is a `POST`; import is a `PUT`.
- The binary also names `…/recordTypes`, `…/containers/{id}` and `…/schema/diff`. They exist, but
  refuse a management token (`401 authentication-failed`): they belong to the Console's signed-in
  session. So record types are read from `GET …/environments/{env}/schema`, and the diff is
  computed here from the two environments' schemas — the same data, reachable with the token.

`cktool`'s own CLI exposes `export-schema`, `import-schema` and `validate-schema` — but **not** a
diff or a deploy, which is why this server exists rather than just wrapping cktool.

Three consequences follow from that:

- Every response shaper falls back to the **raw payload** when it does not recognise the
  envelope, rather than reporting an empty result. A wrong guess here must never read as "the
  field is not deployed yet" when the truth is "the shaper does not understand this response".
- `cloudkit_request` is a GET-by-default escape hatch, so one endpoint answering differently than
  expected cannot make the rest of the server useless.
- **`cloudkit_deploy_schema` has not yet been seen to work with a management token.** Its
  `…/schema/{uuid}/promote` route comes from the binary like the rest, but `cktool` never calls
  it, and its Console-only neighbours refuse the token. If it is refused, the tool says so and
  returns the diff; deploy from the Console instead.

## Features

- **`cloudkit_diff_schema`** shows what a deploy would change, one row per record type or field:
  `ADD`, `CHANGE_INDEXES`, `RETYPE`, `MISSING_IN_DEVELOPMENT` (Production keeps it; a deploy
  cannot remove it), or `OTHER` when the schemas differ outside any field, such as permissions.
  **`cloudkit_deploy_schema`** always computes that diff first; it refuses when there is nothing
  to deploy, when a field is retyped, or when either schema cannot be read, and takes `dryRun` to
  stop before committing.
- **`cloudkit_list_record_types`** answers "did my new field actually reach CloudKit" in one
  call — Core Data and SwiftData prefix every record type and field with `CD_`, so a Swift
  `isHidden` on `Track` shows up as `CD_isHidden` on `CD_Track`.
- The container `reset` route (wipes all Development data) is **not exposed as a tool**, and
  `cloudkit_request` refuses to reach it by path, in any case and percent-encoded or not —
  omitting it as a tool would mean little if the escape hatch could still call it.

## Security

- **Read-only by default.** `CLOUDKIT_ALLOW_WRITES=1` adds `cloudkit_deploy_schema` and
  `cloudkit_import_schema`; both then additionally require an explicit `confirm: true` on every
  call, and `cloudkit_request` requires it for any method other than GET.
- **A management token can rewrite a container's schema**, which is broader than reading one.
  Scope it to the team that needs it, keep it out of tracked files, and revoke it in
  [the Console](https://icloud.developer.apple.com/dashboard/account/tokens) when you are done —
  there is no expiry on it otherwise.
- **No runtime dependencies** beyond the MCP SDK and Zod — native `fetch` throughout.
- **Your credentials** stay in your environment or config file; nothing is sent anywhere but
  `api.icloud.apple.com`.

## Configure

Create a token at [icloud.developer.apple.com/dashboard/account/tokens](https://icloud.developer.apple.com/dashboard/account/tokens)
under **CloudKit Management Tokens**.

| Variable                    | Required | Notes                                                                                                                                                |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDKIT_MANAGEMENT_TOKEN` | yes      | Apple's own variable name — `xcrun cktool` reads it too.                                                                                             |
| `CLOUDKIT_TEAM_ID`          | yes      | Your 10-character Apple Developer team id.                                                                                                           |
| `CLOUDKIT_CONTAINER_ID`     | no       | Default container, e.g. `iCloud.com.acme.App`, so it need not be passed on every call. `cloudkit_list_containers` finds it if you don't have it yet. |
| `CLOUDKIT_ALLOW_WRITES`     | no       | `1` to register `cloudkit_deploy_schema` and `cloudkit_import_schema`. Off by default.                                                               |
| `CLOUDKIT_MAX_RETRIES`      | no       | Retry budget for 429/5xx. Defaults to 3.                                                                                                             |
| `CLOUDKIT_DEBUG`            | no       | `1` to log to stderr.                                                                                                                                |

```bash
cp .env.example .env
```

### Config file

If you'd rather not put the token in your shell profile or every MCP client config:

```jsonc
// ~/.config/cloudkit/config.json   (chmod 600)
{
  "managementToken": "...",
  "teamId": "75QE9PRT3V",
  "containerId": "iCloud.io.mgcrea.Balise",
  "allowWrites": false,
}
```

The environment wins over the file, field by field — a one-off `CLOUDKIT_ALLOW_WRITES=0` still
overrides a file that says `true`. Unknown keys are an error, not silently ignored. Location:
`$CLOUDKIT_CONFIG`, else `$XDG_CONFIG_HOME/cloudkit/config.json`, else `~/.config/cloudkit/config.json`.

## Quick start

```bash
pnpm install
pnpm build
```

Then copy `.mcp.json.example` to `.mcp.json` and fill it in.

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Tools

| Tool                         | What it does                                  | Writes        |
| ---------------------------- | --------------------------------------------- | ------------- |
| `cloudkit_auth_status`       | Credential state and what to configure        | no            |
| `cloudkit_list_containers`   | Containers this team can manage               | no            |
| `cloudkit_list_record_types` | Record types and fields for an environment    | no            |
| `cloudkit_export_schema`     | An environment's full schema as `.ckdb` text  | no            |
| `cloudkit_diff_schema`       | Pending Development → Production changes      | no            |
| `cloudkit_validate_schema`   | Validate a local `.ckdb` without importing it | no            |
| `cloudkit_request`           | Escape hatch for any other route              | no (GET only) |
| _`cloudkit_deploy_schema`_   | Promote Development to Production             | yes†          |
| _`cloudkit_import_schema`_   | Upload a `.ckdb` wholesale                    | yes†          |

_Italic_ tools need `CLOUDKIT_ALLOW_WRITES=1`. † additionally requires `confirm: true`.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm format
```

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
