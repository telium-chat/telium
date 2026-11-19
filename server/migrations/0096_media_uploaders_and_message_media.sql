-- Who uploaded each stored object, and which messages carry it.
--
-- `media.refcount` counts uploads of the same bytes, not uploaders, so an
-- account that sent its own file twice was refused its own delete as if
-- someone else shared the bytes. `media_uploaders` records each account that
-- uploaded the bytes once; an owner's delete is refused only while another
-- account is listed. `refcount` is kept as-is for export and history.
CREATE TABLE media_uploaders (
    hash    TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (hash, user_id)
) WITHOUT ROWID;

-- The owner is always an uploader of the row it owns, whichever path inserts it
-- (a fresh upload, a migrated account landing its media, a restore).
CREATE TRIGGER media_uploaders_owner
AFTER INSERT ON media
BEGIN
    INSERT OR IGNORE INTO media_uploaders (hash, user_id) VALUES (NEW.hash, NEW.owner_user_id);
END;

CREATE TRIGGER media_uploaders_gc
AFTER DELETE ON media
BEGIN
    DELETE FROM media_uploaders WHERE hash = OLD.hash;
END;

-- Every live message that carries a stored object, so "where was this sent"
-- is an index lookup instead of a scan over the author's message history.
-- Triggers keep it exact on every path that writes `messages` (sending,
-- deleting or blanking, channel and guild removal, cold archiving, relocation
-- rewrites, replication) without each call site having to remember it.
CREATE TABLE message_media (
    hash       TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (hash, message_id)
) WITHOUT ROWID;
CREATE INDEX message_media_message ON message_media (message_id);

CREATE TRIGGER message_media_insert
AFTER INSERT ON messages
BEGIN
    INSERT OR IGNORE INTO message_media (hash, message_id)
    SELECT json_extract(j.value, '$.hash'), NEW.id
    FROM json_each(CASE WHEN json_valid(NEW.attachments) THEN NEW.attachments ELSE '[]' END) j
    WHERE json_type(j.value) = 'object' AND json_type(j.value, '$.hash') = 'text';
END;

CREATE TRIGGER message_media_update
AFTER UPDATE OF attachments ON messages
BEGIN
    DELETE FROM message_media WHERE message_id = OLD.id;
    INSERT OR IGNORE INTO message_media (hash, message_id)
    SELECT json_extract(j.value, '$.hash'), NEW.id
    FROM json_each(CASE WHEN json_valid(NEW.attachments) THEN NEW.attachments ELSE '[]' END) j
    WHERE json_type(j.value) = 'object' AND json_type(j.value, '$.hash') = 'text';
END;

CREATE TRIGGER message_media_delete
AFTER DELETE ON messages
BEGIN
    DELETE FROM message_media WHERE message_id = OLD.id;
END;

-- Backfill: messages first, since the uploader backfill reads them.
INSERT OR IGNORE INTO message_media (hash, message_id)
SELECT json_extract(j.value, '$.hash'), m.id
FROM messages m,
     json_each(CASE WHEN json_valid(m.attachments) THEN m.attachments ELSE '[]' END) j
WHERE json_type(j.value) = 'object' AND json_type(j.value, '$.hash') = 'text';

INSERT OR IGNORE INTO media_uploaders (hash, user_id)
SELECT hash, owner_user_id FROM media;

-- Other accounts known to have used the bytes: authors of messages carrying them.
INSERT OR IGNORE INTO media_uploaders (hash, user_id)
SELECT DISTINCT mm.hash, msg.author_id
FROM message_media mm
JOIN messages msg ON msg.id = mm.message_id
JOIN media md ON md.hash = mm.hash
WHERE msg.author_id <> md.owner_user_id;

-- Rows uploaded more than once before uploaders were recorded, with no other
-- account visible in messages: the extra uploads may have been the owner's own
-- or another account's that never sent (or sent elsewhere). Without a record,
-- breaking someone else's file is the worse mistake, so these stay protected
-- under a placeholder uploader ('') until they expire or an operator removes them.
INSERT OR IGNORE INTO media_uploaders (hash, user_id)
SELECT md.hash, ''
FROM media md
WHERE md.refcount > 1
  AND NOT EXISTS (
      SELECT 1 FROM media_uploaders u WHERE u.hash = md.hash AND u.user_id <> md.owner_user_id
  );
