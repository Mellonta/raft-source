-- Retire automated Wiki maintenance without deleting documents, agents,
-- channels or their retained bindings. Version fencing rejects stale Computer
-- fire receipts; the next reminder snapshot reconciles cached schedules.
WITH canceled AS (
  UPDATE reminders
  SET status = 'canceled', canceled_at = now(), updated_at = now(),
      version = version + 1, arm_state = 'not_armed', arm_updated_at = now()
  WHERE status IN ('scheduled', 'fired')
    AND payload->>'kind' IN ('wiki.incremental_discovery', 'wiki.lint')
    AND payload->>'version' = '1'
  RETURNING id, server_id, owner_agent_id, version
)
INSERT INTO reminder_events
  (id, reminder_id, server_id, owner_agent_id, actor_type, event_type, metadata)
SELECT gen_random_uuid(), id, server_id, owner_agent_id, 'system', 'canceled',
       jsonb_build_object('reason', 'wiki_retired', 'version', version)
FROM canceled;
--> statement-breakpoint
-- Also hide the feature from older web/server replicas during rollout.
UPDATE feature_flags
SET enabled = false, kill_switch = true, default_enabled = false
WHERE key = 'wiki_v0';
