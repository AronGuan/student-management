package model

import "time"

type Role string

const (
	RoleAdmin   Role = "admin"
	RoleTeacher Role = "teacher"
	RoleStudent Role = "student"
)

type User struct {
	ID           uint64    `gorm:"primaryKey;column:id" json:"id"`
	Role         Role      `gorm:"column:role" json:"role"`
	Username     string    `gorm:"column:username" json:"username"`
	PasswordHash string    `gorm:"column:password_hash" json:"-"`
	DisplayName  string    `gorm:"column:display_name" json:"display_name"`
	Status       string    `gorm:"column:status" json:"status"`
	CreatedAt    time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt    time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (User) TableName() string { return "users" }

type TeacherProfile struct {
	UserID uint64 `gorm:"primaryKey;column:user_id" json:"user_id"`
	Bio    string `gorm:"column:bio" json:"bio"`
	Active bool   `gorm:"column:active" json:"active"`
}

func (TeacherProfile) TableName() string { return "teacher_profiles" }

type Subject struct {
	ID   uint64 `gorm:"primaryKey;column:id" json:"id"`
	Name string `gorm:"column:name" json:"name"`
}

func (Subject) TableName() string { return "subjects" }

// StudentStatus tracks the lifecycle: lead -> trial -> active -> churned.
type StudentStatus string

const (
	StudentLead    StudentStatus = "lead"
	StudentTrial   StudentStatus = "trial"
	StudentActive  StudentStatus = "active"
	StudentChurned StudentStatus = "churned"
)

type Student struct {
	ID            uint64        `gorm:"primaryKey;column:id" json:"id"`
	OwnerAdminID  *uint64       `gorm:"column:owner_admin_id" json:"owner_admin_id"`
	UserID        *uint64       `gorm:"column:user_id" json:"user_id"`
	FullName      string        `gorm:"column:full_name" json:"full_name"`
	PreferredName string        `gorm:"column:preferred_name" json:"preferred_name"`
	YearLevel     string        `gorm:"column:year_level" json:"year_level"`
	Status        StudentStatus `gorm:"column:status" json:"status"`
	Source        string        `gorm:"column:source" json:"source"`
	CreatedAt     time.Time     `gorm:"column:created_at" json:"created_at"`
	UpdatedAt     time.Time     `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt     *time.Time    `gorm:"column:deleted_at" json:"-"`

	// Derived, never stored. See R5.
	Balance int `gorm:"->;-:migration" json:"balance"`
	// True when the caller may write this student. See R7.
	CanWrite bool `gorm:"->;-:migration" json:"can_write"`
}

func (Student) TableName() string { return "students" }

type Guardian struct {
	ID           uint64 `gorm:"primaryKey;column:id" json:"id"`
	StudentID    uint64 `gorm:"column:student_id" json:"student_id"`
	Name         string `gorm:"column:name" json:"name"`
	Phone        string `gorm:"column:phone" json:"phone"`
	Email        string `gorm:"column:email" json:"email"`
	Relationship string `gorm:"column:relationship" json:"relationship"`
	IsPrimary    bool   `gorm:"column:is_primary" json:"is_primary"`
}

func (Guardian) TableName() string { return "guardians" }

// Class is a recurring weekly slot, not a single meeting.
type Class struct {
	ID        uint64    `gorm:"primaryKey;column:id" json:"id"`
	Name      string    `gorm:"column:name" json:"name"`
	SubjectID uint64    `gorm:"column:subject_id" json:"subject_id"`
	TeacherID uint64    `gorm:"column:teacher_id" json:"teacher_id"`
	Weekday   int       `gorm:"column:weekday" json:"weekday"`
	StartMin  int       `gorm:"column:start_min" json:"start_min"`
	EndMin    int       `gorm:"column:end_min" json:"end_min"`
	Capacity  int       `gorm:"column:capacity" json:"capacity"`
	Room      string    `gorm:"column:room" json:"room"`
	Status    string    `gorm:"column:status" json:"status"`
	CreatedAt time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at" json:"updated_at"`

	SubjectName string `gorm:"->;-:migration" json:"subject_name,omitempty"`
	TeacherName string `gorm:"->;-:migration" json:"teacher_name,omitempty"`
	Enrolled    int    `gorm:"->;-:migration" json:"enrolled,omitempty"`
}

func (Class) TableName() string { return "classes" }

type ClassEnrollment struct {
	ID          uint64     `gorm:"primaryKey;column:id" json:"id"`
	ClassID     uint64     `gorm:"column:class_id" json:"class_id"`
	StudentID   uint64     `gorm:"column:student_id" json:"student_id"`
	Weekday     int        `gorm:"column:weekday" json:"weekday"`
	StartMin    int        `gorm:"column:start_min" json:"start_min"`
	Status      string     `gorm:"column:status" json:"status"`
	EnrolledOn  time.Time  `gorm:"column:enrolled_on" json:"enrolled_on"`
	WithdrawnOn *time.Time `gorm:"column:withdrawn_on" json:"withdrawn_on,omitempty"`
}

func (ClassEnrollment) TableName() string { return "class_enrollments" }

type LessonStatus string

const (
	LessonScheduled LessonStatus = "scheduled"
	LessonCompleted LessonStatus = "completed"
	LessonCancelled LessonStatus = "cancelled"
)

type Lesson struct {
	ID           uint64       `gorm:"primaryKey;column:id" json:"id"`
	ClassID      uint64       `gorm:"column:class_id" json:"class_id"`
	TeacherID    uint64       `gorm:"column:teacher_id" json:"teacher_id"`
	LessonDate   string       `gorm:"column:lesson_date" json:"lesson_date"` // YYYY-MM-DD
	Weekday      int          `gorm:"column:weekday" json:"weekday"`
	StartMin     int          `gorm:"column:start_min" json:"start_min"`
	EndMin       int          `gorm:"column:end_min" json:"end_min"`
	Status       LessonStatus `gorm:"column:status" json:"status"`
	CancelReason string       `gorm:"column:cancel_reason" json:"cancel_reason,omitempty"`
	CreatedAt    time.Time    `gorm:"column:created_at" json:"created_at"`
	UpdatedAt    time.Time    `gorm:"column:updated_at" json:"updated_at"`

	ClassName   string `gorm:"->;-:migration" json:"class_name,omitempty"`
	SubjectName string `gorm:"->;-:migration" json:"subject_name,omitempty"`
}

func (Lesson) TableName() string { return "lessons" }

// AttendanceStatus drives credit settlement (R4).
type AttendanceStatus string

const (
	AttPresent       AttendanceStatus = "present"
	AttLate          AttendanceStatus = "late"
	AttAbsent        AttendanceStatus = "absent"
	AttLeaveApproved AttendanceStatus = "leave_approved" // >= 24h notice: no charge
	AttLeaveLate     AttendanceStatus = "leave_late"     // < 24h notice: charged
)

// Charges reports whether this status consumes one credit.
func (s AttendanceStatus) Charges() bool {
	switch s {
	case AttLeaveApproved:
		return false
	case AttPresent, AttLate, AttAbsent, AttLeaveLate:
		return true
	}
	return false
}

type Attendance struct {
	ID               uint64           `gorm:"primaryKey;column:id" json:"id"`
	LessonID         uint64           `gorm:"column:lesson_id" json:"lesson_id"`
	StudentID        uint64           `gorm:"column:student_id" json:"student_id"`
	Status           AttendanceStatus `gorm:"column:status" json:"status"`
	Source           string           `gorm:"column:source" json:"source"`
	RecordedByUserID *uint64          `gorm:"column:recorded_by_user_id" json:"recorded_by_user_id,omitempty"`
	RecordedAt       *time.Time       `gorm:"column:recorded_at" json:"recorded_at,omitempty"`
	Note             string           `gorm:"column:note" json:"note,omitempty"`

	StudentName  string `gorm:"->;-:migration" json:"student_name,omitempty"`
	Balance      int    `gorm:"->;-:migration" json:"balance,omitempty"`
	IsNewToClass bool   `gorm:"->;-:migration" json:"is_new_to_class,omitempty"`
}

func (Attendance) TableName() string { return "attendances" }

type LeaveRequest struct {
	ID                uint64    `gorm:"primaryKey;column:id" json:"id"`
	LessonID          uint64    `gorm:"column:lesson_id" json:"lesson_id"`
	StudentID         uint64    `gorm:"column:student_id" json:"student_id"`
	RequestedByUserID uint64    `gorm:"column:requested_by_user_id" json:"requested_by_user_id"`
	RequestedAt       time.Time `gorm:"column:requested_at" json:"requested_at"`
	Reason            string    `gorm:"column:reason" json:"reason"`
	Resolution        string    `gorm:"column:resolution" json:"resolution"`
	HoursBeforeStart  int       `gorm:"column:hours_before_start" json:"hours_before_start"`
	CreatedAt         time.Time `gorm:"column:created_at" json:"created_at"`
}

func (LeaveRequest) TableName() string { return "leave_requests" }

type CreditPackage struct {
	ID                 uint64    `gorm:"primaryKey;column:id" json:"id"`
	StudentID          uint64    `gorm:"column:student_id" json:"student_id"`
	Name               string    `gorm:"column:name" json:"name"`
	TotalCredits       int       `gorm:"column:total_credits" json:"total_credits"`
	PriceCents         int64     `gorm:"column:price_cents" json:"price_cents"`
	PurchasedAt        time.Time `gorm:"column:purchased_at" json:"purchased_at"`
	PurchasedByAdminID uint64    `gorm:"column:purchased_by_admin_id" json:"purchased_by_admin_id"`
	Status             string    `gorm:"column:status" json:"status"`
	ExpiresAt          *string   `gorm:"column:expires_at" json:"expires_at,omitempty"`
}

func (CreditPackage) TableName() string { return "credit_packages" }

type LedgerReason string

const (
	ReasonPurchase     LedgerReason = "purchase"
	ReasonConsume      LedgerReason = "consume"
	ReasonLeaveAdjust  LedgerReason = "leave_adjust"
	ReasonManualAdjust LedgerReason = "manual_adjust"
	ReasonRefund       LedgerReason = "refund"
	ReasonTransferOut  LedgerReason = "transfer_out"
)

// CreditLedger has no UpdatedAt and no DeletedAt, on purpose (R5).
// The repository exposes no Update or Delete method either.
type CreditLedger struct {
	ID           uint64       `gorm:"primaryKey;column:id" json:"id"`
	StudentID    uint64       `gorm:"column:student_id" json:"student_id"`
	PackageID    *uint64      `gorm:"column:package_id" json:"package_id,omitempty"`
	Delta        int          `gorm:"column:delta" json:"delta"`
	Reason       LedgerReason `gorm:"column:reason" json:"reason"`
	LessonID     *uint64      `gorm:"column:lesson_id" json:"lesson_id,omitempty"`
	AttendanceID *uint64      `gorm:"column:attendance_id" json:"attendance_id,omitempty"`
	ActorUserID  uint64       `gorm:"column:actor_user_id" json:"actor_user_id"`
	Note         string       `gorm:"column:note" json:"note,omitempty"`
	CreatedAt    time.Time    `gorm:"column:created_at" json:"created_at"`

	LessonLabel string `gorm:"->;-:migration" json:"lesson_label,omitempty"`
	ActorName   string `gorm:"->;-:migration" json:"actor_name,omitempty"`
}

func (CreditLedger) TableName() string { return "credit_ledger" }

type Trial struct {
	ID          uint64    `gorm:"primaryKey;column:id" json:"id"`
	StudentID   uint64    `gorm:"column:student_id" json:"student_id"`
	SubjectID   uint64    `gorm:"column:subject_id" json:"subject_id"`
	TeacherID   *uint64   `gorm:"column:teacher_id" json:"teacher_id,omitempty"`
	ScheduledAt time.Time `gorm:"column:scheduled_at" json:"scheduled_at"`
	DurationMin int       `gorm:"column:duration_min" json:"duration_min"`
	Outcome     string    `gorm:"column:outcome" json:"outcome"`
	OutcomeNote string    `gorm:"column:outcome_note" json:"outcome_note,omitempty"`
	CreatedAt   time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt   time.Time `gorm:"column:updated_at" json:"updated_at"`

	StudentName string `gorm:"->;-:migration" json:"student_name,omitempty"`
	SubjectName string `gorm:"->;-:migration" json:"subject_name,omitempty"`
	TeacherName string `gorm:"->;-:migration" json:"teacher_name,omitempty"`
}

func (Trial) TableName() string { return "trials" }

type FollowUp struct {
	ID                uint64     `gorm:"primaryKey;column:id" json:"id"`
	StudentID         uint64     `gorm:"column:student_id" json:"student_id"`
	TrialID           *uint64    `gorm:"column:trial_id" json:"trial_id,omitempty"`
	// Source says why this row exists, and it is written by whichever path
	// created the row rather than derived by whoever reads it. Reading
	// "TrialID == nil means it came from the classroom" would be a
	// sign-without-guard: the moment a third origin exists it silently
	// mislabels every new row, and nothing - no constraint, no index, no
	// test - would report it. As an ENUM column, a wrong value cannot be
	// written at all.
	//
	// No omitempty, same footing as due_at / status / created_at below: the
	// column is NOT NULL DEFAULT 'trial', so it always carries a value, and
	// a reader never has to decide what a missing key meant.
	Source            string     `gorm:"column:source" json:"source"`
	DueAt             time.Time  `gorm:"column:due_at" json:"due_at"`
	Status            string     `gorm:"column:status" json:"status"`
	CompletedAt       *time.Time `gorm:"column:completed_at" json:"completed_at,omitempty"`
	CompletedByUserID *uint64    `gorm:"column:completed_by_user_id" json:"completed_by_user_id,omitempty"`
	Note              string     `gorm:"column:note" json:"note,omitempty"`
	// Pointers, not the plain string Note uses above: NULL is how a row says
	// "the family was never told anything", and that has to stay
	// distinguishable from a parent_note that holds an empty string - one is
	// a decision nobody made, the other is a note somebody left blank.
	ParentNote         *string    `gorm:"column:parent_note" json:"parent_note,omitempty"`
	ParentNoteAt       *time.Time `gorm:"column:parent_note_at" json:"parent_note_at,omitempty"`
	ParentNoteByUserID *uint64    `gorm:"column:parent_note_by_user_id" json:"parent_note_by_user_id,omitempty"`
	CreatedAt          time.Time  `gorm:"column:created_at" json:"created_at"`

	StudentName string `gorm:"->;-:migration" json:"student_name,omitempty"`
	// OverdueHours is derived at read time so the UI never recomputes the
	// SLA from a timestamp. Only a still-pending row past its deadline
	// carries a value (status == "pending" && due_at < now), and it is
	// never negative; every other row carries no key at all. Pointer plus
	// omitempty is what makes that "no key" possible - a plain int would
	// force every future and every done follow-up to serialise a 0, and 0
	// is a real overdue magnitude ("less than an hour overdue"), not a
	// synonym for "not overdue". This differs from handler's followUpRow,
	// which is a non-pointer int because its queue is pre-filtered to
	// overdue rows only - see the comment there.
	OverdueHours *int64 `gorm:"->;-:migration" json:"overdue_hours,omitempty"`
}

func (FollowUp) TableName() string { return "follow_ups" }

type AIDecision struct {
	ID            uint64    `gorm:"primaryKey;column:id" json:"id"`
	StudentID     uint64    `gorm:"column:student_id" json:"student_id"`
	Kind          string    `gorm:"column:kind" json:"kind"`
	Model         string    `gorm:"column:model" json:"model,omitempty"`
	PromptVersion string    `gorm:"column:prompt_version" json:"prompt_version,omitempty"`
	InputHash     string    `gorm:"column:input_hash" json:"input_hash,omitempty"`
	OutputJSON    string    `gorm:"column:output_json" json:"output_json,omitempty"`
	AIStatus      string    `gorm:"column:ai_status" json:"ai_status"`
	CreatedAt     time.Time `gorm:"column:created_at" json:"created_at"`
}

func (AIDecision) TableName() string { return "ai_decisions" }

type AuditEvent struct {
	ID          uint64    `gorm:"primaryKey;column:id" json:"id"`
	ActorUserID *uint64   `gorm:"column:actor_user_id" json:"actor_user_id,omitempty"`
	Entity      string    `gorm:"column:entity" json:"entity"`
	EntityID    uint64    `gorm:"column:entity_id" json:"entity_id"`
	Action      string    `gorm:"column:action" json:"action"`
	PayloadJSON string    `gorm:"column:payload_json" json:"payload_json,omitempty"`
	CreatedAt   time.Time `gorm:"column:created_at" json:"created_at"`
}

func (AuditEvent) TableName() string { return "audit_events" }
