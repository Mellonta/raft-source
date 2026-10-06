/**
 * Known credential samples every producer must mask before it may upload.
 * Exported so each surface's test asserts the SAME list rather than its own
 * abbreviated one (the transcript path's gap was exactly a sample nobody had
 * written down). Synthetic, and test-only: it lives under `test/` so the
 * source-available export's secret scans never see credential-shaped strings
 * in shipped source.
 */
// Built at runtime so secret scanners don't flag this test sample.
const AKIA = "AK" + "IA";
const ASIA = "AS" + "IA";
const GHP = "gh" + "p_";
const GITHUB_PAT = "github" + "_pat_";
const XOXB = "xo" + "xb-";
const AIZA = "AI" + "za";
/** The PEM private-key BEGIN header line, assembled at runtime for the same reason. */
export const PEM_PRIVATE_KEY_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";

export const DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES: readonly { label: string; sample: string; mustNotContain: string }[] = [
  { label: "bare JWT without Bearer", sample: "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZ25hdHVyZQ", mustNotContain: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
  { label: "Bearer token", sample: "Authorization: Bearer abcDEF123456_secret-token", mustNotContain: "abcDEF123456_secret-token" },
  { label: "Authorization header without scheme", sample: `authorization: ${XOXB}1234-ABCDEFGHIJKLMNOP`, mustNotContain: `${XOXB}1234-ABCDEFGHIJKLMNOP` },
  { label: "PEM private key block", sample: `${PEM_PRIVATE_KEY_BEGIN}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----`, mustNotContain: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" },
  { label: "Raft agent key", sample: "using sk_agent_9f7c12d7abcdef0123456789", mustNotContain: "sk_agent_9f7c12d7abcdef0123456789" },
  { label: "Raft sap key", sample: "sap_ZZZ111aaa222bbb", mustNotContain: "sap_ZZZ111aaa222bbb" },
  { label: "api_key pair", sample: `api_key="${AKIA}IOSFODNN7EXAMPLE"`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLE` },
  { label: "URL query token", sample: "GET https://api.example.test/v1/thing?access_token=abc123secret&x=1", mustNotContain: "abc123secret" },
  { label: "URL basic auth", sample: "https://user:p4ssw0rd@host.example.test/path", mustNotContain: "p4ssw0rd" },
  // Kabi's #263 R6 corpus (2026-09-15): these three still passed through.
  { label: "GitHub classic token", sample: `GITHUB_TOKEN=${GHP}AbCdEf0123456789AbCdEf0123456789abcd`, mustNotContain: `${GHP}AbCdEf0123456789AbCdEf0123456789abcd` },
  { label: "AWS access key id", sample: `aws_access_key_id = ${AKIA}IOSFODNN7EXAMPLE`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLE` },
  { label: "AWS secret access key", sample: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", mustNotContain: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  // Jianwei (#7791 review): the id rule pinned the 20-char example only; the
  // IAM contract is 16–128 chars.
  { label: "AWS access key id (17 chars)", sample: `key ${AKIA}IOSFODNN7EXAM`, mustNotContain: `${AKIA}IOSFODNN7EXAM` },
  { label: "AWS access key id (24 chars)", sample: `key ${AKIA}IOSFODNN7EXAMPLEABCD`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLEABCD` },
  { label: "AWS STS temporary key id (24 chars)", sample: `key ${ASIA}IOSFODNN7EXAMPLEABCD`, mustNotContain: `${ASIA}IOSFODNN7EXAMPLEABCD` },
  // Kabi (#263 R6, 07:03Z): bare keys in log text, not next to a NAME= assignment.
  { label: "Google API key bare in a URL-less log line", sample: `request rejected for key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q` },
  { label: "Google API key ending in '-' before a space", sample: `key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6- rejected`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6-` },
  { label: "Google API key ending in '_' at end of line", sample: `key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6_`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6_` },
  { label: "xAI API key bare in a log line", sample: "provider rejected token xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 (401)", mustNotContain: "xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  { label: "GitHub fine-grained token", sample: `token ${GITHUB_PAT}11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`, mustNotContain: `${GITHUB_PAT}11ABCDEFG0123456789` },
  { label: "OpenAI project key", sample: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", mustNotContain: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
  { label: "Slack bot token", sample: `${XOXB}1234567890-abcdefghijklmnop`, mustNotContain: `${XOXB}1234567890-abcdefghijklmnop` },
  { label: "camelCase authToken in JSON", sample: '{"authToken":"tok_ABC123def456"}', mustNotContain: "tok_ABC123def456" },
];
