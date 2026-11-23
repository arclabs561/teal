# Listen edits, deletes, and index recovery

The listen record belongs to the user’s AT Protocol repository. Teal’s site reads a derived HappyView projection for browse and stats. The single-listen page can read the repository record through Slingshot before the projection catches up. See the site README for deployment, sync, and backfill commands.

## What happens after an edit or delete

1. The site calls the HappyView procedure with the user's session. The procedure loads the play and any stable or alpha twin with the same record key.
2. The procedure writes to the repository and updates the `teal_plays` projection. The projection prefers the stable record when both versions exist.
3. The record-index handler also applies incoming repository writes and deletes. That event path can repair a projection update missed by the procedure.

Edits should preserve the original source and played time. Changing the recording or release clears a track ID for the previous edition. Deleting a listen should remove a twin as well, so the legacy copy cannot take its place.

## Failure to test

A local Lua fixture modeled the repository delete committing before the SQL update fails. The repository record was gone and the site projection still contained a row. A retry returned `NotFound` because the handler could no longer load the record. Passing the repository delete event to the real record-index handler cleared the row.

This confirms the scripts’ behavior with independently committed operations. The fixture substitutes the PDS and SQL calls. It does not test whether a deployed HappyView resumes delivery after a restart or without its existing cursor.

Keep the fixture with the portable play tests once the project decides how it wants to run Lua tests. Before changing how the delete procedure handles retries, check the real recovery path in a disposable HappyView and PDS: create an indexed play, interrupt indexing, delete it, resume, and verify the direct record and the public aggregate. Include a stable and alpha twin. If the projection stays stale, use the fixture to pin down whether the fix belongs in event recovery or in retrying the explicit delete procedure.

[Delete procedure](https://github.com/teal-fm/teal/blob/main/apps/site/happyview/scripts/fm.teal.site.deletePlay.lua) · [Record-index handler](https://github.com/teal-fm/teal/blob/main/apps/site/happyview/scripts/play.lua) · [Existing fork fixtures](https://github.com/arclabs561/teal/blob/lab/play-record-roundtrip/apps/site/happyview/tests/portable-play.lua)

The twin-order fixture extends this with both processing orders. If the second repository delete fails, a retry can clear the remaining record. If deleting the stable record succeeds but its SQL update fails, retry can report success or NotFound while the projection still contains the stable row. Repeated delivery of the original delete event reconciles the row in both cases. That makes event recovery, and the distinction between repository state and site state, worth checking before changing retry messages.
