package handler

import (
	"github.com/gin-gonic/gin"

	"sms/internal/clock"
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
	page, limit := pageParams(c)

	// student_id goes through queryUint instead of being interpolated as a
	// raw query string. As a string it was handed to the driver as text,
	// so `?student_id=abc` matched nothing and returned an empty page with
	// no error - the caller reads that as "this student has no trials"
	// while the filter was never really applied. Every other numeric query
	// parameter in the project answers 400 / 40000 instead
	// (ARCHITECTURE.md:592); queryUint has already written that response,
	// so this returns immediately.
	studentID, hasStudent, bad := queryUint(c, "student_id")
	if bad {
		return
	}

	// The WHERE clause is assembled exactly once and shared by the COUNT
	// and the page query below. Writing it twice is how `total` starts
	// describing a different set than `items`: the role scoping in
	// particular is a *visibility* rule, so a COUNT that omitted it would
	// advertise the company-wide row count while handing back one
	// consultant's rows, and the client's page count would be inflated by
	// rows the caller is not allowed to see.
	where := " WHERE 1=1"
	args := []interface{}{}
	if hasStudent {
		where += " AND t.student_id = ?"
		args = append(args, studentID)
	}
	// Hoisted out of the if so the ORDER BY further down can see it: the
	// filter and the sort are two halves of one answer, and re-reading the
	// query string in two places is how they drift apart.
	outcome := c.Query("outcome")
	if outcome != "" {
		where += " AND t.outcome = ?"
		args = append(args, outcome)
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
			where += " AND s.owner_admin_id = ?"
			args = append(args, cu.ID)
		case model.RoleTeacher:
			where += " AND t.teacher_id = ?"
			args = append(args, cu.ID)
		}
	}

	// No ORDER BY and no LIMIT here on purpose: total is a property of the
	// filtered set, and the two clauses would only make it slower to
	// compute and easier to get wrong.
	var total int64
	if err := DB.Raw(`SELECT COUNT(*)
		FROM trials t
		JOIN students s ON s.id = t.student_id`+where, args...).Scan(&total).Error; err != nil {
		Fail(c, err)
		return
	}

	// Initialised, not declared nil: with the ownership scoping above an
	// empty page is a normal event (a consultant with no trials of their
	// own, or a page past the end), and a nil slice would serialise as
	// `data.items: null` instead of `[]`. Same reason service/trial.go does
	// this for follow-ups; the project rule is that a list endpoint never
	// emits null.
	rows := []model.Trial{}
	// The paging arguments go into a copy so that `args` keeps meaning "the
	// WHERE arguments" for the rest of the function, instead of turning into
	// a mix of filter and paging values that only lines up with one
	// statement's placeholder order.
	//
	// The sort key differs by tab. Every tab is "most recent first", but
	// 待记录结果 is a queue of work and its newest row is not its most urgent
	// one: it holds trials that have not happened yet (booked one to nine
	// days out) next to ones that already ran and whose outcome nobody
	// recorded. Only the second kind is actionable, and under the plain
	// recency sort it sits at the bottom - past the page boundary, so a
	// consultant reading page one sees nothing to do. This tab therefore
	// leads with finished-but-unrecorded rows, and only then by recency.
	//
	// Scoped to `outcome=pending` on purpose. The other two tabs are
	// historical lists where every row has already finished, so the key
	// would be constant for them - but it would *not* be constant if an
	// outcome is recorded before the slot arrives, and in those tabs such a
	// row is simply the newest entry, not the least urgent one.
	//
	// The readiness test is `scheduled_at + duration_min <= now` rather than
	// `scheduled_at <= now`: a 60-minute lesson is not finished when it
	// starts. COALESCE because the column is nullable in the schema even
	// though CreateTrial defaults it to 60. `now` is a bind value instead of
	// SQL NOW(), for the same reason service/trial.go binds clock.Now() -
	// the clock is injected, and a database-side NOW() would silently answer
	// in the session's timezone.
	order := " ORDER BY t.scheduled_at DESC, t.id DESC"
	orderArgs := []interface{}{}
	if outcome == "pending" {
		order = ` ORDER BY (t.scheduled_at + INTERVAL COALESCE(t.duration_min, 60) MINUTE <= ?) DESC, t.scheduled_at DESC, t.id DESC`
		orderArgs = append(orderArgs, clock.Now())
	}
	listArgs := append(append([]interface{}{}, args...), orderArgs...)
	listArgs = append(listArgs, limit, (page-1)*limit)
	// t.id DESC is not decoration. scheduled_at is not unique - the seed
	// writes whole batches at identical wall-clock slots - and under
	// LIMIT/OFFSET a non-unique sort key makes the pages overlap and miss
	// rows: page 1 and page 2 then hold "different sets of rows" rather
	// than "the same rows in a different order", so concatenating the pages
	// neither covers total nor stays distinct. /students already lost five
	// rows this way once; the tie-breaker closes it here.
	if err := DB.Raw(`SELECT t.*, s.full_name AS student_name, sub.name AS subject_name, u.display_name AS teacher_name
		FROM trials t
		JOIN students s ON s.id = t.student_id
		LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id`+where+order+`
		LIMIT ? OFFSET ?`, listArgs...).Scan(&rows).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, Page{Items: rows, Total: total, Page: page, Limit: limit, HasMore: int64(page*limit) < total})
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
	// pageParams, not a bare Atoi: the old code echoed whatever limit the
	// caller sent while the service clamped it internally, so `?limit=500`
	// answered `limit:500` and returned 20 rows. The client then computed
	// pages from a limit the query never used.
	page, limit := pageParams(c)
	studentID, hasStudent, bad := queryUint(c, "student_id")
	if bad {
		return
	}
	f := service.FollowUpFilter{
		Status: c.Query("status"),
		Page:   page,
		Limit:  limit,
	}
	if hasStudent {
		f.StudentID = &studentID
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
