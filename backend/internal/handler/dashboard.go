package handler

import (
	"github.com/gin-gonic/gin"

	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
)

type DashboardHandler struct{ Cfg *config.Config }

type adminDashboard struct {
	OverdueFollowUps []followUpRow        `json:"overdue_follow_ups"`
	FlaggedFollowUps []flaggedFollowUpRow `json:"flagged_follow_ups"`
	UpcomingTrials   []trialRow           `json:"upcoming_trials"`
	AwaitingOutcome  []trialRow           `json:"awaiting_outcome_trials"`
	LowCredit        []lowCreditRow       `json:"low_credit"`
	TodayLessons     int                  `json:"today_lessons"`
	// The five queues above are the product; these five integers are the
	// headline numbers a queue cannot express on its own.
	PendingFollowUps           int `json:"pending_followups"`
	OverdueFollowups           int `json:"overdue_followups"`
	FlaggedFollowups           int `json:"flagged_followups"`
	LowCreditStudents          int `json:"low_credit_students"`
	AwaitingOutcomeTrialsCount int `json:"awaiting_outcome_trials_count"`
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

// flaggedFollowUpRow 故意没有 overdue_hours，这不是漏写。
//
// followUpRow.overdue_hours（handler/dashboard.go:32-38）的文档明写「该队列已被
// due_at < now 过滤，所以键恒在、值恒为正，且 0 表示已逾期但不足 1 小时，而**不是**
// 未到期」。本队列的行按定义**还没到期**，复用一个字段就只能给出 0 或负数：前者与那句
// 文档正面冲突（「没到期」被渲染成「已逾期 0 小时」），后者把这个字段的值域从 [0, +∞)
// 放宽到 (-∞, +∞)，而它和 model.FollowUp.overdue_hours 是**同名**的（model/model.go:304）。
// 所以干脆不给：前端拿 due_at 做本地倒计时，与服务端在 GET /follow-ups 上对未逾期行的
// 处理方式完全一致 —— 那边靠指针 + omitempty 让整个键缺席，这里靠键从不出现。
type flaggedFollowUpRow struct {
	ID          uint64 `json:"id"`
	StudentID   uint64 `json:"student_id"`
	StudentName string `json:"student_name"`
	DueAt       string `json:"due_at"`
}

type trialRow struct {
	ID          uint64 `json:"id"`
	StudentID   uint64 `json:"student_id"`
	StudentName string `json:"student_name"`
	SubjectName string `json:"subject_name"`
	TeacherName string `json:"teacher_name"`
	ScheduledAt string `json:"scheduled_at"`
	// Sent raw (minutes), not as a computed end time or an `ended` flag:
	// "has it finished yet" is a rendering-time question the front end
	// already answers with hoursSinceEnd(startIso, durationMin), and
	// shipping a second derived field here would let the two drift.
	DurationMin int    `json:"duration_min"`
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

// Admin is the landing screen. It is five action queues - overdue
// follow-ups, classroom flags raised by a teacher, trials not started yet,
// trials finished with no outcome recorded, low credit - deliberately not a
// student list, because the admin's failure mode is forgetting to act, not
// being unable to find someone.
func (h *DashboardHandler) Admin(c *gin.Context) {
	cu := middleware.Current(c)
	now := nowDB()

	out := adminDashboard{
		OverdueFollowUps: []followUpRow{},
		// 同上，也要初始化成空切片而不是留成 nil：顾问手上一条老师旗标都没有是
		// 正常状态（他刚清完），而 nil 会序列化成 `null`，让「本区为空」和
		// 「字段没实现」在前端看起来一样。
		FlaggedFollowUps: []flaggedFollowUpRow{},
		UpcomingTrials:   []trialRow{},
		// Initialised, not declared nil: a consultant whose trials have all
		// been recorded has an empty queue as the normal case, and a nil
		// slice would serialise as `null` instead of `[]` (same rule as
		// handler/trial.go:93-98 - a list endpoint never emits null).
		AwaitingOutcome: []trialRow{},
		LowCredit:       []lowCreditRow{},
	}

	// Overdue follow-ups first: this is the queue that costs money.
	// The overdue count is computed in SQL against the server clock so the
	// front end never has to re-derive the SLA from a timestamp it may
	// render in a different zone. SQL returns the hours only; the wording
	// ("2 天" / "6 小时") belongs to the front end.
	//
	// `AND fu.source = 'trial'` 是与下面那条标记队列的**切分**，不是一次顺手过滤：
	// 两条队列按 source 恰好切分「所有未完成的跟进」，不重不漏。必须显式写出来，而不是
	// 靠「反正现在逾期的都是试听来的」——那是靠数据现状成立的说法，不是靠约束成立的说法。
	// 课堂标记一旦也逾期，同一行就会同时出现在两个队列里，而写下这条 SQL 的人当时并不
	// 知道会有人从教室那头写 follow_ups。
	_ = DB.Raw(`SELECT fu.id, fu.student_id, s.full_name AS student_name, fu.due_at,
			TIMESTAMPDIFF(HOUR, fu.due_at, ?) AS overdue_hours
		FROM follow_ups fu JOIN students s ON s.id = fu.student_id
		WHERE fu.status = 'pending' AND fu.source = 'trial' AND fu.due_at < ? AND s.owner_admin_id = ?
		ORDER BY fu.due_at ASC LIMIT 20`, now, now, cu.ID).Scan(&out.OverdueFollowUps)

	// 「需要顾问跟进」队列：老师在点名页勾了旗标、顾问还没处理完的那些。这是这一区
	// 存在的唯一理由 —— 老师勾完必须有人看得见，而 /dashboard/admin 是顾问侧目前
	// 唯一的下发入口（follow_ups 在别处没有列表入口）。
	//
	// 与上面那条的三点不同，都是刻意的：
	//  1. **不按是否逾期过滤**（status='pending' AND source='teacher_note' 全收）。
	//     已逾期的行**留在这里**而不是甩进逾期区：逾期区按 source 只收试听转化，
	//     而它在界面上当前是隐藏的，甩过去等于让这条任务凭空消失。
	//  2. 行里没有 overdue_hours（见 flaggedFollowUpRow）。
	//  3. 措辞由前端从 due_at 做本地倒计时，服务端不替它算差值。
	//
	// 排序与逾期队列同向（due_at ASC，最早到期的先救），上限 20 与兄弟队列一致。
	// 作用域同样是「调用者名下的学生」：这一区是按顾问过滤下发的，不是全局待办。
	_ = DB.Raw(`SELECT fu.id, fu.student_id, s.full_name AS student_name, fu.due_at
		FROM follow_ups fu JOIN students s ON s.id = fu.student_id
		WHERE fu.status = 'pending' AND fu.source = 'teacher_note' AND s.owner_admin_id = ?
		ORDER BY fu.due_at ASC LIMIT 20`, cu.ID).Scan(&out.FlaggedFollowUps)

	_ = DB.Raw(`SELECT t.id, t.student_id, s.full_name AS student_name,
			sub.name AS subject_name, u.display_name AS teacher_name, t.scheduled_at,
			t.duration_min, t.outcome
		FROM trials t
		JOIN students s ON s.id = t.student_id
		LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id
		WHERE s.owner_admin_id = ? AND t.scheduled_at >= ?
		ORDER BY t.scheduled_at ASC LIMIT 10`, cu.ID, now).Scan(&out.UpcomingTrials)

	// 与 upcoming_trials 恰成互补的另一段：已经上完、但结果还没记的试听。
	// 这一批是全系统里唯一「顾问此刻就能操作」的行 —— 记录结果会在同一事务里
	// 启动 48h 跟进时钟（R2），所以它排在 today_lessons 计数之前先下发。
	//
	// 排序是「结束最久的排最前」（ASC），与 GET /trials?outcome=pending 的 DESC
	// **刻意相反**，不是笔误：那边是档位浏览，刚下课的最该马上打电话，所以最新的
	// 在前（handler/trial.go:127-132）；这边是积压兜底，越久没记越该先救，所以最旧
	// 的在前。
	//
	// t.id ASC 是分页稳定的 tie-breaker，不是装饰：scheduled_at 不唯一（seed 会写
	// 整批同一时刻的行），同一个结束时刻下若没有唯一键收尾，LIMIT/OFFSET 会让页与页
	// 重叠、漏行（handler/trial.go:135-141 有完整先例）。
	//
	// 判据是「开始 + 时长」而不是「开始」：60 分钟的课在开课那一刻并没有结束。
	// COALESCE 因为列在 schema 里可空（尽管 CreateTrial 会填 60）。
	// now 是绑定参数而不是 SQL 的 NOW()：服务端时钟是注入的，库端 NOW() 会静默
	// 按 session 时区作答（service/trial.go 绑定 clock.Now() 是同一理由）。
	_ = DB.Raw(`SELECT t.id, t.student_id, s.full_name AS student_name,
			sub.name AS subject_name, u.display_name AS teacher_name, t.scheduled_at,
			t.duration_min, t.outcome
		FROM trials t
		JOIN students s ON s.id = t.student_id
		LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id
		WHERE s.owner_admin_id = ? AND t.outcome = 'pending'
		  AND t.scheduled_at + INTERVAL COALESCE(t.duration_min, 60) MINUTE <= ?
		ORDER BY t.scheduled_at + INTERVAL COALESCE(t.duration_min, 60) MINUTE ASC, t.id ASC
		LIMIT 20`, cu.ID, now).Scan(&out.AwaitingOutcome)

	// The same predicate as the queue directly above, minus ORDER BY and
	// LIMIT: total is a property of the filtered set, not of the page. It
	// is written next to its list on purpose - the two must agree on the
	// readiness test, and the count is the only place that disagreement
	// would be invisible, since a queue of 20 looks the same whether the
	// backlog is 20 rows or 200.
	_ = DB.Raw(`SELECT COUNT(*) FROM trials t
		JOIN students s ON s.id = t.student_id
		WHERE s.owner_admin_id = ? AND t.outcome = 'pending'
		  AND t.scheduled_at + INTERVAL COALESCE(t.duration_min, 60) MINUTE <= ?`,
		cu.ID, now).Scan(&out.AwaitingOutcomeTrialsCount)

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
		WHERE s.owner_admin_id = ? AND fu.status = 'pending' AND fu.source = 'trial' AND fu.due_at < ?`,
		cu.ID, now).Scan(&out.OverdueFollowups)

	// 与上面那条标记队列**同一个谓词**，去掉 ORDER BY / LIMIT：计数是被过滤集合的属性，
	// 不是当页的属性。两者必须同谓词，否则页头说 5 条、列表只画 3 条，而看的人只会
	// 以为列表漏了行 —— 这个偏差在别处都看不见，因为一个 20 行的队列看起来和 200 行一样。
	//
	// 与之相对，pending_followups 刻意**不**按 source 收窄：它是「待跟进总数（含未逾期）」，
	// 契约没有把它分成两半，两个 source 的条数加起来才是它。
	_ = DB.Raw(`SELECT COUNT(*) FROM follow_ups fu
		JOIN students s ON s.id = fu.student_id
		WHERE s.owner_admin_id = ? AND fu.status = 'pending' AND fu.source = 'teacher_note'`,
		cu.ID).Scan(&out.FlaggedFollowups)

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
