-- source answers "why does this row exist", and it is written by the path
-- that creates the row instead of being inferred by whoever reads it.
--
-- Before this column the answer was derived from trial_id: NULL meant the
-- row came from a teacher's classroom flag. That is a sign-without-guard -
-- the moment a third origin appears it silently mislabels every new row,
-- and nothing in the build (no constraint, no index, no test) would report
-- it; the mislabel would just start appearing in a consultant's queue one
-- day. As an ENUM, a wrong value cannot be written at all.
--
-- DEFAULT 'trial' is a backfill of a known fact, not a convenience. Every
-- row that exists before this migration really did come from the trial
-- path: up to 000003 follow_ups has exactly one writer - SetOutcome in
-- service/trial.go, which always sets TrialID - and the seed creates all
-- of its follow-ups the same way. It is spelled out here because on a
-- NOT NULL column a default reads as arbitrary to the next person unless
-- the note says otherwise, and "000004 and earlier = trial" is the
-- distinction the consultant queues now depend on.
--
-- The default does not excuse the write paths from stating the source
-- themselves (service/trial.go, service/attendance.go). A writer that
-- leans on a default is relying on a value that lives in another file,
-- which can be changed - or the column re-created by a later migration -
-- without any compiler, test or constraint noticing that the label moved.
ALTER TABLE follow_ups
  ADD COLUMN source ENUM('trial','teacher_note') NOT NULL DEFAULT 'trial' AFTER trial_id;

-- The new index exists for the consultant workbench, whose flagged queue
-- is `status='pending' AND source='teacher_note'` ordered by due_at.
--
-- idx_followup_status(status, due_at) cannot serve it: source is the
-- leading predicate there, and with three status values the existing
-- index still makes the reader walk every pending row of either origin
-- and filter afterwards. The column order here mirrors the predicate
-- order on purpose - two equality lookups first, so the range scan on
-- due_at is reached directly instead of being a sort of the survivors.
ALTER TABLE follow_ups
  ADD INDEX idx_followup_source (source, status, due_at);
