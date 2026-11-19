-- Which key-stretching parameter set (web/src/lib/opaque-auth.js KSF_VERSIONS) produced the OPAQUE record, and so the
-- export key that wraps the key vault. The client needs it before it has a session (login, password reset), so it sits
-- beside `opaque_record` and is only ever written in the same statement as the record. Version 1 is the parameter set
-- every existing account was registered with.
ALTER TABLE accounts ADD COLUMN opaque_ksf_version INTEGER NOT NULL DEFAULT 1;
