package service

import (
	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/model"
)

// RosterEntry is one row of the teacher's roll-call sheet.
//
// prefilled_status and current_status are separate on purpose. The system
// pre-fills an absence so the teacher never has to make a financial
// decision on the family's behalf, but the teacher still needs to know
// whether a roll call has actually been recorded. Collapsing both facts
// into one field loses one of them.
type RosterEntry struct {
	StudentID       uint64  `json:"student_id"`
	StudentName     string  `json:"student_name"`
	IsNewToClass    bool    `json:"is_new_to_class"`
	PrefilledStatus *string `json:"prefilled_status"`
	CurrentStatus   *string `json:"current_status"`
	Source          string  `json:"source"`
	Balance         int     `json:"balance"`
	// Note is the teacher's free-text remark on this row. It is the only
	// field on the sheet a teacher owns outright - balance and
	// is_new_to_class are derived, and the two leave statuses are judged
	// by the server. Returning it is what makes the remark column a field
	// rather than a write-only slot: without it a typed note survives in
	// the database but disappears from the sheet on the next load.
	Note *string `json:"note"`
}

// RosterView is the lesson together with its roll-call sheet.
type RosterView struct {
	Lesson  model.Lesson  `json:"lesson"`
	Entries []RosterEntry `json:"entries"`
}

// Roster is the teacher's view of one lesson.
//
// Two things here exist specifically to remove the teacher's daily
// friction: is_new_to_class answers "who is new today", and the prefilled
// status comes from the leave record so the teacher never invents a
// financial decision of their own.
func (s *AttendanceService) Roster(db *gorm.DB, lessonID uint64) (*RosterView, error) {
	ls := &model.Lesson{}
	err := db.Raw(`SELECT l.*, c.name AS class_name, sub.name AS subject_name
		FROM lessons l
		JOIN classes c ON c.id = l.class_id
		LEFT JOIN subjects sub ON sub.id = c.subject_id
		WHERE l.id = ?`, lessonID).Scan(ls).Error
	if err != nil {
		return nil, err
	}
	if ls.ID == 0 {
		return nil, apierr.ErrNotFound
	}

	var raw []struct {
		StudentID       uint64  `json:"student_id"`
		StudentName     string  `json:"student_name"`
		Balance         int     `json:"balance"`
		CurrentStatus   *string `json:"current_status"`
		Source          string  `json:"source"`
		Note            *string `json:"note"`
		LeaveResolution string  `json:"leave_resolution"`
		IsNewToClass    bool    `json:"is_new_to_class"`
	}
	err = db.Raw(`
		SELECT s.id AS student_id,
		       s.full_name AS student_name,
		       COALESCE(b.balance,0) AS balance,
		       a.status AS current_status,
		       a.note AS note,
		       CASE WHEN a.id IS NULL THEN 'unrecorded' ELSE a.source END AS source,
		       lr.resolution AS leave_resolution,
		       NOT EXISTS (
		         SELECT 1 FROM attendances a2
		         JOIN lessons l2 ON l2.id = a2.lesson_id
		         WHERE a2.student_id = s.id AND l2.class_id = ? AND l2.lesson_date < ?
		       ) AS is_new_to_class
		FROM class_enrollments e
		JOIN students s ON s.id = e.student_id
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		LEFT JOIN attendances a ON a.lesson_id = ? AND a.student_id = s.id
		LEFT JOIN leave_requests lr ON lr.lesson_id = ? AND lr.student_id = s.id
		WHERE e.class_id = ? AND e.status = 'active'
		ORDER BY s.full_name`,
		ls.ClassID, ls.LessonDate, lessonID, lessonID, ls.ClassID).Scan(&raw).Error
	if err != nil {
		return nil, err
	}

	view := &RosterView{Lesson: *ls, Entries: []RosterEntry{}}
	for i := range raw {
		e := RosterEntry{
			StudentID:     raw[i].StudentID,
			StudentName:   raw[i].StudentName,
			IsNewToClass:  raw[i].IsNewToClass,
			CurrentStatus: raw[i].CurrentStatus,
			Source:        raw[i].Source,
			Balance:       raw[i].Balance,
			Note:          raw[i].Note,
		}
		// The leave record is the only source of a prefilled status, and it
		// is advisory: the roll call itself lives in current_status.
		switch raw[i].LeaveResolution {
		case "approved_ge_24h":
			v := string(model.AttLeaveApproved)
			e.PrefilledStatus = &v
		case "late_lt_24h":
			v := string(model.AttLeaveLate)
			e.PrefilledStatus = &v
		}
		if e.CurrentStatus == nil && e.PrefilledStatus != nil {
			e.Source = "prefilled"
		}
		view.Entries = append(view.Entries, e)
	}
	return view, nil
}
