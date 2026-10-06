-- Feature Flag Admin preview evaluates plan and Lab rules directly so it can
-- distinguish an effective decision from configuration shape. Keep that
-- diagnostic path on the narrow operator role by exposing only the columns
-- consumed by its read-only evaluator.
CREATE OR REPLACE FUNCTION public.reconcile_feature_flag_admin_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $feature_flag_admin_privileges$
DECLARE
  projection record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'feature_flag_admin_operator'
  ) THEN
    RAISE EXCEPTION 'feature_flag_admin_operator is required before privilege reconciliation'
      USING ERRCODE = '42704';
  END IF;

  EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA public FROM feature_flag_admin_operator';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.announcement_audit_events, public.feature_flags, public.feature_flag_rules, public.feature_flag_audiences, public.feature_flag_audience_members, public.users, public.servers, public.subscriptions, public.server_lab_enrollments, public.server_lab_access, public.lab_definitions FROM feature_flag_admin_operator';
  FOR projection IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (
      'announcements',
      'announcement_audit_events',
      'feature_flags',
      'feature_flag_rules',
      'feature_flag_audiences',
      'feature_flag_audience_members',
      'users',
      'servers',
      'subscriptions',
      'server_lab_enrollments',
      'server_lab_access',
      'lab_definitions'
    )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM feature_flag_admin_operator',
      projection.column_name,
      projection.table_schema,
      projection.table_name
    );
  END LOOP;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.announcements TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE public.announcement_audit_events TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feature_flags, public.feature_flag_rules TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.feature_flag_audiences TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE public.feature_flag_audience_members TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id) ON TABLE public.users TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id, slug, deleted_at, plan) ON TABLE public.servers TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, plan, status) ON TABLE public.subscriptions TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, lab_key, enabled) ON TABLE public.server_lab_enrollments TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, enabled) ON TABLE public.server_lab_access TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (key, state) ON TABLE public.lab_definitions TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0267_feature_flag_admin_preview_privileges',
    clock_timestamp(),
    current_user
  )
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
END
$feature_flag_admin_privileges$;

REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_feature_flag_admin_privileges() FROM PUBLIC;
