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
	// A flag, not a second text field. The teacher's observation already
	// went into Note above; this only says "someone else has to pick this
	// up", and the sentence the family eventually reads is written later
	// by the consultant (follow_ups.parent_note). Two text fields would be
	// two copies of one thought, drifting apart the moment either is
	// edited.
	NeedsFollowUp bool `json:"needs_follow_up"`
}

// The two strings this file writes into attendances.note with no human
// behind them. They live here because this is where they are written, and
// they are package-level because ai.go reads the same column back as
// "teacher feedback" and has to recognise them: if either literal drifts,
// the renewal card starts quoting system scaffolding as though a teacher
// had said it, and nothing else in the build would notice. One definition
// makes that impossible rather than merely unlikely.
const (
	// correctionPrefix is what Override stamps ahead of the old status when
	// it audits a correction, e.g. "corrected from present".
	correctionPrefix = "corrected from "
	// correctionMarker is that same text as it appears once CONCAT_WS has
	// joined it to whatever the column already held. Repeated corrections
	// stack, so a reader has to split on the first occurrence rather than
	// trim a suffix.
	correctionMarker = " | corrected from "
	// lateLeaveNote is the entire note ResolveLeave writes when notice was
	// under 24h. That row carries no teacher remark at all.
	lateLeaveNote = "late leave: notice < 24h"
)

// Settle is R4 + R5: recording attendance moves money.
//
// It has a second output besides money: a mark carrying needs_follow_up
// opens a consultant task in the same transaction. That is why it takes
// cfg - the task's deadline is the same configured SLA the trial path
// uses, not a literal repeated here.
//
// Ordering rule: every credit-writing transaction locks the student row
// first. Without it two concurrent settles could both read the same
// balance and both write -1.
func (s *AttendanceService) Settle(db *gorm.DB, cfg *config.Config, actorID, lessonID uint64, marks []Mark) (int, error) {
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

			// The classroom flag: the teacher ticked "a consultant has to
			// take this over", so a task row is opened for the consultant
			// in this same transaction. It is a flag and not a second text
			// field by design - the only person who can write this column
			// is the teacher standing in the room, and the sentence the
			// family eventually reads is written afterwards by the
			// consultant who digested it. Neither is derived from the
			// other.
			//
			// The two checks above decide whether this runs at all, and
			// both decisions are load-bearing:
			//
			//   - The `existingID != 0` continue means only a settle that
			//     actually created the attendance row gets here. Replaying
			//     the same roll call stops at that branch, so ticking the
			//     box twice yields one task, not two. Idempotence comes
			//     from attendances' own uniqueness rather than from a
			//     second guard that could disagree with it.
			//   - It sits before the charging block because the
			//     IsDuplicateLedger branch inside that block `continue`s
			//     past everything below it. A duplicate consume entry says
			//     the money for this lesson+student was already taken; it
			//     says nothing about whether a person still has to call the
			//     family. Letting a money key swallow the task would drop a
			//     flagged student silently, and it would do so exactly in
			//     the replay case most likely to be flagged.
			//
			// note and parent_note* stay empty on purpose: the teacher's
			// sentence is already in attendances.note, and copying it here
			// would make two copies of one remark that drift the moment
			// either side is edited. follow_ups.note means "what the
			// consultant did about it" - CompleteFollowUp overwrites it -
			// so the teacher's original wording would be erased the first
			// time the task was closed.
			//
			// The deadline comes from cfg.Thresholds.FollowUpSLAHours, the
			// same field the trial conversion path reads, so both origins
			// of a follow-up are measured by one clock; a literal 48 here
			// would be a second source of truth for the same promise.
			if m.NeedsFollowUp {
				fu := &model.FollowUp{
					StudentID: m.StudentID,
					// nil: this row did not come from a trial, and
					// pointing TrialID at a stand-in would make the
					// column say something untrue. Source, not the
					// absence of trial_id, is what tells the reader
					// where it came from.
					TrialID:   nil,
					Source:    "teacher_note",
					DueAt:     now.Add(time.Duration(cfg.Thresholds.FollowUpSLAHours) * time.Hour),
					Status:    "pending",
					CreatedAt: now,
				}
				if err := tx.Create(fu).Error; err != nil {
					return err
				}
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

		// LEFT(...,255): note is VARCHAR(255), and the correction suffix is
		// appended to whatever the teacher already typed. Without the cap, a
		// long teacher remark would make the correction itself fail on a
		// strict-mode "data too long" - i.e. the audit trail would block the
		// correction it is supposed to record.
		//
		// The cap cuts from the tail, so a remark within ~20 characters of
		// the limit can leave the suffix as a fragment like " | corrected
		// fr". teacherFeedback would then read that fragment as the
		// teacher's own words. The window is narrow and the cost is one
		// noisy evidence line, so it is documented instead of paid for with
		// a reserved-width trick that would silently shorten every remark.
		res := tx.Exec(`UPDATE attendances SET status=?, source='teacher_override',
			recorded_by_user_id=?, recorded_at=?, note=LEFT(CONCAT_WS(' | ', note, ?), 255)
			WHERE id=?`, st, actorID, now, correctionPrefix+string(prev.Status), prev.ID)
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
			Note:       lateLeaveNote,
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
			Note:         lateLeaveNote,
		})
	})
	if err != nil {
		return nil, err
	}
	return req, nil
}
