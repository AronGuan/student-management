package service

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"

	"sms/internal/model"
)

// StudentDetail is the student drawer: the student row spread flat plus the
// related collections the drawer renders. Fetching these from the client as
// separate calls would be an N+1 on every drawer open.
//
// Every collection is initialised to an empty slice, never left nil, so the
// JSON is `[]` rather than `null` when there is nothing to show.
type StudentDetail struct {
	*model.Student
	Guardians []GuardianRow `json:"guardians"`
	// Enrollments is the student's FULL enrolment history, not just the
	// current classes: withdrawn rows are included and carry status plus
	// withdrawn_on. Active rows sort first. A caller that wants "classes
	// this student is in right now" must filter on status == "active" -
	// StudentListItem.active_class_count is the pre-filtered count if a
	// number is all that is needed.
	Enrollments  []EnrollmentRow        `json:"enrollments"`
	Packages     []model.CreditPackage  `json:"packages"`
	FollowUps    []FollowUpRow          `json:"follow_ups"`
	LatestAICard map[string]interface{} `json:"latest_ai_card"`
}

type GuardianRow struct {
	ID           uint64 `json:"id"`
	Name         string `json:"name"`
	Phone        string `json:"phone"`
	Email        string `json:"email"`
	Relationship string `json:"relationship"`
	IsPrimary    bool   `json:"is_primary"`
}

type EnrollmentRow struct {
	ID          uint64  `json:"id"`
	ClassID     uint64  `json:"class_id"`
	ClassName   string  `json:"class_name"`
	SubjectName string  `json:"subject_name"`
	TeacherName string  `json:"teacher_name"`
	Weekday     int     `json:"weekday"`
	StartMin    int     `json:"start_min"`
	EndMin      int     `json:"end_min"`
	Status      string  `json:"status"`
	EnrolledOn  string  `json:"enrolled_on"`
	WithdrawnOn *string `json:"withdrawn_on"`
}

type FollowUpRow struct {
	ID                uint64     `json:"id"`
	StudentID         uint64     `json:"student_id"`
	StudentName       string     `json:"student_name"`
	TrialID           *uint64    `json:"trial_id"`
	DueAt             time.Time  `json:"due_at"`
	Status            string     `json:"status"`
	CompletedAt       *time.Time `json:"completed_at"`
	CompletedByUserID *uint64    `json:"completed_by_user_id"`
	Note              string     `json:"note"`
}

func (s *StudentService) Detail(db *gorm.DB, id uint64) (*StudentDetail, error) {
	st, err := s.Get(db, id)
	if err != nil {
		return nil, err
	}
	d := &StudentDetail{
		Student:     st,
		Guardians:   []GuardianRow{},
		Enrollments: []EnrollmentRow{},
		Packages:    []model.CreditPackage{},
		FollowUps:   []FollowUpRow{},
	}

	if err := db.Raw(`SELECT id, name, phone, email, relationship, is_primary
		FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id ASC`, id).
		Scan(&d.Guardians).Error; err != nil {
		return nil, err
	}

	// Enrolments carry the class, subject and teacher names so the drawer
	// does not need a second round trip per row. The weekly slot is read
	// from classes, not from the enrolment snapshot: class_enrollments has
	// only weekday and start_min, and the class is the schedule of record.
	//
	// No status filter on purpose. Withdrawn rows are history the drawer
	// shows, and ORDER BY e.status ASC puts the live ones first, so the
	// sequence reads as "current, then past". Filtering here instead would
	// silently delete the history this collection exists to expose.
	var enr []struct {
		ID          uint64     `json:"id"`
		ClassID     uint64     `json:"class_id"`
		ClassName   string     `json:"class_name"`
		SubjectName string     `json:"subject_name"`
		TeacherName string     `json:"teacher_name"`
		Weekday     int        `json:"weekday"`
		StartMin    int        `json:"start_min"`
		EndMin      int        `json:"end_min"`
		Status      string     `json:"status"`
		EnrolledOn  time.Time  `json:"enrolled_on"`
		WithdrawnOn *time.Time `json:"withdrawn_on"`
	}
	if err := db.Raw(`SELECT e.id, e.class_id, c.name AS class_name, sub.name AS subject_name,
			u.display_name AS teacher_name, c.weekday, c.start_min, c.end_min, e.status,
			e.enrolled_on, e.withdrawn_on
		FROM class_enrollments e
		JOIN classes c ON c.id = e.class_id
		LEFT JOIN subjects sub ON sub.id = c.subject_id
		LEFT JOIN users u ON u.id = c.teacher_id
		WHERE e.student_id = ?
		ORDER BY e.status ASC, c.name ASC`, id).Scan(&enr).Error; err != nil {
		return nil, err
	}
	for _, e := range enr {
		row := EnrollmentRow{
			ID: e.ID, ClassID: e.ClassID, ClassName: e.ClassName, SubjectName: e.SubjectName,
			TeacherName: e.TeacherName, Weekday: e.Weekday, StartMin: e.StartMin, EndMin: e.EndMin,
			Status: e.Status, EnrolledOn: e.EnrolledOn.Format("2006-01-02"),
		}
		if e.WithdrawnOn != nil {
			w := e.WithdrawnOn.Format("2006-01-02")
			row.WithdrawnOn = &w
		}
		d.Enrollments = append(d.Enrollments, row)
	}

	if err := db.Raw(`SELECT * FROM credit_packages WHERE student_id = ?
		ORDER BY purchased_at DESC, id DESC`, id).Scan(&d.Packages).Error; err != nil {
		return nil, err
	}

	if err := db.Raw(`SELECT fu.id, fu.student_id, s.full_name AS student_name, fu.trial_id,
			fu.due_at, fu.status, fu.completed_at, fu.completed_by_user_id, fu.note
		FROM follow_ups fu
		JOIN students s ON s.id = fu.student_id
		WHERE fu.student_id = ?
		ORDER BY fu.created_at DESC, fu.id DESC`, id).Scan(&d.FollowUps).Error; err != nil {
		return nil, err
	}

	card, err := s.LatestAICard(db, id)
	if err != nil {
		return nil, err
	}
	d.LatestAICard = card
	return d, nil
}

// AICardItem is one persisted decision card. output_json is parsed into
// data so a caller receives a card object rather than a JSON string.
type AICardItem struct {
	ID        uint64                 `json:"id"`
	StudentID uint64                 `json:"student_id"`
	Kind      string                 `json:"kind"`
	Model     string                 `json:"model,omitempty"`
	AIStatus  string                 `json:"ai_status"`
	CreatedAt time.Time              `json:"created_at"`
	Data      map[string]interface{} `json:"data"`
}

// AICards is the read-back path for decision cards, newest first. It lets
// the UI re-open a card that was already generated instead of paying for
// another model call.
func (s *StudentService) AICards(db *gorm.DB, studentID uint64, kind string, limit int) ([]AICardItem, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, student_id, kind, model, ai_status, output_json, created_at
		FROM ai_decisions WHERE student_id = ?`
	args := []interface{}{studentID}
	if kind != "" {
		q += " AND kind = ?"
		args = append(args, kind)
	}
	q += " ORDER BY created_at DESC, id DESC LIMIT ?"
	args = append(args, limit)

	var recs []model.AIDecision
	if err := db.Raw(q, args...).Scan(&recs).Error; err != nil {
		return nil, err
	}

	items := []AICardItem{}
	for i := range recs {
		data := map[string]interface{}{}
		if recs[i].OutputJSON != "" {
			_ = json.Unmarshal([]byte(recs[i].OutputJSON), &data)
		}
		// Rows written before the identity fields were kept out of the blob
		// still carry them as zeros. Strip them here too, so data never
		// contradicts the identity fields on the item itself.
		for _, k := range aiCardIdentityKeys {
			delete(data, k)
		}
		items = append(items, AICardItem{
			ID:        recs[i].ID,
			StudentID: recs[i].StudentID,
			Kind:      recs[i].Kind,
			Model:     recs[i].Model,
			AIStatus:  recs[i].AIStatus,
			CreatedAt: recs[i].CreatedAt,
			Data:      data,
		})
	}
	return items, nil
}

// LatestAICard returns the newest decision card for a student as one flat
// object: the stored card with the identity columns merged in. It is the
// drawer's single-card view; AICards is the list view.
func (s *StudentService) LatestAICard(db *gorm.DB, studentID uint64) (map[string]interface{}, error) {
	items, err := s.AICards(db, studentID, "", 1)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	it := items[0]
	card := it.Data
	if card == nil {
		card = map[string]interface{}{}
	}
	card["id"] = it.ID
	card["student_id"] = it.StudentID
	card["kind"] = it.Kind
	card["ai_status"] = it.AIStatus
	card["created_at"] = it.CreatedAt
	if it.Model != "" {
		card["model"] = it.Model
	}
	return card, nil
}
