# Recorded legacy purge oracle

The adjacent `.js.legacy` generator is archived unchanged at frontend cutover. It generated `../purge-everywhere-cases.json` from the actual JavaScript workflow; provenance lives in the fixture source object. Do not run it against the native facade or regenerate answers from Rust.

For reproduction, use accepted E3 `e331d7d0086145f838ec35564d02d586e1f7c8c8` (or the fixture source snapshot) in an authorized disposable remote job and run the generator there. That Git revision retains the exact legacy workflow, harness and decision tests. The 42-case fixture SHA256 remains `0860bd8796743b6bd200fe2d44aa5a6911546f4b3bba1b437944cf5ec79d60e2`.

Active native decision coverage is core bulk_worker/purge_oracle and daemon bulk_purge, with the fixture safety exceptions. Frontend coverage now exercises transport, original scope and presentation reconciliation.
