package handler

import (
	"github.com/gin-gonic/gin"

	"sms/internal/apierr"
	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/service"
)

type AIHandler struct {
	Cfg *config.Config
	AI  *service.AIService
	Stu *service.StudentService
}

// Conversion produces the trial decision card. A failed model call is not
// an error response: it returns HTTP 200 with ai_status set, and the card
// is filled in by deterministic rules instead.
//
// The path parameter is a STUDENT id, not a trial id: the card is about a
// student's trial history, and the route names the parameter accordingly
// so the value cannot be misread at the call site.
func (h *AIHandler) Conversion(c *gin.Context) {
	id, ok := parseID(c, "student_id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	card, err := h.AI.Conversion(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, card)
}

func (h *AIHandler) Renewal(c *gin.Context) {
	id, ok := parseID(c, "student_id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	card, err := h.AI.Renewal(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, card)
}

// Cards is the read-back path for a student's decision cards, newest
// first. It lets the UI re-open a card that was already generated without
// paying for another model call.
//
// Staff only, and gated on the route rather than in here. A card is an
// internal commercial judgement about a family - churn_risk, an adviser's
// recommended action, and an evidence list that quotes the teacher's own
// staffroom remarks. GET /students/:id already withholds latest_ai_card from a
// household credential for that reason, and this endpoint would hand the same
// object over verbatim, so a read-scope rule alone would leave the boundary
// open through the second door. The spend routes (/ai/renewal-risk,
// /ai/trial-conversion) are admin-only for the same reason; the read-back
// keeps teachers, who are staff and see no less elsewhere.
func (h *AIHandler) Cards(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	cu := middleware.Current(c)
	if cu == nil {
		Fail(c, apierr.ErrUnauthorized)
		return
	}
	if err := h.Stu.AssertReadable(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	items, err := h.Stu.AICards(DB, id, c.Query("kind"), atoiOr(c.DefaultQuery("limit", "50"), 50))
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"items": items})
}

// Config lets the front end read the thresholds instead of hard-coding
// 48 / 24 / 4 a second time. These are business assumptions with no
// external source of truth, so a single source matters more than usual.
func (h *AIHandler) Config(c *gin.Context) {
	OK(c, h.Cfg.Thresholds)
}
