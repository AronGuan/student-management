package service

import (
	"time"

	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/model"
)

type AttendanceService struct{}

type Mark struct {
	StudentID uint64                 `json:"student_id"`
	Status    model.AttendanceStatus `json:"status"`
	Note      string                 `json:"note"`
}

// Settle is R4 + R5: recording attendance moves money.
//
// Ordering rule: every credit-writing transaction locks the student row
// first. Without it two concurrent settles could both read the same
// balance and both write -1.
func (s *AttendanceService) Settle(db *gorm.DB, actorID, lessonID uint64, marks []Mark) (int, error) {
	ls := &model.Lesson{}
	if err := db.Raw("SELECT * FROM lessons WHERE id = ?", lessonID).Scan(ls).Error; err != nil {
		return 0, err
	}
	if ls.ID == 0 {
		return 0, apierr.ErrNotFound
	}
	if ls.Status == model.LessonCancelled {
		return 0, apierr.ErrLessonCancelledSettle
	}

	charged := 0
	err := db.Transaction(func(tx *gorm.DB) error {
		now := clock.Now()
		for _, m := range marks {
			// R4: the teacher may not invent a leave resolution.
			if m.Status != model.AttPresent && m.Status != model.AttLate && m.Status != model.AttAbsent {
				return apierr.ErrBadAttendance
			}

			// Idempotent: an existing row for this lesson+student is left
			// alone rather than double-charged.
			var existingID uint64
			if err := tx.Raw("SELECT id FROM attendances WHERE lesson_id = ? AND student_id = ?",
				lessonID, m.StudentID).Scan(&existingID).Error; err != nil {
				return err
			}
			if existingID != 0 {
				continue
			}

			if err := (&CreditService{}).LockStudent(tx, m.StudentID); err != nil {
				return err
			}

			att := &model.Attendance{
				LessonID:         lessonID,
				StudentID:        m.StudentID,
				Status:           m.Status,
				Source:           "teacher_override",
				RecordedByUserID: &actorID,
				RecordedAt:       &now,
				Note:             m.Note,
			}
			if err := tx.Create(att).Error; err != nil {
				return err
			}

			if m.Status.Charges() {
				if err := (&CreditService{}).Apply(tx, &model.CreditLedger{
					StudentID:    m.StudentID,
					Delta:        -1,
					Reason:       model.ReasonConsume,
					LessonID:     &lessonID,
					AttendanceID: &att.ID,
					ActorUserID:  actorID,
					Note:         string(m.Status),
				}); err != nil {
					if IsDuplicateLedger(err) {
						continue
					}
					return err
				}
				charged++
			}
		}
		if err := tx.Exec("UPDATE lessons SET status='completed', updated_at=? WHERE id=? AND status='scheduled'",
			now, lessonID).Error; err != nil {
			return err
		}
		return nil
	})
	return charged, err
}

// Override lets a teacher correct a single mark after the fact.
// Still restricted to the three statuses they are allowed to set.
func (s *AttendanceService) Override(db *gorm.DB, actorID, lessonID, studentID uint64, st model.AttendanceStatus) error {
	if st != model.AttPresent && st != model.AttLate && st != model.AttAbsent {
		return apierr.ErrBadAttendance
	}
	return db.Transaction(func(tx *gorm.DB) error {
		now := clock.Now()
		prev := &model.Attendance{}
		if err := tx.Raw("SELECT * FROM attendances WHERE lesson_id=? AND student_id=?", lessonID, studentID).
			Scan(prev).Error; err != nil {
			return err
		}
		if prev.ID == 0 {
			return apierr.ErrNotFound
		}

		if err := (&CreditService{}).LockStudent(tx, studentID); err != nil {
			return err
		}

		res := tx.Exec(`UPDATE attendances SET status=?, source='teacher_override',
			recorded_by_user_id=?, recorded_at=?, note=CONCAT_WS(' | ', note, ?)
			WHERE id=?`, st, actorID, now, "corrected from "+string(prev.Status), prev.ID)
		if res.Error != nil {
			return res.Error
		}

		// Reverse the money if the charge decision changed. This appends a
		// compensating entry instead of deleting the original one.
		wasCharged := prev.Status.Charges()
		nowCharged := st.Charges()
		if wasCharged && !nowCharged {
			return (&CreditService{}).Apply(tx, &model.CreditLedger{
				StudentID:    studentID,
				Delta:        +1,
				Reason:       model.ReasonManualAdjust,
				LessonID:     &lessonID,
				AttendanceID: &prev.ID,
				ActorUserID:  actorID,
				Note:         "correction: " + string(prev.Status) + " -> " + string(st),
			})
		}
		if !wasCharged && nowCharged {
			return (&CreditService{}).Apply(tx, &model.CreditLedger{
				StudentID:    studentID,
				Delta:        -1,
				Reason:       model.ReasonConsume,
				LessonID:     &lessonID,
				AttendanceID: &prev.ID,
				ActorUserID:  actorID,
				Note:         "correction: " + string(prev.Status) + " -> " + string(st),
			})
		}
		return nil
	})
}

// LessonStart turns a date plus start-of-day minutes into an instant.
// Used for the 24h leave threshold.
func LessonStart(ls *model.Lesson) (time.Time, error) {
	d, err := time.ParseInLocation("2006-01-02", ls.LessonDate, clock.Loc())
	if err != nil {
		return time.Time{}, err
	}
	return d.Add(time.Duration(ls.StartMin) * time.Minute), nil
}

// RequestLeave is judged by the server at submission time - there is no
// human approval step. A pending state would be an undefined state, and
// the parent gets a definite answer immediately instead of waiting.
//
// A late leave (< 24h notice) still consumes the credit, and the money
// must move the moment the leave is granted: if we waited for a roll call,
// a lesson the teacher never settles would make the rule a no-op.
//
// The ledger entry uses ReasonConsume, not leave_adjust, because
// uq_ledger_consume(student_id, lesson_id, reason) is what makes this
// idempotent: if the teacher later settles the same lesson and marks this
// student, Settle's duplicate-key branch swallows the second charge.
// leave_adjust would evade that gate and allow a double charge.
func (s *AttendanceService) RequestLeave(db *gorm.DB, cfg *config.Config, actorUserID, studentID, lessonID uint64, reason string) (*model.LeaveRequest, error) {
	ls := &model.Lesson{}
	if err := db.Raw("SELECT * FROM lessons WHERE id = ?", lessonID).Scan(ls).Error; err != nil {
		return nil, err
	}
	if ls.ID == 0 {
		return nil, apierr.ErrNotFound
	}
	if ls.Status == model.LessonCancelled {
		return nil, apierr.ErrLessonCancelledLeave
	}
	// The student id and the lesson id both come from the caller, so the
	// pairing has to be verified here. Without it any caller can name a
	// lesson in a class the student has never attended, and the late path
	// below would charge a real credit and write an attendance row into
	// that class's lesson.
	var enrolled int
	if err := db.Raw(`SELECT COUNT(*) FROM class_enrollments e
		JOIN lessons l ON l.id = ?
		WHERE e.student_id = ? AND e.class_id = l.class_id AND e.status = 'active'`,
		lessonID, studentID).Scan(&enrolled).Error; err != nil {
		return nil, err
	}
	if enrolled == 0 {
		return nil, apierr.ErrNotEnrolled
	}
	start, err := LessonStart(ls)
	if err != nil {
		return nil, err
	}
	now := clock.Now()
	if !start.After(now) {
		return nil, apierr.ErrLessonAlreadyStarted
	}

	hours := int(start.Sub(now).Hours())
	late := hours < cfg.Thresholds.LeaveNoticeHours
	resolution := "approved_ge_24h"
	if late {
		resolution = "late_lt_24h"
	}

	req := &model.LeaveRequest{
		LessonID:          lessonID,
		StudentID:         studentID,
		RequestedByUserID: actorUserID,
		RequestedAt:       now,
		Reason:            reason,
		Resolution:        resolution,
		HoursBeforeStart:  hours,
		CreatedAt:         now,
	}

	err = db.Transaction(func(tx *gorm.DB) error {
		// The student row is this student's accounting mutex and is taken
		// first in every transaction that writes the ledger (R5).
		if late {
			if err := (&CreditService{}).LockStudent(tx, studentID); err != nil {
				return err
			}
		}
		if err := tx.Create(req).Error; err != nil {
			return err
		}
		if !late {
			// >= 24h notice: the leave is free, so there is nothing to
			// record beyond the leave request itself.
			return nil
		}

		att := &model.Attendance{
			LessonID:   lessonID,
			StudentID:  studentID,
			Status:     model.AttLeaveLate,
			Source:     "system",
			RecordedAt: &now,
			Note:       "late leave: notice < 24h",
		}
		if err := tx.Create(att).Error; err != nil {
			return err
		}
		return (&CreditService{}).Apply(tx, &model.CreditLedger{
			StudentID:    studentID,
			Delta:        -1,
			Reason:       model.ReasonConsume,
			LessonID:     &lessonID,
			AttendanceID: &att.ID,
			ActorUserID:  actorUserID,
			Note:         "late leave: notice < 24h",
		})
	})
	if err != nil {
		return nil, err
	}
	return req, nil
}
