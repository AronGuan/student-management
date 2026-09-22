-- R5: balance is always derived, never stored on students.
-- No redundancy, so it cannot drift away from the ledger.
CREATE VIEW v_student_balance AS
SELECT s.id AS student_id, COALESCE(SUM(l.delta), 0) AS balance
FROM students s
LEFT JOIN credit_ledger l ON l.student_id = s.id
GROUP BY s.id;
