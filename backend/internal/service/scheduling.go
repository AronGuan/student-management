package service

import (
	"time"

	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/model"
)

type SchedulingService struct{}

// CreateClass rejects a teacher being in two places at once (R3b).
func (s *SchedulingService) CreateClass(db *gorm.DB, c *model.Class) error {
	if c.EndMin <= c.StartMin {
		return apierr.BadRequest("end_min 必须大于 start_min")
	}
	if c.Capacity <= 0 {
		return apierr.BadRequest("capacity 必须为正数")
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var conflict int
		err := tx.Raw(`SELECT COUNT(*) FROM classes
			WHERE teacher_id = ? AND weekday = ? AND status = 'active'
			  AND start_min < ? AND ? < end_min`,
			c.TeacherID, c.Weekday, c.EndMin, c.StartMin).Scan(&conflict).Error
		if err != nil {
			return err
		}
		if conflict > 0 {
			return apierr.ErrTeacherConflict
		}
		now := clock.Now()
		c.CreatedAt = now
		c.UpdatedAt = now
		return tx.Create(c).Error
	})
}

// Enroll is R3 + R6 in one transaction.
//
// MySQL has no Postgres EXCLUDE constraint, and under READ COMMITTED a
// range lock does not block an insert, so we do not rely on gap locks.
// Instead we lock the two parent rows up front - they act as explicit
// mutual-exclusion points regardless of isolation level - and then run
// the four checks.
func (s *SchedulingService) Enroll(db *gorm.DB, actorID, classID, studentID uint64) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var sid, cid uint64
		if err := tx.Raw("SELECT id FROM students WHERE id = ? AND deleted_at IS NULL FOR UPDATE", studentID).
			Scan(&sid).Error; err != nil {
			return err
		}
		if sid == 0 {
			return apierr.ErrNotFound
		}
		if err := tx.Raw("SELECT id FROM classes WHERE id = ? FOR UPDATE", classID).Scan(&cid).Error; err != nil {
			return err
		}
		if cid == 0 {
			return apierr.ErrNotFound
		}

		cls := &model.Class{}
		if err := tx.Raw("SELECT * FROM classes WHERE id = ?", classID).Scan(cls).Error; err != nil {
			return err
		}

		// (a) weekly slot overlap - half-open interval intersection.
		// Two classes conflict only when they share a weekday AND their
		// intervals actually intersect; a student may legitimately be in
		// several classes as long as the times do not collide.
		var overlap int
		err := tx.Raw(`SELECT COUNT(*) FROM class_enrollments e
			JOIN classes c ON c.id = e.class_id
			WHERE e.student_id = ? AND e.status = 'active'
			  AND c.weekday = ? AND c.start_min < ? AND ? < c.end_min`,
			studentID, cls.Weekday, cls.EndMin, cls.StartMin).Scan(&overlap).Error
		if err != nil {
			return err
		}
		if overlap > 0 {
			return apierr.ErrSlotOverlap
		}

		// (b) capacity
		var enrolled int
		if err := tx.Raw("SELECT COUNT(*) FROM class_enrollments WHERE class_id = ? AND status = 'active'", classID).
			Scan(&enrolled).Error; err != nil {
			return err
		}
		if enrolled >= cls.Capacity {
			return apierr.ErrClassFull
		}

		// (c) balance must be positive - R6. Enrolling with no credits
		// would sell time the school has not been paid for.
		bal, err := (&CreditService{}).SumBalance(tx, studentID)
		if err != nil {
			return err
		}
		if bal <= 0 {
			return apierr.ErrNoCredit
		}

		e := &model.ClassEnrollment{
			ClassID:    classID,
			StudentID:  studentID,
			Weekday:    cls.Weekday,
			StartMin:   cls.StartMin,
			Status:     "active",
			EnrolledOn: clock.Now(),
		}
		if err := tx.Create(e).Error; err != nil {
			return err
		}

		// Entering a class means the student is no longer just a lead.
		if err := tx.Exec("UPDATE students SET status = 'active', updated_at = ? WHERE id = ? AND status IN ('lead','trial')",
			clock.Now(), studentID).Error; err != nil {
			return err
		}
		return writeAudit(tx, actorID, "class_enrollment", e.ID, "enroll", map[string]interface{}{
			"class_id": classID, "student_id": studentID,
		})
	})
}

// Withdraw is soft: the row stays so history survives.
func (s *SchedulingService) Withdraw(db *gorm.DB, actorID, classID, studentID uint64) error {
	now := clock.Now()
	return db.Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(`UPDATE class_enrollments SET status='withdrawn', withdrawn_on=?
			WHERE class_id=? AND student_id=? AND status='active'`, now, classID, studentID)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apierr.ErrNotFound
		}
		return writeAudit(tx, actorID, "class_enrollment", classID, "withdraw", map[string]interface{}{
			"student_id": studentID,
		})
	})
}

// GenerateLessons expands recurring classes into dated instances.
// A class is a weekly slot; a lesson is one real meeting.
func (s *SchedulingService) GenerateLessons(db *gorm.DB, from, to string) (int, error) {
	start, err := time.ParseInLocation("2006-01-02", from, clock.Loc())
	if err != nil {
		return 0, apierr.BadRequest("from_date 必须是 YYYY-MM-DD 格式")
	}
	end, err := time.ParseInLocation("2006-01-02", to, clock.Loc())
	if err != nil {
		return 0, apierr.BadRequest("to_date 必须是 YYYY-MM-DD 格式")
	}
	if end.Before(start) {
		return 0, apierr.BadRequest("to_date 不能早于 from_date")
	}

	var classes []model.Class
	if err := db.Raw("SELECT * FROM classes WHERE status = 'active'").Scan(&classes).Error; err != nil {
		return 0, err
	}

	created := 0
	err = db.Transaction(func(tx *gorm.DB) error {
		now := clock.Now()
		for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
			wd := int(d.Weekday()) // Sunday = 0 in Go
			if wd == 0 {
				wd = 7
			}
			for _, c := range classes {
				if c.Weekday != wd%7 && c.Weekday != wd {
					continue
				}
				res := tx.Exec(`INSERT IGNORE INTO lessons
					(class_id, teacher_id, lesson_date, weekday, start_min, end_min, status, created_at, updated_at)
					VALUES (?,?,?,?,?,?,'scheduled',?,?)`,
					c.ID, c.TeacherID, d.Format("2006-01-02"), c.Weekday, c.StartMin, c.EndMin, now, now)
				if res.Error != nil {
					return res.Error
				}
				created += int(res.RowsAffected)
			}
		}
		return nil
	})
	return created, err
}

// CancelRange is R10: a teacher away for a week. We cancel the dated
// lesson rows only. Because attendance and ledger entries are generated
// from lessons, no attendance exists and no credit is ever consumed -
// the student is not charged for a class that did not happen.
//
// A late-notice leave (D1) is the one exception: it charges at request
// time, before the lesson is cancelled. A cancelled lesson must cost
// nothing, so this appends a compensating +1 for every late leave already
// charged on a lesson being cancelled. Append-only: the original -1 stays
// in place for audit.
func (s *SchedulingService) CancelRange(db *gorm.DB, actorID, teacherID uint64, from, to, reason string) (int, error) {
	now := clock.Now()
	affected := 0
	err := db.Transaction(func(tx *gorm.DB) error {
		// Lock and pin the exact set being cancelled. Selecting the ids
		// first means the compensation below can never reach a lesson that
		// an earlier call already cancelled, so it cannot run twice.
		var lessonIDs []uint64
		if err := tx.Raw(`SELECT id FROM lessons
			WHERE teacher_id=? AND lesson_date BETWEEN ? AND ? AND status='scheduled'
			FOR UPDATE`, teacherID, from, to).Scan(&lessonIDs).Error; err != nil {
			return err
		}
		if err := tx.Exec(`UPDATE lessons SET status='cancelled', cancel_reason=?, updated_at=?
			WHERE teacher_id=? AND lesson_date BETWEEN ? AND ? AND status='scheduled'`,
			reason, now, teacherID, from, to).Error; err != nil {
			return err
		}
		affected = len(lessonIDs)

		for _, lessonID := range lessonIDs {
			var charged []struct {
				AttendanceID uint64 `json:"attendance_id"`
				StudentID    uint64 `json:"student_id"`
			}
			err := tx.Raw(`SELECT a.id AS attendance_id, a.student_id
				FROM attendances a
				JOIN credit_ledger l ON l.attendance_id = a.id
				  AND l.reason = 'consume' AND l.lesson_id = a.lesson_id
				WHERE a.lesson_id = ? AND a.status = 'leave_late'`, lessonID).Scan(&charged).Error
			if err != nil {
				return err
			}
			for _, c := range charged {
				if err := (&CreditService{}).LockStudent(tx, c.StudentID); err != nil {
					return err
				}
				lessonRef, attRef := lessonID, c.AttendanceID
				if err := (&CreditService{}).Apply(tx, &model.CreditLedger{
					StudentID:    c.StudentID,
					Delta:        +1,
					Reason:       model.ReasonManualAdjust,
					LessonID:     &lessonRef,
					AttendanceID: &attRef,
					ActorUserID:  actorID,
					Note:         "cancel-range compensation: " + reason,
				}); err != nil {
					return err
				}
				// The lesson did not happen, so this row must not be
				// mistaken for a real roll call.
				if err := tx.Exec(`UPDATE attendances SET status='leave_approved', source='system'
					WHERE id=?`, c.AttendanceID).Error; err != nil {
					return err
				}
			}
		}

		return writeAudit(tx, actorID, "lesson", teacherID, "cancel_range", map[string]interface{}{
			"from": from, "to": to, "reason": reason, "cancelled": affected,
		})
	})
	return affected, err
}

func writeAudit(tx *gorm.DB, actorID uint64, entity string, entityID uint64, action string, payload map[string]interface{}) error {
	b, err := jsonMarshal(payload)
	if err != nil {
		return err
	}
	ev := &model.AuditEvent{
		ActorUserID: &actorID,
		Entity:      entity,
		EntityID:    entityID,
		Action:      action,
		PayloadJSON: string(b),
		CreatedAt:   clock.Now(),
	}
	return tx.Create(ev).Error
}
