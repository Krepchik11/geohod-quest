# parity-goldens (new)

## ADDED Requirements

### Requirement: Shared fixture set is the single source for projection goldens
The system SHALL maintain one fixture directory at the monorepo root (platform/goldens/) containing JSON files, each pairing a fact log with its expected projections (balance, completed_steps, revealed_hints) and a human-readable scenario name. Both the Rust test suite and the TypeScript test suite SHALL load these files from that single location at test time; neither side may embed its own copy of expected values for these scenarios.

#### Scenario: Both suites consume the identical file
- **WHEN** a fixture's expected_balance is edited from 5 to 6
- **THEN** the next `cargo test` run and the next frontend test run both fail (or both pass) against the same byte-identical fixture, with no second copy to drift.

### Requirement: Fixture coverage includes the adversarial invariants
The fixture set SHALL cover at minimum: the happy playthrough with a gift and a completion bonus; a negative-balance scenario (spends exceed earnings, expected balance below zero); multi-device union (facts for the same step from two device_ids both project, completed steps deduplicate by position); and an empty log (all projections zero/empty). Projectors are plain folds over an already-deduplicated log; append-time idempotency (including completion-bonus per player+quest) is asserted by facts-sync tests, not by fixtures.

#### Scenario: Negative balance fixture asserts below-zero result on both sides
- **WHEN** the negative-balance fixture (gifts +3, hint spends -10) is folded by Rust project_balance and TypeScript projectBalance
- **THEN** both return exactly -7 and both test suites assert this value from the fixture file, proving no side clamps at zero.

#### Scenario: Bonus fixture folds the single award into balance
- **WHEN** the happy fixture log contains one completion_bonus fact of +5 alongside a gift of +5
- **THEN** both projectors return balance 10 and identical completed_steps, byte-equal expectations from the same file.

### Requirement: Parity failures are build failures
A mismatch between a projector's output and a fixture's expected values SHALL fail the owning test suite, and the root test orchestration (npm test at the monorepo root) SHALL run both suites so any one-sided drift breaks the build.

#### Scenario: Drift introduced in one implementation breaks root test run
- **WHEN** a developer changes the TypeScript fold to clamp balance at zero while Rust still sums freely
- **THEN** the TypeScript suite fails the negative-balance fixture, and `npm test` at the root exits non-zero.
