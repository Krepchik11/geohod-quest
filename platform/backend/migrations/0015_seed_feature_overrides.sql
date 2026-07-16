-- Feature flags now default OFF in code (features.rs::default_enabled): an
-- absent row means disabled, and enabling a feature is always an explicit
-- admin decision. The flags that were live before this policy keep working
-- via the ON overrides seeded here (code twin: Feature::SEEDED_ON, kept in
-- sync by features.rs::tests::seed_migration_matches_seeded_on).
-- ON CONFLICT DO NOTHING: an admin-set override (either value) is never
-- clobbered by re-running deployments.
INSERT INTO feature_overrides (key, enabled, updated_at)
VALUES
    ('auth_google',       TRUE, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('auth_telegram',     TRUE, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('payments_mock',     TRUE, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('payments_yookassa', TRUE, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;
