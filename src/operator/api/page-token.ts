// The console's page token, as part of the contract rather than as prose beside it.
//
// A mutation is refused without the token, so a reader of the generated description has to be able
// to discover it: the token is declared as an API-key security scheme, which is what puts the
// header on the three protected operations and in `components.securitySchemes`. A generated client
// can then supply it without being told to out of band.
//
// The scheme *decodes* the submitted token; it does not judge it. Judging it here would move the
// refusal ahead of everything else an endpoint checks, and this API answers `404` for an issue
// number it cannot address whether or not a token came with the request — the resource does not
// exist, and the console is a loopback origin rather than an authorization boundary. So the
// middleware hands the handler what arrived, and `requirePageToken` in `src/operator/handlers.ts`
// compares it in the order the route has always answered in. A request that sent no token arrives
// as an empty one, which matches nothing.

import * as HttpApiMiddleware from '@effect/platform/HttpApiMiddleware'
import * as HttpApiSecurity from '@effect/platform/HttpApiSecurity'
import { Context, type Redacted } from 'effect'

/** The header the console submits its page token in. */
export const pageTokenHeader = 'X-Sloppenheimer-CSRF'

/**
 * The token this request carried, redacted from the moment it is read so that no log line or
 * stack trace can echo it. `Redacted.value` at the one comparison that needs the bytes.
 */
export class SubmittedPageToken extends Context.Tag('sloppenheimer/SubmittedPageToken')<
  SubmittedPageToken,
  Redacted.Redacted
>() {}

export class PageToken extends HttpApiMiddleware.Tag<PageToken>()('sloppenheimer/PageToken', {
  provides: SubmittedPageToken,
  security: { pageToken: HttpApiSecurity.apiKey({ key: pageTokenHeader, in: 'header' }) },
}) {}
