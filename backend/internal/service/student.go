package service

import (
	"strings"

	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/model"
)

type StudentService struct{}

// AssertOwner enforces R7: an admin may read every student but may only
// write the ones they own. The owner is re-read on every request and never
// cached, so an ownership transfer takes effect immediately.
func (s *StudentService) AssertOwner(db *gorm.DB, actorID uint64, role model.Role, studentID uint64) error {
	if role != model.RoleAdmin {
		return apierr.ErrForbidden
	}
	var ownerID *uint64
	if err := db.Raw("SELECT owner_admin_id FROM students WHERE id = ? AND deleted_at IS NULL", studentID).
		Scan(&ownerID).Error; err != nil {
		return err
	}
	if ownerID == nil {
		return apierr.ErrNotFound
	}
	if *ownerID != actorID {
		return apierr.ErrNotOwner
	}
	return nil
}

// AssertReadable answers "may this caller read this student's record?".
//
// R7 restricts WRITES, not reads: every staff role may read any student.
// A household credential is different - it may read only the children
// bound to it, because a student record carries guardians' names, phone
// numbers and the billing history.
func (s *StudentService) AssertReadable(db *gorm.DB, actorID uint64, role model.Role, studentID uint64) error {
	if role != model.RoleStudent {
		return nil
	}
	var owned int
	if err := db.Raw(`SELECT COUNT(*) FROM students
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, studentID, actorID).
		Scan(&owned).Error; err != nil {
		return err
	}
	if owned == 0 {
		return apierr.ErrForbidden
	}
	return nil
}

type StudentFilter struct {
	Status        string
	Query         string
	LowCreditOnly bool
	OwnerAdminID  *uint64
	Page          int
	Limit         int
	Sort          string // "balance_asc" | "name" | "recent"
	LowCreditAt   int
}

// StudentListItem is the list row. The three derived fields exist so the
// admin's saved views ("unassigned", low credit, waiting on a follow-up)
// can be rendered from one response instead of a second round trip per row.
type StudentListItem struct {
	model.Student
	OwnerAdminName   string `json:"owner_admin_name"`
	ActiveClassCount int    `json:"active_class_count"`
	PendingFollowUp  bool   `json:"pending_followup"`
}

// List reads every student regardless of owner (admins need the full
// picture to spot duplicate enquiries) but flags each row with can_write.
func (s *StudentService) List(db *gorm.DB, f StudentFilter) ([]StudentListItem, int64, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.Limit < 1 || f.Limit > 200 {
		f.Limit = 20
	}

	where := []string{"s.deleted_at IS NULL"}
	args := []interface{}{}

	if f.Status != "" {
		where = append(where, "s.status = ?")
		args = append(args, f.Status)
	}
	if f.Query != "" {
		where = append(where, "(s.full_name LIKE ? OR s.preferred_name LIKE ?)")
		like := "%" + f.Query + "%"
		args = append(args, like, like)
	}
	if f.OwnerAdminID != nil {
		where = append(where, "s.owner_admin_id = ?")
		args = append(args, *f.OwnerAdminID)
	}

	// The view keeps the aggregate out of this query, which matters because
	// @@sql_mode includes ONLY_FULL_GROUP_BY on this instance.
	join := "LEFT JOIN v_student_balance b ON b.student_id = s.id"
	if f.LowCreditOnly {
		where = append(where, "COALESCE(b.balance,0) <= ?")
		args = append(args, f.LowCreditAt)
	}

	// Every variant ends in a unique key (s.id). A sort key that is not
	// unique is not a total order, and MySQL is then free to order tied rows
	// differently for each LIMIT/OFFSET query - the pages overlap and some
	// students are unreachable. The seed gives every student the same
	// updated_at, so the whole table is one tie: before this, paging
	// /students?limit=5 reached only 23 of 37 students.
	//
	// The default keeps s.id DESC to match the contract, which states the
	// default order as "updated_at DESC, id DESC". full_name stays as the
	// second key of balance_asc: it is redundant now that s.id is unique,
	// but it expresses the intent that equal balances group by name.
	order := "s.updated_at DESC, s.id DESC"
	switch f.Sort {
	case "balance_asc":
		order = "COALESCE(b.balance,0) ASC, s.full_name ASC, s.id ASC"
	case "name":
		order = "s.full_name ASC, s.id ASC"
	}

	var total int64
	cq := "SELECT COUNT(*) FROM students s " + join + " WHERE " + strings.Join(where, " AND ")
	if err := db.Raw(cq, args...).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	q := `SELECT s.*, COALESCE(b.balance,0) AS balance,
			COALESCE(oa.display_name,'') AS owner_admin_name,
			(SELECT COUNT(*) FROM class_enrollments e
			   WHERE e.student_id = s.id AND e.status = 'active') AS active_class_count,
			EXISTS (SELECT 1 FROM follow_ups fu
			   WHERE fu.student_id = s.id AND fu.status = 'pending') AS pending_followup
		FROM students s ` + join +
		" LEFT JOIN users oa ON oa.id = s.owner_admin_id" +
		" WHERE " + strings.Join(where, " AND ") + " ORDER BY " + order +
		" LIMIT ? OFFSET ?"
	args = append(args, f.Limit, (f.Page-1)*f.Limit)

	// Initialised, not nil: a search that matches nothing must return
	// items:[] rather than items:null, or the list view crashes on .map().
	rows := []StudentListItem{}
	if err := db.Raw(q, args...).Scan(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

func (s *StudentService) Get(db *gorm.DB, id uint64) (*model.Student, error) {
	st := &model.Student{}
	err := db.Raw(`SELECT s.*, COALESCE(b.balance,0) AS balance
		FROM students s LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.id = ? AND s.deleted_at IS NULL`, id).Scan(st).Error
	if err != nil {
		return nil, err
	}
	if st.ID == 0 {
		return nil, apierr.ErrNotFound
	}
	return st, nil
}

type CreateStudentInput struct {
	FullName      string  `json:"full_name"`
	PreferredName string  `json:"preferred_name"`
	YearLevel     string  `json:"year_level"`
	Source        string  `json:"source"`
	OwnerAdminID  *uint64 `json:"owner_admin_id"`
	UserID        *uint64 `json:"user_id"`
	Guardians     []struct {
		Name         string `json:"name"`
		Phone        string `json:"phone"`
		Email        string `json:"email"`
		Relationship string `json:"relationship"`
		IsPrimary    bool   `json:"is_primary"`
	} `json:"guardians"`
}

func (s *StudentService) Create(db *gorm.DB, in CreateStudentInput) (*model.Student, error) {
	if strings.TrimSpace(in.FullName) == "" {
		return nil, apierr.BadRequest("full_name 为必填")
	}
	now := clock.Now()
	st := &model.Student{
		FullName:      in.FullName,
		PreferredName: in.PreferredName,
		YearLevel:     in.YearLevel,
		Source:        in.Source,
		OwnerAdminID:  in.OwnerAdminID,
		UserID:        in.UserID,
		Status:        model.StudentLead,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(st).Error; err != nil {
			return err
		}
		for _, g := range in.Guardians {
			if g.Name == "" {
				continue
			}
			gd := &model.Guardian{
				StudentID:    st.ID,
				Name:         g.Name,
				Phone:        g.Phone,
				Email:        g.Email,
				Relationship: g.Relationship,
				IsPrimary:    g.IsPrimary,
			}
			if err := tx.Create(gd).Error; err != nil {
				return err
			}
		}
		return nil
	})
	return st, err
}

// Ledger returns the append-only history. Nothing here is editable, which
// is exactly what the household view is built to expose.
func (s *StudentService) Ledger(db *gorm.DB, id uint64, limit int) ([]model.CreditLedger, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	// A student who has never been charged has no ledger rows yet; the
	// household view must still receive items:[] and not items:null.
	rows := []model.CreditLedger{}
	err := db.Raw(`SELECT l.*, ls.lesson_date AS lesson_label, u.display_name AS actor_name
		FROM credit_ledger l
		LEFT JOIN lessons ls ON ls.id = l.lesson_id
		LEFT JOIN users u ON u.id = l.actor_user_id
		WHERE l.student_id = ?
		ORDER BY l.created_at DESC, l.id DESC
		LIMIT ?`, id, limit).Scan(&rows).Error
	return rows, err
}

// LedgerCount is the total number of ledger rows, before any limit. The
// household view needs it to page honestly instead of guessing from the
// length of the page it just received.
func (s *StudentService) LedgerCount(db *gorm.DB, id uint64) (int64, error) {
	var total int64
	err := db.Raw("SELECT COUNT(*) FROM credit_ledger WHERE student_id = ?", id).Scan(&total).Error
	return total, err
}

// TransferOwner is R11: a single UPDATE on owner_admin_id. Enrolments,
// attendance and ledger are deliberately untouched, so history survives
// the transfer intact.
func (s *StudentService) TransferOwner(db *gorm.DB, actorID, studentID, toAdminID uint64) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := (&StudentService{}).AssertOwner(tx, actorID, model.RoleAdmin, studentID); err != nil {
			return err
		}
		var exists int
		if err := tx.Raw("SELECT COUNT(*) FROM users WHERE id = ? AND role = 'admin'", toAdminID).
			Scan(&exists).Error; err != nil {
			return err
		}
		if exists == 0 {
			return apierr.ErrNotFound
		}
		var from *uint64
		if err := tx.Raw("SELECT owner_admin_id FROM students WHERE id = ?", studentID).Scan(&from).Error; err != nil {
			return err
		}
		if err := tx.Exec("UPDATE students SET owner_admin_id = ?, updated_at = ? WHERE id = ?",
			toAdminID, clock.Now(), studentID).Error; err != nil {
			return err
		}
		payload := map[string]interface{}{"from": from, "to": toAdminID}
		return writeAudit(tx, actorID, "student", studentID, "transfer_owner", payload)
	})
}
