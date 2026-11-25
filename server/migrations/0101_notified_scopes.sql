-- Where a user has an outstanding background notification, so reading it on one device can take it
-- off the others. One row per (user, scope): `channel:<id>` on the guild server that sent a
-- mention/reply, `conversation:<id>` on the account home that woke the user's devices for a DM.
-- Reading clears the row and sends one content-free `dismiss` to the user's notification devices;
-- with no row there is nothing showing and nothing is sent, so ordinary reading costs no wakes.
CREATE TABLE notified_scopes (
    user_id     TEXT    NOT NULL,
    scope       TEXT    NOT NULL,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope)
);
