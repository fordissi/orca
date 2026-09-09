import { expect, it } from 'vitest'
import { PROVIDER_PATTERNS } from '../observability/redactor'
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

// Census: SECRET_ANCHOR gates all eight fingerprint passes, so a pattern whose
// shape has no anchor is silently never applied. One fixture per tag, and the
// list must stay exhaustive.
const ANCHORED_FIXTURES: Record<string, string> = {
  'anthropic-key': `sk-ant-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0'}`,
  'openai-key': `sk-proj-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`,
  'github-token': `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`,
  'aws-access-key-id': AWS_KEY,
  'aws-secret-access-key': `aws_secret_access_key = ${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'}`,
  jwt: JWT,
  'slack-token': `xoxb-${'1234567890-abcdefghij'}`,
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
}

it('has an anchored fixture for every provider pattern', () => {
  expect(Object.keys(ANCHORED_FIXTURES).sort()).toEqual(
    PROVIDER_PATTERNS.map((pattern) => pattern.tag).sort()
  )
})

it.each(PROVIDER_PATTERNS.map((pattern) => pattern.tag))(
  'reaches the %s pattern past the anchor gate',
  (tag) => {
    const fixture = ANCHORED_FIXTURES[tag]
    const pattern = PROVIDER_PATTERNS.find((entry) => entry.tag === tag)!
    pattern.re.lastIndex = 0
    // The fixture is a real match for its own pattern...
    expect(pattern.re.test(fixture)).toBe(true)
    pattern.re.lastIndex = 0
    // ...and the anchor lets that pattern run at all.
    expect(redactSessionSearchText(fixture)).toContain(`[redacted:${tag}]`)
  }
)
