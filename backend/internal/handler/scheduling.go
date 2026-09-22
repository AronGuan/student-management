package handler

import (
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"sms/internal/apierr"
	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
	"sms/internal/service"
)

type SchedulingHandler struct {
	Cfg   *config.Config
	Sched *service.SchedulingService
	Att   *service.AttendanceService
}

// ListClasses feeds the class list and the enrolment picker.
//
// The statement is assembled in clause order: every predicate is collected
// into `where` first and ORDER BY is appended once, last. Appending "AND ..."
// to a string that already ends in ORDER BY is syntactically valid but
// silently wrong - MySQL parses the fragment as an ORDER BY *expression*
// (`ORDER BY c.weekday, (c.start_min AND (c.teacher_id = ?))`), so the
// predicate never reaches the WHERE clause and the caller gets every row
// back with no error. That is why `?teacher_id=999999` used to return the
// whole centre instead of nothing.
func (h *SchedulingHandler) ListClasses(c *gin.Context) {
	where := []string{"c.status = 'active'"}
	args := []interface{}{}

	if v, ok, bad := queryUint(c, "teacher_id"); bad {
		return
	} else if ok {
		where = append(where, "c.teacher_id = ?")
		args = append(args, v)
	}
	if v, ok, bad := queryUint(c, "weekday"); bad {
		return
	} else if ok {
		where = append(where, "c.weekday = ?")
		args = append(args, v)
	}

	// Same data-scope rule as /lessons: a household credential sees only
	// the classes one of its own children is actively enrolled in. Applied
	// in the query, never left for the client to narrow.
	if cu := middleware.Current(c); cu != nil && cu.Role == model.RoleStudent {
		where = append(where, `EXISTS (
			SELECT 1 FROM class_enrollments e
			JOIN students st ON st.id = e.student_id
			WHERE e.class_id = c.id AND e.status = 'active' AND st.user_id = ?)`)
		args = append(args, cu.ID)
	}

	q := `SELECT c.*, s.name AS subject_name, u.display_name AS teacher_name,
		(SELECT COUNT(*) FROM class_enrollments e WHERE e.class_id = c.id AND e.status='active') AS enrolled
		FROM classes c
		LEFT JOIN subjects s ON s.id = c.subject_id
		LEFT JOIN users u ON u.id = c.teacher_id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY c.weekday, c.start_min`

	// Initialised, not nil: an empty result must serialise as [] so the
	// client never has to guard for null on a list it asked for.
	rows := []model.Class{}
	if err := DB.Raw(q, args...).Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

type subjectRow struct {
	ID   uint64 `json:"id"`
	Name string `json:"name"`
}

// ListSubjects feeds the class-creation subject picker. Rows are ordered by
// name so the picker is stable between requests. Note: the subjects table
// carries no lifecycle flag, so "active" here means "not archived" only in
// the sense that there is nothing to archive - every row is returned.
func (h *SchedulingHandler) ListSubjects(c *gin.Context) {
	rows := []subjectRow{}
	if err := DB.Raw("SELECT id, name FROM subjects ORDER BY name").Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

type teacherRow struct {
	ID          uint64 `json:"id"`
	DisplayName string `json:"display_name"`
	Username    string `json:"username"`
}

// ListTeachers feeds the class-creation teacher picker. Disabled accounts
// are excluded: they cannot be assigned new classes.
func (h *SchedulingHandler) ListTeachers(c *gin.Context) {
	rows := []teacherRow{}
	err := DB.Raw(`SELECT id, display_name, username FROM users
		WHERE role = 'teacher' AND status = 'active'
		ORDER BY display_name`).Scan(&rows).Error
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

func (h *SchedulingHandler) CreateClass(c *gin.Context) {
	var cls model.Class
	if err := c.ShouldBindJSON(&cls); err != nil {
		Fail(c, errBadBody)
		return
	}
	if err := h.Sched.CreateClass(DB, &cls); err != nil {
		Fail(c, err)
		return
	}
	Created(c, cls)
}

// enrollmentRow is the roster projection: enough for the UI to render a
// face, a name and a warning badge without a second request per student.
type enrollmentRow struct {
	StudentID uint64 `json:"student_id"`
	FullName  string `json:"full_name"`
	Balance   int    `json:"balance"`
	Status    string `json:"status"`
}

// Enrollments lists who is in a class. Staff see the whole roster; a
// household credential is narrowed to its own children, so the endpoint
// cannot be used to enumerate another family's students or their balances.
func (h *SchedulingHandler) Enrollments(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	where := []string{"e.class_id = ?", "e.status = 'active'"}
	args := []interface{}{id}
	if cu := middleware.Current(c); cu != nil && cu.Role == model.RoleStudent {
		where = append(where, "s.user_id = ?")
		args = append(args, cu.ID)
	}
	var rows []enrollmentRow
	rows = []enrollmentRow{}
	err := DB.Raw(`SELECT s.id AS student_id, s.full_name, COALESCE(b.balance,0) AS balance, e.status
		FROM class_enrollments e
		JOIN students s ON s.id = e.student_id
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY s.full_name`, args...).Scan(&rows).Error
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

func (h *SchedulingHandler) Enroll(c *gin.Context) {
	classID, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	var body struct {
		StudentID uint64 `json:"student_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.StudentID == 0 {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	// R7 layered on top of R3: you may only enrol a student you own.
	if err := (&service.StudentService{}).AssertOwner(DB, cu.ID, cu.Role, body.StudentID); err != nil {
		Fail(c, err)
		return
	}
	if err := h.Sched.Enroll(DB, cu.ID, classID, body.StudentID); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}

func (h *SchedulingHandler) Withdraw(c *gin.Context) {
	classID, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	studentID, ok := parseID(c, "student_id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	cu := middleware.Current(c)
	if err := (&service.StudentService{}).AssertOwner(DB, cu.ID, cu.Role, studentID); err != nil {
		Fail(c, err)
		return
	}
	if err := h.Sched.Withdraw(DB, cu.ID, classID, studentID); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}

func (h *SchedulingHandler) ListLessons(c *gin.Context) {
	rows := []model.Lesson{}
	q := `SELECT l.*, c.name AS class_name, s.name AS subject_name
		FROM lessons l
		JOIN classes c ON c.id = l.class_id
		LEFT JOIN subjects s ON s.id = c.subject_id
		WHERE 1=1`
	args := []interface{}{}
	if v := c.Query("date"); v != "" {
		q += " AND l.lesson_date = ?"
		args = append(args, v)
	}
	if v := c.Query("from"); v != "" {
		q += " AND l.lesson_date >= ?"
		args = append(args, v)
	}
	if v := c.Query("to"); v != "" {
		q += " AND l.lesson_date <= ?"
		args = append(args, v)
	}
	if v, ok, bad := queryUint(c, "teacher_id"); bad {
		return
	} else if ok {
		q += " AND l.teacher_id = ?"
		args = append(args, v)
	}
	if v, ok, bad := queryUint(c, "class_id"); bad {
		return
	} else if ok {
		q += " AND l.class_id = ?"
		args = append(args, v)
	}
	// A household account may only ever see lessons of classes its own
	// children are actively enrolled in. This is a data-scope rule, so it
	// is applied here in the query and never left to the client to filter.
	if cu := middleware.Current(c); cu != nil && cu.Role == model.RoleStudent {
		q += ` AND EXISTS (
			SELECT 1 FROM class_enrollments e
			JOIN students st ON st.id = e.student_id
			WHERE e.class_id = l.class_id AND e.status = 'active' AND st.user_id = ?)`
		args = append(args, cu.ID)
	}
	q += " ORDER BY l.lesson_date, l.start_min LIMIT 200"
	if err := DB.Raw(q, args...).Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

func (h *SchedulingHandler) GenerateLessons(c *gin.Context) {
	var body struct {
		FromDate string `json:"from_date"`
		ToDate   string `json:"to_date"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.FromDate == "" || body.ToDate == "" {
		Fail(c, errBadBody)
		return
	}
	n, err := h.Sched.GenerateLessons(DB, body.FromDate, body.ToDate)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"created": n})
}

// CancelRange is R10 - a teacher away for a week. Cancelling the dated
// lesson rows means no attendance is generated and no credit is consumed.
func (h *SchedulingHandler) CancelRange(c *gin.Context) {
	var body struct {
		TeacherID uint64 `json:"teacher_id"`
		FromDate  string `json:"from_date"`
		ToDate    string `json:"to_date"`
		Reason    string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.FromDate == "" || body.ToDate == "" {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	tid := body.TeacherID
	if cu.Role == model.RoleTeacher {
		// A teacher may only cancel their own lessons.
		tid = cu.ID
	}
	n, err := h.Sched.CancelRange(DB, cu.ID, tid, body.FromDate, body.ToDate, body.Reason)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"cancelled": n})
}

// assertLessonOwner keeps a teacher inside their own lessons.
func (h *SchedulingHandler) assertLessonOwner(c *gin.Context, lessonID uint64) error {
	cu := middleware.Current(c)
	if cu.Role != model.RoleTeacher {
		return nil
	}
	var owner uint64
	if err := DB.Raw("SELECT teacher_id FROM lessons WHERE id = ?", lessonID).Scan(&owner).Error; err != nil {
		return err
	}
	if owner == 0 {
		return apierr.ErrNotFound
	}
	if owner != cu.ID {
		return apierr.ErrForbidden
	}
	return nil
}

func (h *SchedulingHandler) Roster(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	if err := h.assertLessonOwner(c, id); err != nil {
		Fail(c, err)
		return
	}
	view, err := h.Att.Roster(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, view)
}

func (h *SchedulingHandler) Settle(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	if err := h.assertLessonOwner(c, id); err != nil {
		Fail(c, err)
		return
	}
	var body struct {
		Marks []service.Mark `json:"marks"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Marks) == 0 {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	charged, err := h.Att.Settle(DB, h.Cfg, cu.ID, id, body.Marks)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"charged": charged})
}

func (h *SchedulingHandler) Override(c *gin.Context) {
	lessonID, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	studentID, ok := parseID(c, "student_id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	if err := h.assertLessonOwner(c, lessonID); err != nil {
		Fail(c, err)
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	if err := h.Att.Override(DB, cu.ID, lessonID, studentID, model.AttendanceStatus(body.Status)); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}

func (h *SchedulingHandler) RequestLeave(c *gin.Context) {
	cu := middleware.Current(c)
	var body struct {
		LessonID  uint64 `json:"lesson_id"`
		StudentID uint64 `json:"student_id"`
		Reason    string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.LessonID == 0 || body.StudentID == 0 {
		Fail(c, errBadBody)
		return
	}
	// A household may only act for the children on its own credential.
	if cu.Role == model.RoleStudent {
		var owned int
		if err := DB.Raw("SELECT COUNT(*) FROM students WHERE id = ? AND user_id = ?",
			body.StudentID, cu.ID).Scan(&owned).Error; err != nil {
			Fail(c, err)
			return
		}
		if owned == 0 {
			Fail(c, apierr.ErrForbidden)
			return
		}
	}
	req, err := h.Att.RequestLeave(DB, h.Cfg, cu.ID, body.StudentID, body.LessonID, body.Reason)
	if err != nil {
		Fail(c, err)
		return
	}
	Created(c, req)
}

// ListLeave is scoped in the query by the caller's role, never by the
// client. Without this every authenticated caller - including a household
// login - received every family's leave requests, which is exactly the
// kind of rule the API is expected to enforce server-side.
//
//	admin   -> leave for students on their own caseload
//	teacher -> leave for lessons they teach
//	student -> leave for the children on their own credential
func (h *SchedulingHandler) ListLeave(c *gin.Context) {
	cu := middleware.Current(c)
	scope := ""
	switch {
	case cu == nil:
		Fail(c, apierr.ErrForbidden)
		return
	case cu.Role == model.RoleAdmin:
		scope = "s.owner_admin_id = ?"
	case cu.Role == model.RoleTeacher:
		scope = "l.teacher_id = ?"
	case cu.Role == model.RoleStudent:
		scope = "s.user_id = ?"
	default:
		Fail(c, apierr.ErrForbidden)
		return
	}

	q := `SELECT lr.* FROM leave_requests lr
		JOIN lessons l ON l.id = lr.lesson_id
		JOIN students s ON s.id = lr.student_id
		WHERE ` + scope
	args := []interface{}{cu.ID}
	if v, ok, bad := queryUint(c, "student_id"); bad {
		return
	} else if ok {
		q += " AND lr.student_id = ?"
		args = append(args, v)
	}
	if v, ok, bad := queryUint(c, "lesson_id"); bad {
		return
	} else if ok {
		q += " AND lr.lesson_id = ?"
		args = append(args, v)
	}
	q += " ORDER BY lr.created_at DESC LIMIT 100"

	// An array, never null: now that a caller legitimately sees an empty
	// list, the client must not have to guard for null on every read.
	rows := []model.LeaveRequest{}
	if err := DB.Raw(q, args...).Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

func atoiOr(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}
