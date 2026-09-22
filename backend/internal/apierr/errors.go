package apierr

import "net/http"

// APIError is the single error shape returned by every handler.
// code 0 means success; every non-zero code is a business error the
// front end can branch on without parsing message strings.
type APIError struct {
	Code    int    `json:"code"`
	HTTP    int    `json:"-"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return e.Message }

func New(code, httpStatus int, msg string) *APIError {
	return &APIError{Code: code, HTTP: httpStatus, Message: msg}
}

const (
	CodeOK = 0

	CodeUnauthorized = 40100
	CodeBadRequest   = 40000 // malformed caller input (e.g. a non-numeric filter)
	CodeForbidden    = 40300
	CodeNotOwner     = 40301 // R7
	CodeNotFound     = 40400

	CodeSlotOverlap     = 40901 // R3a weekly slot overlap
	CodeTeacherConflict = 40902 // R3b teacher double-booked
	CodeClassFull       = 40903 // R3c capacity
	CodeNoCredit        = 40904 // R6 balance is zero
	CodeTrialDuplicate  = 40905 // R1 retrial
	CodeDuplicateSettle = 40906 // R4/R5 idempotency
	CodeNotEnrolled     = 40907 // acting on a lesson the student is not in

	CodeBadAttendance = 42201 // R4 illegal status
	CodeLLMSchema     = 42202 // R8 whitelist failure

	// CodeConflict is a well-formed request the current business state
	// forbids - a cancelled lesson, one already under way. Distinct from
	// CodeBadRequest because the caller cannot make it succeed by editing
	// the request, and distinct from CodeInternal because nothing is broken.
	CodeConflict = 40908

	CodeLLMUnavailable = 50301 // degraded on purpose; still HTTP 200

	// CodeInternal is the catch-all for a failure we did not classify.
	// It replaces the old -1, which collided with nothing and told the
	// client nothing; the contract documents 50000 (docs/openapi.yaml).
	CodeInternal = 50000
)

// Messages are user-facing: the front end renders them verbatim for every
// code it has not registered its own copy for (see frontend/src/lib/api.ts),
// so they must read as plain Chinese sentences, not as log lines.
var (
	ErrUnauthorized = New(CodeUnauthorized, http.StatusUnauthorized, "未登录或登录状态已过期，请重新登录")
	ErrForbidden    = New(CodeForbidden, http.StatusForbidden, "当前角色无权执行该操作")
	ErrNotFound     = New(CodeNotFound, http.StatusNotFound, "记录不存在")

	// ErrNotOwner is R7: an admin may read every student but may only
	// write the ones whose owner_admin_id matches their own id.
	ErrNotOwner = New(CodeNotOwner, http.StatusForbidden, "该学生属于其他顾问，仅可查看")

	ErrSlotOverlap     = New(CodeSlotOverlap, http.StatusConflict, "该周时段与学生已报班级的时间重叠")
	ErrTeacherConflict = New(CodeTeacherConflict, http.StatusConflict, "该时间槽老师已有课")
	ErrClassFull       = New(CodeClassFull, http.StatusConflict, "班级名额已满")
	ErrNoCredit        = New(CodeNoCredit, http.StatusConflict, "课时余额为 0，请先续费再报名")
	ErrTrialDuplicate  = New(CodeTrialDuplicate, http.StatusConflict, "该学生已试听过这个科目")
	ErrNotEnrolled     = New(CodeNotEnrolled, http.StatusConflict, "该学生未报名这节课所属的班级")

	ErrBadAttendance = New(CodeBadAttendance, http.StatusUnprocessableEntity, "出勤状态不合法，只能记录 present / late / absent")

	// The three states below are callable by a household or a teacher, so
	// they are user-facing facts rather than internal faults. They were
	// plain errors.New until they surfaced as a generic 50000.
	ErrLessonCancelledSettle = New(CodeConflict, http.StatusConflict, "该课次已取消，无法记录出勤")
	ErrLessonCancelledLeave  = New(CodeConflict, http.StatusConflict, "该课次已取消，无需请假")
	ErrLessonAlreadyStarted  = New(CodeConflict, http.StatusConflict, "该课次已开始，出勤由老师判定，无法请假")
)

// BadRequest builds the 40000 error. The test for choosing it: the caller
// caused the failure and can make the call succeed by changing the request.
// A malformed date, a missing required field and a non-numeric filter all
// qualify. Anything the caller cannot fix belongs to a more specific code
// (see CodeConflict) or to 50000.
func BadRequest(msg string) *APIError {
	return New(CodeBadRequest, http.StatusBadRequest, msg)
}

func NotOwner() *APIError {
	return New(CodeNotOwner, http.StatusForbidden, "该学生属于其他顾问，仅可查看")
}
