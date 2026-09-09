import { expect, it } from 'vitest'
import { redactSessionSearchText } from './session-search-redaction'

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

it('keeps the provider fingerprints and labels what it removed', () => {
  expect(redactSessionSearchText(`key ${AWS_KEY} here`)).toBe(
    'key [redacted:aws-access-key-id] here'
  )
  expect(redactSessionSearchText(`Authorization: Bearer ${JWT}`)).toBe(
    'Authorization: Bearer [redacted:jwt]'
  )
  // Opaque (non-JWT) bearer values are covered too; the label survives.
  expect(redactSessionSearchText('Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(
    'Bearer [redacted:bearer-token]'
  )
})

it('leaves ordinary transcript shapes searchable', () => {
  // Why these and not `redactString`: env-shaped code lines and `token:` prose
  // are ordinary transcript content.
  for (const benign of ['MAX_RETRIES = 3', 'the auth token: refreshed on 401', 'API_KEY_HEADER']) {
    expect(redactSessionSearchText(benign)).toBe(benign)
  }
})
