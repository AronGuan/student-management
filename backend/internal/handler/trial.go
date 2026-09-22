package handler

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
	"sms/internal/service"
)

type TrialHandler struct {
	Cfg    *config.Config
	Trials *service.TrialService
}

func (h *TrialHandler) List(c *gin.Context) {
	// Initialised, not declared nil: with the ownership scoping below an
	// empty result is now a normal event (a consultant with no trials of
	// their own), and a nil slice would serialise as `data: null` instead
	// of `data: []`. Same reason service/trial.go does this for
	// follow-ups; the project rule is that a list endpoint never emits null.
	rows := []model.Trial{}
	q := `SELECT t.*, s.full_name AS student_name, sub.name AS subject_name, u.display_name AS teacher_name
		FROM trials t
		JOIN students s ON s.id = t.student_id
		LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id
		WHERE 1=1`
	args := []interface{}{}
	if v := c.Query("student_id"); v != "" {
		q += " AND t.student_id = ?"
		args = append(args, v)
	}
	if v := c.Query("outcome"); v != "" {
		q += " AND t.outcome = ?"
		args = append(args, v)
	}
	// /trials is a consultant's personal work queue, not the student
	// directory, so it is scoped by role exactly as GET /follow-ups further
	// down this file is: an admin sees the trials of the students they own,
	// a teacher sees the trials they are assigned to run. Leaving it
	// unscoped was a real defect - a consultant's board filled with
	// colleagues' trials - and the page worked around it by reading
	// /dashboard/admin instead, while LeadsPage kept calling this route.
	//
	// This does not contradict R7, which is about the student *directory*
	// ("admin may read every student, may only write the ones they own").
	// Reading every student stays available through GET /students, which is
	// deliberately still unscoped and marks each row with can_write. A queue
	// answers a different question - what is on my desk today - and
	// answering it with the whole company's list is not a privilege, it is
	// noise.
	cu := middleware.Current(c)
	if cu != nil {
		switch cu.Role {
		case model.RoleAdmin:
			q += " AND s.owner_admin_id = ?"
			args = append(args, cu.ID)
		case model.RoleTeacher:
			q += " AND t.teacher_id = ?"
			args = append(args, cu.ID)
		}
	}
	q += " ORDER BY t.scheduled_at DESC LIMIT 100"
	if err := DB.Raw(q, args...).Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, rows)
}

func (h *TrialHandler) Create(c *gin.Context) {
	var t model.Trial
	if err := c.ShouldBindJSON(&t); err != nil {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	// R7: booking a trial is a write, so it is owner-restricted.
	if err := (&service.StudentService{}).AssertOwner(DB, cu.ID, cu.Role, t.StudentID); err != nil {
		Fail(c, err)
		return
	}
	if err := h.Trials.CreateTrial(DB, &t); err != nil {
		Fail(c, err)
		return
	}
	Created(c, t)
}

// SetOutcome is R2: recording the result is what starts the 48h clock.
// It is also a write, so the caller is passed down for the R7 check.
func (h *TrialHandler) SetOutcome(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	var body struct {
		Outcome string `json:"outcome"`
		Note    string `json:"note"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	fu, err := h.Trials.SetOutcome(DB, h.Cfg, id, body.Outcome, body.Note, cu.ID, cu.Role)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, fu)
}

func (h *TrialHandler) ListFollowUps(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	f := service.FollowUpFilter{
		Status: c.Query("status"),
		Page:   page,
		Limit:  limit,
	}
	cu := middleware.Current(c)
	if cu.Role == model.RoleAdmin {
		f.OwnerAdminID = &cu.ID
	}
	rows, total, err := h.Trials.ListFollowUps(DB, f)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, Page{Items: rows, Total: total, Page: page, Limit: limit, HasMore: int64(page*limit) < total})
}

func (h *TrialHandler) CompleteFollowUp(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	_ = c.ShouldBindJSON(&body)
	cu := middleware.Current(c)
	if err := h.Trials.CompleteFollowUp(DB, cu.ID, cu.Role, id, body.Note); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}
