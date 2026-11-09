# Store receipt test fixtures: TEST ONLY

Everything in this folder is a throwaway certificate chain made for
`store-billing.test.js`. None of it is, or chains to, a real Apple or Google
key. The private keys here sign fake App Store JWS payloads inside the tests and
must never be used for anything else.

- `root.pem` stands in for Apple Root CA G3. `intermediate.pem` carries the
  Apple intermediate marker OID 1.2.840.113635.100.6.2.1, and `leaf.pem` with its key
  `leaf-private-key.pem` carries the leaf marker OID 1.2.840.113635.100.6.11.1.
- `other-*.pem` is the same shape under a different root, which must be refused.
- `leaf-nomarker.pem` has no leaf marker. `intermediate-nomarker.pem` and
  `leaf-under-nomarker.pem` form a chain whose intermediate has no marker.
  Both must be refused.
- `ext.cnf` holds the extension sections used to make them.

All are EC P-256 and valid for 20 years from 2026-11-09. Recipe (OpenSSL 3+),
per chain: `genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`, a
self-signed root with `-extensions ca`, then `req` + `x509 -req -extfile ext.cnf`
with `-extensions int` for the intermediate and `-extensions leaf` for the leaf.
The root and intermediate keys were deleted after signing.

Google keys (service account, Pub/Sub OIDC signer) are generated in the test at
run time with `crypto.generateKeyPairSync`, so none are stored here.
