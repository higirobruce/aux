-- runbooks/revoke-share-links.sql
-- Use when: share link leaked or compromised.
-- Per docs/implementation.html §18 incident-response.
--
-- Usage (psql):
--   psql "$DATABASE_URL" -v session_id="'uuid-here'" -f runbooks/revoke-share-links.sql

-- Soft-revoke every share link for the session.
UPDATE share_links
SET revoked_at = now()
WHERE session_id = :session_id
  AND revoked_at IS NULL;

INSERT INTO audit_log (action, target_session_id, performed_at, note)
VALUES ('revoke_share_links', :session_id, now(), 'incident response');
