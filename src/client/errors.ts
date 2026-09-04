/**
 * A CloudKit management API failure.
 *
 * CloudKit replies with a flat `{reason, serverErrorCode}`, not a JSON:API
 * `errors` array, so this carries its own shape rather than reusing one built
 * for a different service. `detail` carries whatever came back, parsed if it
 * was JSON and left as text if it was not.
 */
export class CloudKitApiError extends Error {
  override readonly name = "CloudKitApiError";
  readonly status: number;
  readonly serverErrorCode: string | undefined;
  readonly detail: unknown;

  constructor(
    message: string,
    opts: { status: number; serverErrorCode?: string | undefined; detail?: unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.serverErrorCode = opts.serverErrorCode;
    this.detail = opts.detail;
  }
}
