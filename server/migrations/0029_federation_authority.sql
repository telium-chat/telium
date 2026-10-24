-- Federation-side memory of warm-standby discovery.
--
-- A fallback has to be learned while the primary is healthy: after a process or
-- whole machine disappears there is nobody at that origin left to tell a peer
-- where its copy lives. Peers keep the published standby and mount path beside
-- ordinary discovery so a later request can retry through a promoted standby.
-- The origin's signed key history is carried in .well-known itself; these columns
-- remember only where the already-verified fallback route lives.
ALTER TABLE remote_servers ADD COLUMN fallback_standby TEXT;
ALTER TABLE remote_servers ADD COLUMN fallback_path TEXT;
