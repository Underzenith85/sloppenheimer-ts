// The media type every document this API publishes is served as.
//
// `@effect/platform` encodes a JSON response as `application/json` unless the schema says
// otherwise, and this API has always sent the charset with it. Stating it once here keeps the
// header the same for every document rather than leaving it to each endpoint to remember.

import * as HttpApiSchema from '@effect/platform/HttpApiSchema'
import type { Schema } from 'effect'

export const jsonContentType = 'application/json; charset=utf-8'

/** A schema published as one of this API's JSON documents. */
export const jsonDocument = <S extends Schema.Schema.Any>(schema: S): S =>
  HttpApiSchema.withEncoding(schema, { kind: 'Json', contentType: jsonContentType })
