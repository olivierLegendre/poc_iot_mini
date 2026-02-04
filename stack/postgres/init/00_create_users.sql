-- ============================================================================
-- Create PostgreSQL Users and Databases for PoC
-- ============================================================================
-- This file runs automatically on first postgres container startup.
-- (files in /docker-entrypoint-initdb.d/ are executed in alphabetical order)
--
-- IMPORTANT: This file creates ROLES ONLY. Databases must be created separately
-- because CREATE DATABASE cannot run inside a transaction or interactive session.
-- See the init_postgres_users.sh script for full database setup.
--
-- Sets up two roles:
-- 1. chirpstack - with access to 'chirpstack' database
-- 2. nodered - with access to 'poc_nodered' database
--
-- All passwords are hardcoded here (must match .env values)
-- ============================================================================

-- Create chirpstack role (ignore error if already exists)
DO $$
BEGIN
  CREATE ROLE chirpstack WITH LOGIN PASSWORD 'pg_chirpstack_password';
EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL;
END
$$;

-- Create nodered role (ignore error if already exists)
DO $$
BEGIN
  CREATE ROLE nodered WITH LOGIN PASSWORD 'pg_nr_password';
EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL;
END
$$;
