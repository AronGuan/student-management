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
	var rows []model.Trial
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
	fu, err := h.Trials.SetOutcome(DB, h.Cfg, id, body.Outcome, body.Note)
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
	if err := h.Trials.CompleteFollowUp(DB, cu.ID, id, body.Note); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}
