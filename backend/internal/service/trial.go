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
	if t.StudentID == 0 || t.SubjectID == 0 {
		return apierr.BadRequest("student_id 与 subject_id 为必填")
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
func (s *TrialService) SetOutcome(db *gorm.DB, cfg *config.Config, trialID uint64, outcome, note string) (*model.FollowUp, error) {
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
		if err := tx.Exec("UPDATE trials SET outcome=?, outcome_note=?, updated_at=? WHERE id=?",
			outcome, note, now, trialID).Error; err != nil {
			return err
		}
		due := now.Add(time.Duration(cfg.Thresholds.FollowUpSLAHours) * time.Hour)
		fu = &model.FollowUp{
			StudentID: t.StudentID,
			TrialID:   &trialID,
			DueAt:     due,
			Status:    "pending",
			CreatedAt: now,
		}
		return tx.Create(fu).Error
	})
	return fu, err
}

type FollowUpFilter struct {
	Status       string // pending | overdue | done
	OwnerAdminID *uint64
	Page, Limit  int
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
		if rows[i].Status == "pending" {
			// Same sign convention as /dashboard/admin: positive means
			// overdue, negative means not yet due. Hours, truncated toward
			// zero, so "due in 30 minutes" is 0 and "due in 12 hours" is
			// -12. The front end owns the wording and renders nothing for
			// <= 0, so a future follow-up falls back to its own SLA
			// countdown instead of being labelled overdue.
			//
			// now.Sub(due), NOT due.Sub(now): the two differ only in sign,
			// and the `?status=pending` filter above selects due_at >= now,
			// so the wrong order silently made every future row read as
			// overdue - the opposite of what this field promises.
			hours := int64(now.Sub(rows[i].DueAt).Hours())
			rows[i].OverdueHours = &hours
		}
	}
	return rows, total, nil
}

func (s *TrialService) CompleteFollowUp(db *gorm.DB, actorID, id uint64, note string) error {
	now := clock.Now()
	return db.Transaction(func(tx *gorm.DB) error {
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
