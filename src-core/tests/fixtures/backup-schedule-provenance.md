# Backup schedule actual-source corpus

The first `backup-schedule-{UTC,Europe-Vilnius,America-New_York}.json` captures are **invalid/superseded historical evidence**. They are retained unchanged so their bytes and provenance remain inspectable. The original capture reset could run before a prior coordinator loop's final microtask; its manual-join/paused trace demonstrates contamination. Do not use these coordinator traces as parity or behavioral RED authority. The schedule math runs before coordinator scenarios and is unaffected, but final parity uses the separately captured isolated corpus.

The corrected generator awaits real coordinator loop cleanup and explicitly asserts that its queue loop, terminal waiters and running flags have drained before resetting scenarios. Capture is explicit remote write mode only. Ordinary tests must never regenerate fixtures. The production JS scheduler/hook/settings files stay at their recorded dispatch source hashes for corrected capture.
