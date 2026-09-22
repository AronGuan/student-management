package handler

import (
	"github.com/gin-gonic/gin"

	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
)

type DashboardHandler struct{ Cfg *config.Config }

type adminDashboard struct {
	OverdueFollowUps []followUpRow  `json:"overdue_follow_ups"`
	UpcomingTrials   []trialRow     `json:"upcoming_trials"`
	LowCredit        []lowCreditRow `json:"low_credit"`
	TodayLessons     int            `json:"today_lessons"`
	// The four queues above are the product; these three integers are the
	// headline numbers a queue cannot express on its own.
	PendingFollowUps  int `json:"pending_followups"`
	OverdueFollowups  int `json:"overdue_followups"`
	LowCreditStudents int `json:"low_credit_students"`
}

type followUpRow struct {
	ID          uint64 `json:"id"`
	StudentID   uint64 `json:"student_id"`
	StudentName string `json:"student_name"`
	DueAt       string `json:"due_at"`
	// Hours overdue, counted against the server clock. Deliberately a
	// plain int with no omitempty, unlike model.FollowUp's *int64: this
	// queue is already filtered to due_at < now, so the key is always
	// meaningful, and TIMESTAMPDIFF truncates - a follow-up 30 minutes
	// overdue honestly reads 0 rather than 1. Wording is the front end's
	// job; the server no longer ships the string "26h overdue".
	OverdueHours int64 `json:"overdue_hours"`
}

type trialRow struct {
	ID          uint64 `json:"id"`
	StudentID   uint64 `json:"student_id"`
	StudentName string `json:"student_name"`
	SubjectName string `json:"subject_name"`
	TeacherName string `json:"teacher_name"`
	ScheduledAt string `json:"scheduled_at"`
	Outcome     string `json:"outcome"`
}

// lowCreditRow deliberately has no run-out estimate. A "weeks left" figure
// needs a per-student weekly burn rate, which nothing here computes, so a
// field would have been permanently empty - and a contract that advertises a
// field it never fills is worse than no field, because the client renders a
// blank where a number should be and cannot tell the difference from "zero".
type lowCreditRow struct {
	StudentID    uint64 `json:"student_id"`
	FullName     string `json:"full_name"`
	Balance      int    `json:"balance"`
	TotalCredits int    `json:"total_credits"`
}

// Admin is the landing screen. It is two action queues plus upcoming
// trials - deliberately not a student list, because the admin's failure
// mode is forgetting to act, not being unable to find someone.
func (h *DashboardHandler) Admin(c *gin.Context) {
	cu := middleware.Current(c)
	now := nowDB()

	out := adminDashboard{
		OverdueFollowUps: []followUpRow{},
		UpcomingTrials:   []trialRow{},
		LowCredit:        []lowCreditRow{},
	}

	// Overdue follow-ups first: this is the queue that costs money.
	// The overdue count is computed in SQL against the server clock so the
	// front end never has to re-derive the SLA from a timestamp it may
	// render in a different zone. SQL returns the hours only; the wording
	// ("2 天" / "6 小时") belongs to the front end.
	_ = DB.Raw(`SELECT fu.id, fu.student_id, s.full_name AS student_name, fu.due_at,
			TIMESTAMPDIFF(HOUR, fu.due_at, ?) AS overdue_hours
		FROM follow_ups fu JOIN students s ON s.id = fu.student_id
		WHERE fu.status = 'pending' AND fu.due_at < ? AND s.owner_admin_id = ?
		ORDER BY fu.due_at ASC LIMIT 20`, now, now, cu.ID).Scan(&out.OverdueFollowUps)

	_ = DB.Raw(`SELECT t.id, t.student_id, s.full_name AS student_name,
			sub.name AS subject_name, u.display_name AS teacher_name, t.scheduled_at, t.outcome
		FROM trials t
		JOIN students s ON s.id = t.student_id
		LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id
		WHERE s.owner_admin_id = ? AND t.scheduled_at >= ?
		ORDER BY t.scheduled_at ASC LIMIT 10`, cu.ID, now).Scan(&out.UpcomingTrials)

	_ = DB.Raw(`SELECT s.id AS student_id, s.full_name, COALESCE(b.balance,0) AS balance,
			COALESCE(p.total_credits,0) AS total_credits
		FROM students s
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		LEFT JOIN (SELECT student_id, SUM(total_credits) AS total_credits
		           FROM credit_packages WHERE status='active' GROUP BY student_id) p
		       ON p.student_id = s.id
		WHERE s.owner_admin_id = ? AND s.status = 'active' AND COALESCE(b.balance,0) <= ?
		ORDER BY balance ASC LIMIT 20`, cu.ID, h.Cfg.Thresholds.LowCreditThreshold).Scan(&out.LowCredit)

	_ = DB.Raw(`SELECT COUNT(*) FROM lessons l
		JOIN class_enrollments e ON e.class_id = l.class_id
		JOIN students s ON s.id = e.student_id
		WHERE s.owner_admin_id = ? AND l.lesson_date = ?`, cu.ID, nowDate()).Scan(&out.TodayLessons)

	// Same scoping as the queues above: the calling admin's students only.
	_ = DB.Raw(`SELECT COUNT(*) FROM follow_ups fu
		JOIN students s ON s.id = fu.student_id
		WHERE s.owner_admin_id = ? AND fu.status = 'pending'`,
		cu.ID).Scan(&out.PendingFollowUps)

	_ = DB.Raw(`SELECT COUNT(*) FROM follow_ups fu
		JOIN students s ON s.id = fu.student_id
		WHERE s.owner_admin_id = ? AND fu.status = 'pending' AND fu.due_at < ?`,
		cu.ID, now).Scan(&out.OverdueFollowups)

	_ = DB.Raw(`SELECT COUNT(*) FROM students s
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.owner_admin_id = ? AND s.status = 'active' AND COALESCE(b.balance,0) <= ?`,
		cu.ID, h.Cfg.Thresholds.LowCreditThreshold).Scan(&out.LowCreditStudents)

	OK(c, out)
}

type teacherDashboard struct {
	Today           []teacherLessonRow `json:"today"`
	MissingRollCall int                `json:"missing_roll_call"`
}

type teacherLessonRow struct {
	ID          uint64 `json:"id"`
	ClassID     uint64 `json:"class_id"`
	ClassName   string `json:"class_name"`
	SubjectName string `json:"subject_name"`
	LessonDate  string `json:"lesson_date"`
	StartMin    int    `json:"start_min"`
	StartClock  string `json:"start_clock"`
	Status      string `json:"status"`
	Students    int    `json:"students"`
	NewFaces    int    `json:"new_faces"`
	OnLeave     int    `json:"on_leave"`
	Recorded    int    `json:"recorded"`
}

// Teacher answers three questions without clicking anything:
// what is next, who is new, who is away.
func (h *DashboardHandler) Teacher(c *gin.Context) {
	cu := middleware.Current(c)
	out := teacherDashboard{Today: []teacherLessonRow{}}

	_ = DB.Raw(`SELECT l.id, l.class_id, c.name AS class_name, s.name AS subject_name,
			l.lesson_date, l.start_min, l.status,
			(SELECT COUNT(*) FROM class_enrollments e WHERE e.class_id = l.class_id AND e.status='active') AS students,
			(SELECT COUNT(*) FROM class_enrollments e WHERE e.class_id = l.class_id AND e.status='active'
			   AND NOT EXISTS (SELECT 1 FROM attendances a2 JOIN lessons l2 ON l2.id=a2.lesson_id
			                   WHERE a2.student_id=e.student_id AND l2.class_id=l.class_id AND l2.lesson_date < l.lesson_date)) AS new_faces,
			(SELECT COUNT(*) FROM leave_requests lr WHERE lr.lesson_id = l.id) AS on_leave,
			(SELECT COUNT(*) FROM attendances a WHERE a.lesson_id = l.id) AS recorded
		FROM lessons l
		JOIN classes c ON c.id = l.class_id
		LEFT JOIN subjects s ON s.id = c.subject_id
		WHERE l.teacher_id = ? AND l.lesson_date >= DATE(?) AND l.status <> 'cancelled'
		ORDER BY l.lesson_date, l.start_min LIMIT 30`, cu.ID, nowDB()).Scan(&out.Today)

	for i := range out.Today {
		out.Today[i].StartClock = minutesToClock(out.Today[i].StartMin)
	}

	_ = DB.Raw(`SELECT COUNT(*) FROM lessons l
		WHERE l.teacher_id = ? AND l.lesson_date < DATE(?)
		  AND l.status = 'scheduled'
		  AND EXISTS (SELECT 1 FROM class_enrollments e WHERE e.class_id = l.class_id AND e.status='active')`,
		cu.ID, nowDB()).Scan(&out.MissingRollCall)

	OK(c, out)
}

// Household is the parent/student landing screen. The point is that every
// movement is explained, because "my credits vanished" is the complaint
// this screen exists to remove.
func (h *DashboardHandler) Household(c *gin.Context) {
	cu := middleware.Current(c)
	type row struct {
		ID       uint64 `json:"id"`
		FullName string `json:"full_name"`
		Balance  int    `json:"balance"`
		Status   string `json:"status"`
	}
	var students []row
	if err := DB.Raw(`SELECT s.id, s.full_name, COALESCE(b.balance,0) AS balance, s.status
		FROM students s LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.user_id = ? AND s.deleted_at IS NULL`, cu.ID).Scan(&students).Error; err != nil {
		Fail(c, err)
		return
	}
	OK(c, gin.H{"students": students})
}

var _ = model.RoleStudent
