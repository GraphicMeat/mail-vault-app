# Shared test fixtures

- `sender-check-cases.json` and `verification-code-cases.json` hold the answers of the deleted `src/utils/senderCheck.js` and `src/utils/verificationCode.js` at origin/main `f66b58621`, which `src-core/src/sender_check.rs` and `src-core/src/verification_code.rs` must match. Regenerate with `node src-core/tests/fixtures/gen/parity-fixtures.mjs` (reads that JS out of git); `git diff` must stay empty.
