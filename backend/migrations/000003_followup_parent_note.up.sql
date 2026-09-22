-- parent_note is three columns, not one, because it is a formal statement the
-- centre makes to a customer rather than a memo to colleagues: it has to
-- answer who said it, when, and what - the same audit shape credit_ledger
-- follows by never rewriting a row in place.
--
-- Piggy-backing on completed_at / completed_by_user_id does not work, and
-- fails in both directions. A consultant can resolve a follow-up without
-- ever speaking to the family (status done, parent_note empty), so the two
-- timestamps mean genuinely different things - "we dealt with it" is not
-- "we told them".
ALTER TABLE follow_ups
  ADD COLUMN parent_note VARCHAR(500) NULL,
  ADD COLUMN parent_note_at DATETIME(3) NULL,
  ADD COLUMN parent_note_by_user_id BIGINT UNSIGNED NULL;

-- The three columns move together, and the database is what enforces it.
--
-- parent_note_at is scanned into a non-pointer time.Time by the read path, so a
-- row with a note and no timestamp does not degrade - it 500s the whole student
-- drawer. Filtering such rows out in SQL would hide the fault instead of
-- reporting it, and "the data is malformed" would look on screen exactly like
-- "this student has no feedback", which is the one thing this feature cannot
-- afford to be ambiguous about. So the invariant goes where it can be checked
-- once, structurally: a note we said out loud must be able to answer who said
-- it and when, or it is not a note we said out loud.
ALTER TABLE follow_ups
  ADD CONSTRAINT ck_followup_parent_note_complete
  CHECK (parent_note IS NULL OR (parent_note_at IS NOT NULL AND parent_note_by_user_id IS NOT NULL));
