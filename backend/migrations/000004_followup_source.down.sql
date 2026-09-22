-- Dropping source is a one-way door for the data, not just for the schema:
-- once the column is gone, a teacher-flagged row and a trial-conversion row
-- are the same row again, and there is nothing left to re-derive the
-- distinction from (trial_id is NULL on both the teacher-flagged rows and
-- on any future origin). The down migration is still written honestly
-- because the runner must be able to unwind 000004 in its own tests - but
-- running it against a database that has already taken classroom flags
-- loses which of those rows were classroom flags, with no way to tell
-- afterwards which ones were.
ALTER TABLE follow_ups
  DROP INDEX idx_followup_source,
  DROP COLUMN source;
