# Native fifth-action wire fixture

`native-purge-wire.json` is the exact JSON stdout artifact of the real accepted native `bulk_purge_no_message_id_uses_native_generation_and_exact_bytes` test, captured with `MAILVAULT_BULK_WIRE_FIXTURE=1`. It includes its request Scope, native accepted summary, actual checkpoint/drain progress and durable full pending row. Synthetic mock identities and hashes only; no body, credential or mirror path is exported.

Remote mini input snapshot `353c0131ba774c39a6bd90209a7a043032f4ae02`, tree `b7f21fba8076eac4525cc8e110f5cb771e99ada1`, based on accepted E3 `e331d7d0086145f838ec35564d02d586e1f7c8c8`. Capture test passed1/1, native worker source unchanged except the test-only export. See `/tmp/blitz-F-native.log` in the implementation handoff for the exact command and full gate evidence.

This fixture checks frontend native-serialization compatibility, including null/default TargetHint fields absent from the original request. It is separate from the immutable42-case legacy JS decision oracle; neither artifact is generated from the other.
