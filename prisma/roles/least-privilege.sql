-- NFR-153: two database roles. Run this once as the database administrator, after the first migration has created the tables.
--   aimltriage_migration  owns the schema and runs `prisma migrate deploy` (MIGRATION_DATABASE_URL)
--   aimltriage_runtime    reads and writes rows only (DATABASE_URL); it cannot alter, drop or create anything
-- Replace the passwords with generated values held in the secret store; never commit them.

-- Roles (skip if Terraform created them: terraform/tenant-qatar-airways/sql.tf).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimltriage_migration') THEN CREATE ROLE aimltriage_migration LOGIN PASSWORD 'REPLACE_ME'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aimltriage_runtime') THEN CREATE ROLE aimltriage_runtime LOGIN PASSWORD 'REPLACE_ME'; END IF;
END $$;

-- The migration role owns the objects.
ALTER SCHEMA public OWNER TO aimltriage_migration;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO aimltriage_migration', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO aimltriage_migration', r.sequencename);
  END LOOP;
END $$;

-- The runtime role gets row access only.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aimltriage_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aimltriage_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aimltriage_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aimltriage_migration IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aimltriage_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aimltriage_migration IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aimltriage_runtime;

-- The audit ledger is append-only: the runtime role may add to it and read it, never change or remove an entry.
-- (The ledger's own triggers also refuse updates and deletes; this removes the privilege as well.)
REVOKE UPDATE, DELETE ON audit_events FROM aimltriage_runtime;
