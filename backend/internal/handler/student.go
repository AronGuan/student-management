package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
	"sms/internal/service"
)

type StudentHandler struct {
	Cfg      *config.Config
	Students *service.StudentService
	// Named "Credit" not "Credits": the handler method Credits() already
	// owns that identifier and Go has one namespace for fields and methods.
	Credit *service.CreditService
}

func parseID(c *gin.Context, key string) (uint64, bool) {
	raw := c.Param(key)
	if raw == "" {
		return 0, false
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || v == 0 {
		return 0, false
	}
	return v, true
}

func (h *StudentHandler) List(c *gin.Context) {
	cu := middleware.Current(c)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	f := service.StudentFilter{
		Status:        c.Query("status"),
		Query:         c.Query("q"),
		LowCreditOnly: c.Query("low_credit") == "1" || c.Query("low_credit") == "true",
		Page:          page,
		Limit:         limit,
		Sort:          c.Query("sort"),
		LowCreditAt:   h.Cfg.Thresholds.LowCreditThreshold,
	}
	// A scoping filter that silently disappears is worse than an error: the
	// caller believes the result is scoped to them and it is not. So an
	// unparseable owner_admin_id is rejected rather than dropped.
	if v := c.Query("owner_admin_id"); v != "" {
		if v == "me" {
			if cu == nil {
				Fail(c, apierr.ErrUnauthorized)
				return
			}
			id := cu.ID
			f.OwnerAdminID = &id
		} else if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			f.OwnerAdminID = &n
		} else {
			FailWith(c, http.StatusBadRequest, apierr.CodeBadRequest, "owner_admin_id 必须是数字或 me")
			return
		}
	}

	rows, total, err := h.Students.List(DB, f)
	if err != nil {
		Fail(c, err)
		return
	}
	for i := range rows {
		rows[i].CanWrite = cu != nil && cu.Role == model.RoleAdmin &&
			rows[i].OwnerAdminID != nil && *rows[i].OwnerAdminID == cu.ID
	}
	OK(c, Page{Items: rows, Total: total, Page: page, Limit: limit,
		HasMore: int64(page*limit) < total})
}

func (h *StudentHandler) Create(c *gin.Context) {
	var in service.CreateStudentInput
	if err := c.ShouldBindJSON(&in); err != nil {
		Fail(c, err)
		return
	}
	cu := middleware.Current(c)
	if in.OwnerAdminID == nil && cu != nil && cu.Role == model.RoleAdmin {
		id := cu.ID
		in.OwnerAdminID = &id
	}
	st, err := h.Students.Create(DB, in)
	if err != nil {
		Fail(c, err)
		return
	}
	Created(c, st)
}

// Get returns the full student record. Reads are open to every staff role
// (R7 restricts writes, not reads) but a household credential is held to
// its own children: the record carries guardians' contact details and the
// billing history, so another family's profile is not readable at all.
func (h *StudentHandler) Get(c *gin.Context) {
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
	if err := h.Students.AssertReadable(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	detail, err := h.Students.Detail(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	detail.CanWrite = cu.Role == model.RoleAdmin &&
		detail.OwnerAdminID != nil && *detail.OwnerAdminID == cu.ID
	OK(c, detail)
}

func (h *StudentHandler) Patch(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	cu := middleware.Current(c)
	// R7: reading is open to every admin, writing is not.
	if err := h.Students.AssertOwner(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, err)
		return
	}
	allowed := map[string]bool{"full_name": true, "preferred_name": true, "year_level": true, "source": true, "status": true}
	sets := []string{}
	args := []interface{}{}
	for k, v := range body {
		if !allowed[k] {
			continue
		}
		sets = append(sets, k+" = ?")
		args = append(args, v)
	}
	if len(sets) == 0 {
		Fail(c, errNoFields)
		return
	}
	// updated_at is business time, so it comes from Go as a parameter,
	// never from SQL NOW(). See ADR-007.
	sets = append(sets, "updated_at = ?")
	args = append(args, clock.Now(), id)
	if err := DB.Exec("UPDATE students SET "+joinSets(sets)+" WHERE id = ?", args...).Error; err != nil {
		Fail(c, err)
		return
	}
	st, err := h.Students.Get(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, st)
}

func (h *StudentHandler) TransferOwner(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	var body struct {
		ToAdminID uint64 `json:"to_admin_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.ToAdminID == 0 {
		Fail(c, errBadBody)
		return
	}
	cu := middleware.Current(c)
	if err := h.Students.TransferOwner(DB, cu.ID, id, body.ToAdminID); err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"ok": true})
}

// Credits returns the balance plus the append-only ledger. Same read scope
// as Get: staff may read any student, a household only its own children.
// The ledger includes purchase amounts, which is precisely the reason a
// household credential must not be able to read another family's.
func (h *StudentHandler) Credits(c *gin.Context) {
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
	if err := h.Students.AssertReadable(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	bal, err := h.Credit.SumBalance(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	rows, err := h.Students.Ledger(DB, id, limit)
	if err != nil {
		Fail(c, err)
		return
	}
	total, err := h.Students.LedgerCount(DB, id)
	if err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"balance": bal, "items": rows, "total": total})
}

func (h *StudentHandler) Purchase(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	cu := middleware.Current(c)
	if err := h.Students.AssertOwner(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	var body struct {
		Name         string `json:"name"`
		TotalCredits int    `json:"total_credits"`
		PriceCents   int64  `json:"price_cents"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.TotalCredits <= 0 {
		Fail(c, errBadBody)
		return
	}
	if body.Name == "" {
		body.Name = strconv.Itoa(body.TotalCredits) + "-credit package"
	}
	p := &model.CreditPackage{StudentID: id, Name: body.Name, TotalCredits: body.TotalCredits, PriceCents: body.PriceCents}
	err := DB.Transaction(func(tx *gorm.DB) error {
		return h.Credit.Purchase(tx, cu.ID, p)
	})
	if err != nil {
		Fail(c, err)
		return
	}
	bal, _ := h.Credit.SumBalance(DB, id)
	Created(c, gin.H{"package": p, "balance": bal})
}

func (h *StudentHandler) Adjustment(c *gin.Context) {
	id, ok := parseID(c, "id")
	if !ok {
		Fail(c, errBadID)
		return
	}
	cu := middleware.Current(c)
	if err := h.Students.AssertOwner(DB, cu.ID, cu.Role, id); err != nil {
		Fail(c, err)
		return
	}
	var body struct {
		Delta  int    `json:"delta"`
		Note   string `json:"note"`
		Refund bool   `json:"refund"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, err)
		return
	}
	var bal int
	err := DB.Transaction(func(tx *gorm.DB) error {
		if body.Refund {
			d, err := h.Credit.Refund(tx, cu.ID, id, body.Note)
			if err != nil {
				return err
			}
			body.Delta = d
			return nil
		}
		if body.Delta == 0 {
			return errBadBody
		}
		if err := h.Credit.LockStudent(tx, id); err != nil {
			return err
		}
		return h.Credit.Apply(tx, &model.CreditLedger{
			StudentID:   id,
			Delta:       body.Delta,
			Reason:      model.ReasonManualAdjust,
			ActorUserID: cu.ID,
			Note:        body.Note,
		})
	})
	if err != nil {
		Fail(c, err)
		return
	}
	bal, _ = h.Credit.SumBalance(DB, id)
	OK(c, gin.H{"applied": body.Delta, "balance": bal})
}
