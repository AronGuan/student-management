package service

import (
	"time"

	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/model"
)

type TrialService struct{}

// CreateTrial enforces R1: one trial per student per subject.
// The database carries UNIQUE(student_id, subject_id); the pre-check only
// exists to return a clean business code instead of a MySQL error.
func (s *TrialService) CreateTrial(db *gorm.DB, t *model.Trial) error {
	// teacher_id is required, not merely optional-in-practice:
	// a trial with no teacher cannot produce an attendance record, so it can
	// never be settled against the family's prepaid credits; and GET /trials
	// scopes the teacher role by trials.teacher_id = self, so a NULL teacher
	// makes the row invisible to every teacher who could have taught it - it
	// silently drops out of the only queue that would chase it.
	// The column is NULL-able, so the check must reject both a missing field
	// (nil pointer) and an explicit 0.
	if t.StudentID == 0 || t.SubjectID == 0 || t.TeacherID == nil || *t.TeacherID == 0 {
		return apierr.BadRequest("student_id、subject_id 与 teacher_id 为必填")
	}
	var dup int
	if err := db.Raw("SELECT COUNT(*) FROM trials WHERE student_id=? AND subject_id=?",
		t.StudentID, t.SubjectID).Scan(&dup).Error; err != nil {
		return err
	}
	if dup > 0 {
		return apierr.ErrTrialDuplicate
	}
	now := clock.Now()
	t.CreatedAt = now
	t.UpdatedAt = now
	if t.Outcome == "" {
		t.Outcome = "pending"
	}
	if t.DurationMin == 0 {
		t.DurationMin = 60
	}

	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(t).Error; err != nil {
			if IsDuplicate(err, "uq_trial_once") {
				return apierr.ErrTrialDuplicate
			}
			return err
		}
		// A student with a booked trial is no longer a bare lead.
		return tx.Exec("UPDATE students SET status='trial', updated_at=? WHERE id=? AND status='lead'",
			now, t.StudentID).Error
	})
}

// SetOutcome is R2: the moment a trial result is recorded, a follow-up
// with a 48h due date is created in the same transaction. Nothing about
// the SLA depends on a background job, so it is always demonstrable.
//
// It is also a write, so R7 reaches it: the caller must own the student
// behind the trial. The check is delegated to StudentService.AssertOwner
// instead of being spelled out here, because "who owns this student" must
// have exactly one implementation - a second copy is how the two drift.
//
// Finally it is the step that closes the lifecycle transition
// lead -> trial -> active (model.go:41). CreateTrial performs the first
// hop; until now nothing performed the second, so a converted prospect
// stayed a prospect forever. Only a conversion pays that forward.
func (s *TrialService) SetOutcome(db *gorm.DB, cfg *config.Config, trialID uint64, outcome, note string, actorID uint64, actorRole model.Role) (*model.FollowUp, error) {
	switch outcome {
	case "converted", "lost":
	default:
		return nil, apierr.BadRequest("outcome 只能是 converted 或 lost")
	}
	now := clock.Now()
	fu := &model.FollowUp{}
	err := db.Transaction(func(tx *gorm.DB) error {
		t := &model.Trial{}
		if err := tx.Raw("SELECT * FROM trials WHERE id=?", trialID).Scan(t).Error; err != nil {
			return err
		}
		if t.ID == 0 {
			return apierr.ErrNotFound
		}
		// A trial row carries no owner of its own, so ownership is asked
		// of the student it belongs to.
		if err := (&StudentService{}).AssertOwner(tx, actorID, actorRole, t.StudentID); err != nil {
			return err
		}
		if err := tx.Exec("UPDATE trials SET outcome=?, outcome_note=?, updated_at=? WHERE id=?",
			outcome, note, now, trialID).Error; err != nil {
			return err
		}
		if outcome == "converted" {
			// The status predicate is a guard, not a formality: without it
			// a late conversion would resurrect an already 'churned'
			// student, and would overwrite an 'active' one for no reason.
			// Both cases end up a no-op rather than an error, because from
			// the caller's side re-marking a converted trial is idempotent.
			if err := tx.Exec("UPDATE students SET status='active', updated_at=? WHERE id=? AND status IN ('lead','trial')",
				now, t.StudentID).Error; err != nil {
				return err
			}
		}
		// There is deliberately no else branch: "lost" touches no state at
		// all. An unconverted prospect stays in the consultant's queue to
		// be won back, so flipping them to 'churned' here would be
		// abandoning them automatically.
		due := now.Add(time.Duration(cfg.Thresholds.FollowUpSLAHours) * time.Hour)
		fu = &model.FollowUp{
			StudentID: t.StudentID,
			TrialID:   &trialID,
			// Spelled out even though the column defaults to 'trial':
			// a writer that leans on the default is depending on a value
			// that lives in the schema, so the day it changes - or a
			// migration re-creates the column differently - these rows get
			// relabelled with nothing in the build reporting it. The path
			// that knows why the row exists is the one that says so.
			Source:    "trial",
			DueAt:     due,
			Status:    "pending",
			CreatedAt: now,
		}
		if err := tx.Create(fu).Error; err != nil {
			return err
		}
		// The audit trail was missing here while enroll, withdraw,
		// cancel_range, transfer_owner and follow-up completion all wrote
		// one - this was the only write path that left no trace.
		return writeAudit(tx, actorID, "trial", trialID, "outcome", map[string]interface{}{
			"outcome": outcome, "note": note, "student_id": t.StudentID,
		})
	})
	return fu, err
}

type FollowUpFilter struct {
	Status       string // pending | overdue | done
	OwnerAdminID *uint64
	// StudentID narrows the queue to one student, which is what the leads
	// page needs when it shows a single prospect's follow-ups. A pointer so
	// that "no filter" and "student 0" cannot be confused - student ids
	// start at 1, but relying on that would make the zero value silently
	// mean two different things.
	StudentID   *uint64
	Page, Limit int
}

// ListFollowUps derives overdue at read time. Storing an overdue flag
// would need a scheduler to stay truthful; deriving it means the queue is
// correct the instant the clock passes the deadline.
func (s *TrialService) ListFollowUps(db *gorm.DB, f FollowUpFilter) ([]model.FollowUp, int64, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.Limit < 1 || f.Limit > 200 {
		f.Limit = 20
	}
	now := clock.Now()

	where := []string{"1=1"}
	args := []interface{}{}
	switch f.Status {
	case "pending":
		where = append(where, "fu.status='pending' AND fu.due_at >= ?")
		args = append(args, now)
	case "overdue":
		where = append(where, "fu.status='pending' AND fu.due_at < ?")
		args = append(args, now)
	case "done":
		where = append(where, "fu.status='done'")
	}
	if f.OwnerAdminID != nil {
		where = append(where, "s.owner_admin_id = ?")
		args = append(args, *f.OwnerAdminID)
	}
	if f.StudentID != nil {
		where = append(where, "fu.student_id = ?")
		args = append(args, *f.StudentID)
	}

	var total int64
	if err := db.Raw("SELECT COUNT(*) FROM follow_ups fu JOIN students s ON s.id=fu.student_id WHERE "+
		joinWhere(where), args...).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	q := `SELECT fu.*, s.full_name AS student_name
		FROM follow_ups fu JOIN students s ON s.id = fu.student_id
		WHERE ` + joinWhere(where) + ` ORDER BY fu.due_at ASC LIMIT ? OFFSET ?`
	args = append(args, f.Limit, (f.Page-1)*f.Limit)

	// Initialised so an empty queue serialises as items:[] rather than null.
	rows := []model.FollowUp{}
	if err := db.Raw(q, args...).Scan(&rows).Error; err != nil {
		return nil, 0, err
	}
	for i := range rows {
		if rows[i].Status == "pending" && rows[i].DueAt.Before(now) {
			// Only rows past their deadline carry a value, and it is never
			// negative. Pointer plus omitempty then means exactly one
			// thing: this key is present iff the follow-up is overdue.
			//
			// A signed convention (-12 = "due in 12 hours") was considered
			// and rejected: the field is called overdue_hours, so a
			// negative value contradicts its own name, and it would give
			// this field a wider domain than its documented twin on
			// /dashboard/admin, which is [0, +inf). Same name, same
			// meaning, or it is not the same field.
			//
			// now.Sub(due), not due.Sub(now): the two differ only in sign,
			// and getting it backwards would make every overdue row read
			// as "not due yet" while every future row reads as overdue.
			//
			// Truncated toward zero, so a row less than an hour overdue is
			// 0. The front end treats <= 0 as "no number to show" and
			// falls back to its own SLA countdown, so nothing ever prints
			// "overdue 0 hours".
			hours := int64(now.Sub(rows[i].DueAt).Hours())
			rows[i].OverdueHours = &hours
		}
	}
	return rows, total, nil
}

// CompleteFollowUp closes a follow-up task. The id alone does not
// authorize that: with no ownership predicate a caller could close anyone
// else's task by guessing an id, which is the classic IDOR. So the student
// behind the follow-up is resolved first and R7 is applied to them through
// the same AssertOwner every other write path uses.
func (s *TrialService) CompleteFollowUp(db *gorm.DB, actorID uint64, actorRole model.Role, id uint64, note string) error {
	now := clock.Now()
	return db.Transaction(func(tx *gorm.DB) error {
		var studentID uint64
		if err := tx.Raw("SELECT student_id FROM follow_ups WHERE id=?", id).Scan(&studentID).Error; err != nil {
			return err
		}
		if studentID == 0 {
			return apierr.ErrNotFound
		}
		if err := (&StudentService{}).AssertOwner(tx, actorID, actorRole, studentID); err != nil {
			return err
		}
		res := tx.Exec(`UPDATE follow_ups SET status='done', completed_at=?, completed_by_user_id=?, note=?
			WHERE id=? AND status='pending'`, now, actorID, note, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apierr.ErrNotFound
		}
		return writeAudit(tx, actorID, "follow_up", id, "complete", map[string]interface{}{"note": note})
	})
}

func joinWhere(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += p
	}
	return out
}
