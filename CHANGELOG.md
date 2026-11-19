<!--
User-facing changelog, fetched by the client's "What's new" button
(web/src/lib/changelog.js). Two rules keep that working:

  * Newest first, one `## <date or name>` section per batch of changes
    worth telling people about.
  * The topmost `## ` heading is the identity the client uses to decide
    whether the What's new badge has been read. Editing that heading
    re-shows the badge to everyone.

Write for the people using the app, not the repo: what changed in their
hands, not which PRs merged.
-->

## 17 November 2026

- Both the desktop app and server must be updated to the newest version.
- Users can now recover their account with a recovery key if they lose access to all their devices.

## 15 November 2026

- Users can now manage and delete their uploaded files in settings.

## 26 October 2026

- Voice calls stay connected even if the server goes down temporarily.
- Long calls no longer restart randomly because of internet problems.
- Fixed audio problems that could cause people to stop hearing each other in calls.

## 22 October 2026

- Users can now check which version of Telium they are running.

## 21 October 2026

- An early Android version of Telium is now out.

(Android version is still being worked on, users might run into bugs.)

## 15 October 2026

- Users can now report bugs and send feedback directly through the app.

## 14 October 2026

- Users now install the server directly without needing to use Docker.
- Fixed an issue where private messages could get stuck when sent from an old account session.
- Fixed an issue where messages arriving out of order could interfere with each other.

## Earlier in October

- Guild calls are now more reliable and stay connected through internet problems and server changes.
- Calls now connect properly even when someone answers before the other person's device finishes dialing.
