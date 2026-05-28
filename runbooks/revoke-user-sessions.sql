-- runbooks/revoke-user-sessions.sql
-- Use when: account takeover suspected.
-- Per docs/implementation.html §18 incident-response.
--
-- Usage (psql):
--   psql "$DATABASE_URL" -v user_id="'uuid-here'" -f runbooks/revoke-user-sessions.sql
--
-- Rehearse quarterly on staging.

-- Drop all auth sessions for the user.
-- (Adjust to your auth table once better-auth migrations land.)
DELETE FROM auth_sessions WHERE user_id = :user_id;

-- Force re-auth on next request.
UPDATE users SET require_reauth = true WHERE id = :user_id;

-- Audit log entry.
INSERT INTO audit_log (action, target_user_id, performed_at, note)
VALUES ('revoke_user_sessions', :user_id, now(), 'incident response');
