// Package seed loads demo data.
//
// The point is not volume, it is texture: an admin with ~100 students who
// cannot possibly hold them all in their head, a trial that finished three
// days ago and was never followed up, a household two lessons away from
// running out. Those are the states the UI exists to make visible, so the
// seed has to produce them on purpose.
package seed

import (
	"fmt"
	"time"

	"gorm.io/gorm"

	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/model"
	"sms/internal/service"
)

var (
	firstNamesM = []string{"Eric", "Leo", "Kevin", "David", "Ryan", "Owen", "Peter", "Ivan", "Marcus", "Ethan",
		"Jason", "Felix", "Aaron", "Caleb", "Nathan", "Oscar", "Toby", "Hugo", "Vincent", "Simon"}
	firstNamesF = []string{"Amy", "Nina", "Ruby", "Grace", "Zara", "Chloe", "Elsa", "Hannah", "Iris", "Yuki",
		"Mia", "Luna", "Sophie", "Tina", "Vivian", "Wendy", "Alice", "Bella", "Clara", "Doris"}
	surnames = []string{"Chen", "Wang", "Liu", "Zhao", "Sun", "Tan", "Xu", "He", "Ding", "Fu",
		"Guo", "Ma", "Qian", "Yan", "Zhu", "Deng", "Zhou", "Wu", "Lin", "Yang"}
	subjects   = []string{"Beginner Maths", "AEIS Maths", "AEIS Writing", "English Oral", "Advanced Maths", "Science"}
	yearLevels = []string{"Year 3", "Year 4", "Year 5", "Year 6", "Year 7", "Year 8", "Year 9"}
	sources    = []string{"WeChat referral", "Walk-in", "Google search", "Parent referral", "School flyer"}
)

const demoPassword = "demo1234"

// Run wipes the operational tables and rebuilds demo data from scratch.
func Run(db *gorm.DB, cfg *config.Config) error {
	now := clock.Now()
	fmt.Println("正在写入演示数据 ...")

	return db.Transaction(func(tx *gorm.DB) error {
		if err := wipe(tx); err != nil {
			return err
		}

		hash, err := service.HashPassword(demoPassword)
		if err != nil {
			return err
		}

		// ---- staff ----
		admins, err := makeUsers(tx, model.RoleAdmin, hash, []string{
			"mei.lin", "daniel.wong", "sarah.ng",
		}, []string{"Mei Lin", "Daniel Wong", "Sarah Ng"}, now)
		if err != nil {
			return err
		}
		teachers, err := makeUsers(tx, model.RoleTeacher, hash, []string{
			"zhou.ya", "li.zhe", "tan.wei", "wu.min",
		}, []string{"Zhou Ya", "Li Zhe", "Tan Wei", "Wu Min"}, now)
		if err != nil {
			return err
		}
		for _, t := range teachers {
			if err := tx.Exec("INSERT INTO teacher_profiles (user_id, bio, active) VALUES (?,?,1)",
				t.ID, "Teaching staff").Error; err != nil {
				return err
			}
		}

		// ---- subjects ----
		subjectIDs := make([]uint64, len(subjects))
		for i, name := range subjects {
			s := &model.Subject{Name: name}
			if err := tx.Create(s).Error; err != nil {
				return err
			}
			subjectIDs[i] = s.ID
		}

		// ---- classes: a weekly slot each ----
		type slot struct {
			name     string
			subject  int
			teacher  int
			weekday  int // 1=Mon .. 7=Sun
			start    int
			capacity int
			room     string
		}
		slots := []slot{
			{"Beginner Maths A", 0, 0, 4, 16 * 60, 8, "Room 1"},
			{"Beginner Maths B", 0, 0, 6, 10 * 60, 8, "Room 1"},
			{"AEIS Maths A", 1, 1, 4, 17*60 + 30, 8, "Room 2"},
			{"AEIS Writing A", 2, 1, 2, 17*60 + 30, 8, "Room 2"},
			{"English Oral B", 3, 2, 5, 17*60 + 30, 6, "Room 3"},
			{"Advanced Maths A", 4, 3, 3, 18 * 60, 8, "Room 4"},
			{"Science Intro", 5, 2, 6, 14 * 60, 8, "Lab"},
			{"AEIS Writing B", 2, 1, 6, 14 * 60, 8, "Room 2"},
		}
		classIDs := make([]uint64, len(slots))
		for i, s := range slots {
			end := s.start + 90
			if i%3 == 0 {
				end = s.start + 60
			}
			c := &model.Class{
				Name: s.name, SubjectID: subjectIDs[s.subject], TeacherID: teachers[s.teacher].ID,
				Weekday: s.weekday, StartMin: s.start, EndMin: end,
				Capacity: s.capacity, Room: s.room, Status: "active",
				CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(c).Error; err != nil {
				return err
			}
			classIDs[i] = c.ID
		}

		// ---- students: 3 admins, ~37 each, so an admin really does have
		// a caseload nobody can memorise ----
		type madeStudent struct {
			ID       uint64
			FullName string
			OwnerIdx int
			UserID   uint64
			// Status is carried along so that the demo-consultant block
			// further down can pick its sample students by what they are,
			// instead of by where they happen to sit in this slice.
			Status model.StudentStatus
		}
		students := []madeStudent{}

		// One fully-scripted household so the demo has a known-good path.
		heroUser, err := makeUsers(tx, model.RoleStudent, hash, []string{"parent.zhao"}, []string{"Zhao Min"}, now)
		if err != nil {
			return err
		}
		hero := &model.Student{
			OwnerAdminID: &admins[0].ID, UserID: &heroUser[0].ID,
			FullName: "Zhao, Nina", PreferredName: "Nina", YearLevel: "Year 6",
			Status: model.StudentActive, Source: "WeChat referral",
			CreatedAt: now.AddDate(0, -4, 0), UpdatedAt: now,
		}
		if err := tx.Create(hero).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO guardians (student_id, name, phone, email, relationship, is_primary)
			VALUES (?,?,?,?,?,1)`, hero.ID, "Zhao Min", "0412 000 337", "zhaomin@example.com", "mother").Error; err != nil {
			return err
		}
		students = append(students, madeStudent{hero.ID, hero.FullName, 0, heroUser[0].ID, hero.Status})

		counter := 0
		for a := 0; a < len(admins); a++ {
			for n := 0; n < 12; n++ {
				counter++
				var fn, gender string
				if counter%2 == 0 {
					fn = firstNamesF[counter%len(firstNamesF)]
					gender = "F"
				} else {
					fn = firstNamesM[counter%len(firstNamesM)]
					gender = "M"
				}
				ln := surnames[counter%len(surnames)]
				status := model.StudentActive
				switch {
				case counter%9 == 0:
					status = model.StudentLead
				case counter%7 == 0:
					status = model.StudentTrial
				case counter%13 == 0:
					status = model.StudentChurned
				}
				// give students from admin[0] a household login only in a
				// few cases; most are managed on the family's behalf
				var uid *uint64
				if counter%5 == 0 {
					uname := fmt.Sprintf("parent.%s%d", ln, counter)
					us, err := makeUsers(tx, model.RoleStudent, hash, []string{uname},
						[]string{ln + " family"}, now)
					if err != nil {
						return err
					}
					uid = &us[0].ID
				}
				st := &model.Student{
					OwnerAdminID:  &admins[a].ID,
					UserID:        uid,
					FullName:      fmt.Sprintf("%s, %s", ln, fn),
					PreferredName: fn,
					YearLevel:     yearLevels[counter%len(yearLevels)],
					Status:        status,
					Source:        sources[counter%len(sources)],
					CreatedAt:     now.AddDate(0, 0, -counter*3),
					UpdatedAt:     now,
				}
				if err := tx.Create(st).Error; err != nil {
					return err
				}
				_ = gender
				_ = tx.Exec(`INSERT INTO guardians (student_id, name, phone, relationship, is_primary)
					VALUES (?,?,?,?,1)`, st.ID, ln+" parent",
					fmt.Sprintf("04%02d %03d %03d", counter%100, counter%1000, (counter*7)%1000), "parent").Error
				students = append(students, madeStudent{st.ID, st.FullName, a, 0, status})
			}
		}

		credit := &service.CreditService{}

		// ---- packages + opening ledger entries ----
		for i, s := range students {
			// No package before the family has bought in: a lead has not
			// even trialled yet and a trial-stage student is still trying,
			// so neither has paid anything. Packaging them paints a
			// prospect as a paying customer in three places at once - the
			// balance column, the R6 renewal queue and the class roster.
			//
			// 'churned' is deliberately left alone: those families did pay,
			// and their packages, ledger and attendance are history that
			// has to stay true.
			//
			// The size comes from packageSizeFor, keyed on the loop index
			// rather than on a count of the students who survive the filter,
			// so everyone keeps the package size their position has always
			// produced. See that function for why the distinction matters.
			if s.Status == model.StudentLead || s.Status == model.StudentTrial {
				continue
			}
			pkgSize := packageSizeFor(i)
			p := &model.CreditPackage{
				StudentID:          s.ID,
				Name:               fmt.Sprintf("%d-credit package", pkgSize),
				TotalCredits:       pkgSize,
				PriceCents:         int64(pkgSize) * 8500,
				PurchasedByAdminID: admins[s.OwnerIdx].ID,
			}
			// Purchases are historical, so write them with a backdated
			// timestamp rather than "now".
			if err := credit.Purchase(tx, admins[s.OwnerIdx].ID, p); err != nil {
				return err
			}
			if err := tx.Exec("UPDATE credit_ledger SET created_at = ? WHERE package_id = ?",
				now.AddDate(0, 0, -(20+i%30)), p.ID).Error; err != nil {
				return err
			}
		}

		// ---- lessons for the last 3 weeks and the next 2 ----
		type madeLesson struct {
			ID       uint64
			ClassIdx int
			Date     time.Time
		}
		lessons := []madeLesson{}
		for d := -21; d <= 13; d++ {
			day := now.AddDate(0, 0, d)
			wd := int(day.Weekday())
			if wd == 0 {
				wd = 7
			}
			for ci, s := range slots {
				if s.weekday != wd {
					continue
				}
				date := day.Format("2006-01-02")
				res := tx.Exec(`INSERT IGNORE INTO lessons
					(class_id, teacher_id, lesson_date, weekday, start_min, end_min, status, created_at, updated_at)
					VALUES (?,?,?,?,?,?,'scheduled',?,?)`,
					classIDs[ci], teachers[s.teacher].ID, date, s.weekday, s.start, s.start+90, now, now)
				if res.Error != nil {
					return res.Error
				}
				var lid uint64
				if err := tx.Raw("SELECT id FROM lessons WHERE class_id=? AND lesson_date=?",
					classIDs[ci], date).Scan(&lid).Error; err != nil {
					return err
				}
				if lid != 0 {
					lessons = append(lessons, madeLesson{lid, ci, day})
				}
			}
		}

		// ---- enrolments: only students with credits, spread over classes ----
		enrolled := map[string]bool{}
		enrolCount := map[int]int{}
		for si, s := range students {
			if si%7 == 3 {
				continue // some students are not yet placed
			}
			// No package, no timetable: a student who has not bought in is
			// not enrolled in a weekly class. A trial runs through the
			// trials table, not through the class roster, so a lead or a
			// trial-stage student here would sit on a roster for lessons
			// nobody has agreed to pay for.
			if s.Status == model.StudentLead || s.Status == model.StudentTrial {
				continue
			}
			// two classes for some students, to prove a student may be in
			// more than one class as long as the times differ
			picks := []int{si % len(slots)}
			if si%4 == 0 {
				picks = append(picks, (si+3)%len(slots))
			}
			for _, ci := range picks {
				sl := slots[ci]
				if enrolled[fmt.Sprintf("%d-%d", ci, s.ID)] {
					continue
				}
				if enrolCount[ci] >= sl.capacity {
					continue
				}
				// two classes at the same weekday+start would violate
				// uq_student_slot, so skip those combinations
				key := fmt.Sprintf("%d-%d-%d", s.ID, sl.weekday, sl.start)
				if enrolled[key] {
					continue
				}
				enrolled[fmt.Sprintf("%d-%d", ci, s.ID)] = true
				enrolled[key] = true
				enrolCount[ci]++
				if err := tx.Exec(`INSERT IGNORE INTO class_enrollments
					(class_id, student_id, weekday, start_min, status, enrolled_on)
					VALUES (?,?,?,?,'active',?)`,
					classIDs[ci], s.ID, sl.weekday, sl.start, now.AddDate(0, 0, -14+si%10)).Error; err != nil {
					return err
				}
			}
		}

		// ---- attendance + consume ledger for past lessons ----
		attSeq := 0
		noteSeq := 0
		// Who owns each student, so a follow-up can be signed by the
		// consultant who would actually have made the call.
		ownerIdx := map[uint64]int{}
		for _, s := range students {
			ownerIdx[s.ID] = s.OwnerIdx
		}
		// (student, template) pairs that have already produced a follow-up.
		parentUpdateSeen := map[uint64]map[int]bool{}
		for _, l := range lessons {
			if l.Date.After(now) {
				continue
			}
			var roster []uint64
			if err := tx.Raw(`SELECT student_id FROM class_enrollments
				WHERE class_id=? AND status='active'`, classIDs[l.ClassIdx]).Scan(&roster).Error; err != nil {
				return err
			}
			for _, sid := range roster {
				attSeq++
				status := model.AttPresent
				switch {
				case attSeq%11 == 0:
					status = model.AttAbsent
				case attSeq%5 == 0:
					status = model.AttLate
				}
				actor := teachers[slots[l.ClassIdx].teacher].ID
				// A remark only on a mark that means the student was in the
				// room. Note that status.Charges() is NOT that test: it is
				// also true for 'absent', because a no-show still burns a
				// credit. "How the lesson went" has no referent for a child
				// who was not there, so the status is spelled out instead.
				//
				// The column stays NULL rather than empty for everyone else,
				// because every reader filters on note <> '' and an empty
				// string would look like a row that was written and left
				// blank.
				//
				// Indexed by noteSeq rather than attSeq: notes land on every
				// other eligible row, so attSeq%len would step through the
				// pool in twos, land on the same few templates, and leave
				// the negative ones almost unused.
				//
				// Every other row rather than every third: the eligible set
				// is smaller than "charged marks" suggests, because absent
				// rows are excluded above, and one-in-three landed on
				// exactly 30 notes - the floor reportStates enforces. A gate
				// that the seed satisfies by zero is not a gate. One-in-two
				// leaves real headroom and spreads feedback over more
				// students, which is what the drawer and the renewal card
				// both need.
				note := ""
				if (status == model.AttPresent || status == model.AttLate) && attSeq%2 == 0 {
					tn := teacherNotes[noteSeq%len(teacherNotes)]
					note = tn.Internal
					// The remark and the consultant's response are generated
					// together, so the follow-up is written here, next to the
					// lesson that caused it.
					//
					// Dates come off the lesson, never off `now`: these are
					// history, and the overdue SLA on the workbench is
					// computed from due_at. Anchoring them to `now` would
					// make a three-week-old conversation look like it just
					// happened.
					//
					// Written at most once per (student, template): noteSeq
					// cycles, so a student with a long attendance history hits
					// the same template repeatedly, and two identical
					// "we spoke to your family" lines on one screen read as a
					// bug rather than as two conversations.
					if tn.Handled != nil && !parentUpdateSeen[sid][noteSeq%len(teacherNotes)] {
						if parentUpdateSeen[sid] == nil {
							parentUpdateSeen[sid] = map[int]bool{}
						}
						parentUpdateSeen[sid][noteSeq%len(teacherNotes)] = true
						h := tn.Handled
						// source 写成字面量而不是绑定参数：这一支写出的每一行都
						// 来自老师的课堂记录（顾问已经跟家长说过了），来源是语句
						// 的一部分，不是数据。
						if err := tx.Exec(`INSERT INTO follow_ups
							(student_id, trial_id, source, due_at, status, completed_at,
							 completed_by_user_id, note, parent_note, parent_note_at,
							 parent_note_by_user_id, created_at)
							VALUES (?,NULL,'teacher_note',?,?,?,?,?,?,?,?,?)`,
							sid, l.Date.AddDate(0, 0, 2), "done", l.Date.AddDate(0, 0, 1),
							admins[ownerIdx[sid]].ID, h.Consult, h.Parent,
							l.Date.AddDate(0, 0, 1), admins[ownerIdx[sid]].ID,
							l.Date.AddDate(0, 0, 1)).Error; err != nil {
							return err
						}
					}
					// 老师勾了「需要顾问跟进」、顾问**还没**处理：这三条备注
					// （teacherNotes 末尾三条）就是旗标的来源，写下的是一条
					// pending 待办，而不是上面那种已经闭环的记录。
					//
					// 去重与上面共用同一张 parentUpdateSeen[sid][模板下标]：
					// noteSeq 会循环，同一 (学生, 模板) 只写一次，不去重会让同一屏
					// 出现两条一模一样的待办，读起来像 bug 而不像两次对话。两个分支
					// 不会同时命中同一格 —— Flagged 与 Handled 互斥（见 teacherNote）。
					//
					// due_at / created_at 都从 l.Date 推算，绝不用 now：:394-398
					// 已把理由写全了（这些是历史，锚到 now 会让三周前的对话看起来像
					// 刚刚发生）。标记时刻就是老师写下这条备注的那节课，+48h 与 R2
					// 的试听跟进是同一个 SLA。
					if tn.Flagged && !parentUpdateSeen[sid][noteSeq%len(teacherNotes)] {
						if parentUpdateSeen[sid] == nil {
							parentUpdateSeen[sid] = map[int]bool{}
						}
						parentUpdateSeen[sid][noteSeq%len(teacherNotes)] = true
						if err := tx.Exec(`INSERT INTO follow_ups
							(student_id, trial_id, source, due_at, status, created_at)
							VALUES (?, NULL, 'teacher_note', ?, 'pending', ?)`,
							sid, l.Date.AddDate(0, 0, 2), l.Date.Add(90*time.Minute)).Error; err != nil {
							return err
						}
					}
					noteSeq++
				}
				res := tx.Exec(`INSERT IGNORE INTO attendances
					(lesson_id, student_id, status, source, recorded_by_user_id, recorded_at, note)
					VALUES (?,?,?,'teacher_override',?,?,NULLIF(?, ''))`,
					l.ID, sid, status, actor, l.Date.Add(90*time.Minute), note)
				if res.Error != nil {
					return res.Error
				}
				var attID uint64
				if err := tx.Raw("SELECT id FROM attendances WHERE lesson_id=? AND student_id=?",
					l.ID, sid).Scan(&attID).Error; err != nil {
					return err
				}
				if status.Charges() {
					if err := credit.Apply(tx, &model.CreditLedger{
						StudentID:    sid,
						Delta:        -1,
						Reason:       model.ReasonConsume,
						LessonID:     &l.ID,
						AttendanceID: &attID,
						ActorUserID:  actor,
						Note:         string(status),
					}); err != nil {
						return err
					}
					// backdate to the lesson date so the ledger reads as history
					_ = tx.Exec("UPDATE credit_ledger SET created_at=? WHERE attendance_id=?", l.Date.Add(90*time.Minute), attID)
				}
			}
			if !l.Date.After(now) {
				_ = tx.Exec("UPDATE lessons SET status='completed' WHERE id=? AND lesson_date < ?",
					l.ID, now.Format("2006-01-02"))
			}
		}

		// ---- trials, with follow-ups that are genuinely overdue ----
		trialPlan := []struct {
			goesBackDays int
			outcome      string
			followedUp   bool
		}{
			{4, "lost", false},
			{3, "converted", false},
			{2, "lost", false},
			{1, "converted", true},
			{6, "converted", true},
			{5, "lost", false},
		}
		for i, plan := range trialPlan {
			idx := (i*5 + 1) % len(students)
			st := students[idx]
			teacherID := teachers[i%len(teachers)].ID
			subjID := subjectIDs[i%len(subjectIDs)]
			scheduled := now.AddDate(0, 0, -plan.goesBackDays).Add(-2 * time.Hour)
			t := &model.Trial{
				StudentID: st.ID, SubjectID: subjID, TeacherID: &teacherID,
				ScheduledAt: scheduled, DurationMin: 60,
				Outcome: plan.outcome, OutcomeNote: trialNote(plan.outcome),
				CreatedAt: scheduled.AddDate(0, 0, -2), UpdatedAt: scheduled.Add(2 * time.Hour),
			}
			if err := tx.Create(t).Error; err != nil {
				return err
			}
			note := "Trial booked from " + sources[i%len(sources)]
			_ = tx.Exec("UPDATE trials SET outcome_note=? WHERE id=?", note, t.ID)
			if err := promoteForTrial(tx, now, st.ID, plan.outcome); err != nil {
				return err
			}
			// A conversion is a sale, so the account opens with it. The
			// packages block above decided from the status snapshot taken
			// before this loop ran, so a student who was still 'trial' back
			// then was skipped there and is promoted to 'active' just above.
			// Left alone they become the one 'active' row with no account:
			// sitting in the low-credit queue with nothing to renew and
			// reading as a student who attends classes without ever paying.
			if plan.outcome == "converted" {
				if err := openAccountForConversion(tx, credit, admins[st.OwnerIdx].ID,
					st.ID, packageSizeFor(idx), scheduled); err != nil {
					return err
				}
			}

			dueAt := scheduled.Add(48 * time.Hour)
			fu := &model.FollowUp{
				StudentID: st.ID, TrialID: &t.ID, DueAt: dueAt,
				Status: "pending", CreatedAt: scheduled.Add(2 * time.Hour),
				// 来源显式写出，不吃列的 DEFAULT 'trial'。默认值住在另一个文件里
				// （migrations/000004_followup_source.up.sql:11-24）：写路径依赖它，
				// 就等于依赖一个可以被改掉、被后续迁移重建、而编译器与约束都不会
				// 察觉到它搬走了的值。seed 这一头是试听转化，所以是 'trial'。
				Source: "trial",
			}
			if plan.followedUp {
				fu.Status = "done"
				done := dueAt.Add(-3 * time.Hour)
				fu.CompletedAt = &done
				fu.CompletedByUserID = &admins[st.OwnerIdx].ID
				fu.Note = "Called the family; agreed to decide after the weekend."
			}
			if err := tx.Create(fu).Error; err != nil {
				return err
			}
			if err := tx.Exec("UPDATE follow_ups SET due_at=?, created_at=? WHERE id=?",
				dueAt, scheduled.Add(2*time.Hour), fu.ID).Error; err != nil {
				return err
			}
		}

		// ---- trials still in the diary ----
		//
		// Every trial above is history, but the admin workbench reads
		// `scheduled_at >= now` for its trials queue. Without this block
		// that whole panel renders empty, which reads as a broken feature
		// rather than as a quiet week - the same trap the low-credit block
		// below exists to avoid. So the upcoming state is constructed too.
		//
		// R1 ("one trial per student per subject") is a unique key,
		// uq_trial_once, so these must sit on student/subject pairs the
		// history above did not already claim. It used student indices
		// {1,6,11,16,21,26}; the indices below are disjoint from those, so
		// no pair can collide no matter which subject is attached.
		//
		// The first three belong to admins[0] - the demo login - so the
		// workbench is never empty for the account a reviewer will use.
		upcoming := []struct {
			studentIdx int
			subjectIdx int
			inDays     int
			startMin   int // minutes past midnight, Melbourne wall clock
		}{
			{3, 4, 1, 16 * 60},
			{8, 0, 2, 10 * 60},
			{12, 2, 1, 17 * 60},
			{14, 5, 1, 15 * 60},
			{23, 1, 3, 11 * 60},
			{28, 3, 2, 14 * 60},
		}
		for i, plan := range upcoming {
			st := students[plan.studentIdx]
			teacherID := teachers[(plan.subjectIdx+i)%len(teachers)].ID
			day := now.AddDate(0, 0, plan.inDays)
			// Compose the slot from a date + a wall-clock minute rather
			// than "now + N hours", so the demo always shows a tidy
			// 4:00pm / 10:00am rather than whatever time the seed ran.
			scheduled := time.Date(day.Year(), day.Month(), day.Day(),
				plan.startMin/60, plan.startMin%60, 0, 0, clock.Loc())
			t := &model.Trial{
				StudentID: st.ID, SubjectID: subjectIDs[plan.subjectIdx], TeacherID: &teacherID,
				ScheduledAt: scheduled, DurationMin: 60,
				Outcome: "pending",
				// Booked two days ahead of the slot, like a real booking.
				CreatedAt: scheduled.AddDate(0, 0, -2), UpdatedAt: now,
			}
			if err := tx.Create(t).Error; err != nil {
				return err
			}
			note := "Trial booked from " + sources[i%len(sources)]
			_ = tx.Exec("UPDATE trials SET outcome_note=? WHERE id=?", note, t.ID)
			// Still pending, so only the booking hop applies.
			if err := promoteForTrial(tx, now, st.ID, "pending"); err != nil {
				return err
			}

			// The follow-up is created at booking time and falls due 48h
			// after the trial, so it is pending but not yet overdue. That
			// keeps the workbench's two headline numbers distinct: a
			// pending backlog is not the same thing as a missed SLA.
			fu := &model.FollowUp{
				StudentID: st.ID, TrialID: &t.ID, DueAt: scheduled.Add(48 * time.Hour),
				Status: "pending", CreatedAt: now,
				// 同上：来源显式写死，不依赖迁移里的 DEFAULT 'trial'。
				Source: "trial",
			}
			if err := tx.Create(fu).Error; err != nil {
				return err
			}
		}

		// ---- fill the demo consultant's trial board ----
		//
		// The two blocks above leave the demo login (mei.lin) with six
		// trials. That is enough to prove the wires are connected, but not
		// enough to look like a queue anyone works: 线索与试听 has one tab
		// per outcome, and a tab holding a single card reads as a broken
		// filter rather than as a quiet week. So each outcome is topped up
		// to ten.
		//
		// Two things decide which pairs are used:
		//
		//  1. R1 is a materialised unique key (uq_trial_once on
		//     student_id + subject_id), so the pairs must avoid whatever
		//     the blocks above already claimed. The database is asked
		//     rather than the arithmetic repeated, because "which pairs
		//     did those blocks happen to use" is exactly the derivation
		//     that goes stale the next time one of them is edited.
		//
		//  2. The pool is the 'active' students, and that is what keeps the
		//     roster believable afterwards. mei.lin has exactly one 'lead'
		//     and one 'trial' student - the two samples the student list
		//     shows as 线索 and 已约试听. A trial on the 'lead' one replays
		//     lead -> trial, and a *converted* trial on the 'trial' one
		//     replays trial -> active (promoteForTrial). Either hop moves
		//     the sample out of the stage that names it, so the row leaves
		//     the list for good - a 线索 that already booked is not a lead
		//     any more, and a family that already converted is not waiting
		//     to try a lesson. Keeping stage-1/2 students out of the 'lost'
		//     and 'converted' buckets is what stops that.
		//
		//     The test is the student's status, not their position in this
		//     slice. It used to be "index 7 and 9", which held only as long
		//     as nobody was ever inserted into the roster: a position
		//     identifies the two samples by an accident of ordering, so
		//     inserting one student in the middle moves both of them and
		//     nothing complains. The silent part is what makes it worth
		//     carrying the field: promoteForTrial would still complete its
		//     hops, and both reportStates invariants (convertedStillProspect,
		//     bookedStillLead) would still read 0. The only symptom would be
		//     a student list with no 线索 and no 已约试听 row - no error
		//     anywhere, just a quietly less believable snapshot.
		//
		//     Hero (index 0) is 'active', so it stays eligible exactly as
		//     before. The exclusion is deliberate, not an oversight.
		//
		// The eleven students above are cycled through, each with a subject
		// cursor that persists across the three outcomes, so one student's
		// three trials land on three different subjects.
		const demoPerOutcome = 10
		demo := []madeStudent{}
		for _, s := range students {
			if s.OwnerIdx != 0 || s.Status == model.StudentLead || s.Status == model.StudentTrial {
				continue
			}
			demo = append(demo, s)
		}

		// pending (待记录结果) is the one tab that also draws on the 'trial'
		// sample, and that is the whole point of the tab: a 首次试听 -
		// booked, result not recorded yet - is what a booking queue exists
		// to show. Without one, all ten rows belong to students who are
		// already 在读, and the tab reads as a list of re-tries for
		// converted families rather than as work waiting to be done.
		//
		// A 'trial'-stage student is safe here and unsafe in the other two
		// buckets, and promoteForTrial is the whole reason: it replays a hop
		// only for 'lead' (guarded by WHERE status='lead') and for
		// 'converted' (it returns early for every other outcome). A pending
		// row therefore leaves the student exactly where the booking put
		// them - still 已约试听. The blanket exclusion above wants that same
		// invariant, but it over-reaches: 'converted' is the only outcome
		// that can turn the 已约试听 sample 'active', so only 'lost' and
		// 'converted' need the narrower pool.
		//
		// The sample is listed once per pending row it should carry. The
		// loop below hands out one row per pool entry per pass, and this
		// pool is larger than the ten-row budget, so it only ever gets one
		// pass: entries past the tenth are never reached at all. Listed
		// once the sample would get a single row, and a single row is
		// indistinguishable from an accident of ordering - the one thing
		// this sample must not look like. Listing it twice also keeps the
		// cursor below honest: two entries for one student must still land
		// on two different subjects.
		const pendingRowsPerTrialSample = 2
		pendingPool := []madeStudent{}
		for _, s := range students {
			if s.OwnerIdx != 0 || s.Status != model.StudentTrial {
				continue
			}
			for i := 0; i < pendingRowsPerTrialSample; i++ {
				pendingPool = append(pendingPool, s)
			}
		}
		pendingPool = append(pendingPool, demo...)
		taken := map[[2]uint64]bool{}
		{
			var used []struct{ StudentID, SubjectID uint64 }
			if err := tx.Raw("SELECT student_id, subject_id FROM trials").Scan(&used).Error; err != nil {
				return err
			}
			for _, u := range used {
				taken[[2]uint64{u.StudentID, u.SubjectID}] = true
			}
		}
		// Keyed by student id, not by position in a pool. A positional
		// cursor assumes a student appears in exactly one pool at exactly
		// one index, and the pending pool above breaks both halves of that:
		// its 'trial' sample is absent from `demo` altogether and is listed
		// twice in `pendingPool`. Two parallel cursor slices would answer
		// the first half and silently misalign on the second - the sample's
		// two rows would share one subject and the second would be lost to
		// R1. Keyed by id, "which subjects has this student already tried"
		// is the same answer whichever pool asks, so a student's three rows
		// still land on three different subjects.
		subjCursor := map[uint64]int{}
		// Tidy wall-clock slots, the same shape the block above uses: the
		// demo should show 4:00pm, not the minute the seed happened to run.
		demoSlots := []int{16 * 60, 10 * 60, 17 * 60, 15 * 60, 11 * 60, 14 * 60}
		demoSeq := 0
		for oi, outcome := range []string{"lost", "converted", "pending"} {
			// Only pending draws on the wider pool; see the block above.
			pool := demo
			if outcome == "pending" {
				pool = pendingPool
			}
			placed := 0
			for placed < demoPerOutcome {
				progressed := false
				for si, st := range pool {
					if placed == demoPerOutcome {
						break
					}
					// First subject this student has not already tried.
					ci := -1
					for subjCursor[st.ID] < len(subjectIDs) {
						c := subjCursor[st.ID]
						subjCursor[st.ID]++
						if !taken[[2]uint64{st.ID, subjectIDs[c]}] {
							ci = c
							break
						}
					}
					if ci < 0 {
						continue // all six subjects used for this student
					}
					progressed = true
					taken[[2]uint64{st.ID, subjectIDs[ci]}] = true

					seq := demoSeq
					demoSeq++
					slot := demoSlots[seq%len(demoSlots)]
					day := now.AddDate(0, 0, 1+seq%9) // pending: 1..9 days out
					if outcome != "pending" {
						day = now.AddDate(0, 0, -(3 + seq%12)) // history: 3..14 days back
					}
					scheduled := time.Date(day.Year(), day.Month(), day.Day(),
						slot/60, slot%60, 0, 0, clock.Loc())
					teacherID := teachers[(si+oi+seq)%len(teachers)].ID
					// The blocks above store the booking note in outcome_note
					// (the outcome wording is overwritten straight after the
					// insert), so this writes that same value once.
					t := &model.Trial{
						StudentID: st.ID, SubjectID: subjectIDs[ci], TeacherID: &teacherID,
						ScheduledAt: scheduled, DurationMin: 60,
						Outcome:     outcome,
						OutcomeNote: "Trial booked from " + sources[seq%len(sources)],
						// Booked two days ahead of the slot, like a real booking.
						CreatedAt: scheduled.AddDate(0, 0, -2),
						UpdatedAt: now,
					}
					if outcome != "pending" {
						t.UpdatedAt = scheduled.Add(2 * time.Hour)
					}
					if err := tx.Create(t).Error; err != nil {
						return err
					}
					if err := promoteForTrial(tx, now, st.ID, outcome); err != nil {
						return err
					}

					// R2: recording an outcome starts the 48h clock, so
					// every trial carries a follow-up. The historical ones
					// fall due in the past, i.e. straight into the overdue
					// queue; every third is closed instead, which gives the
					// done filter samples while leaving the overdue count
					// far above the guard in reportStates.
					dueAt := scheduled.Add(48 * time.Hour)
					fu := &model.FollowUp{
						StudentID: st.ID, TrialID: &t.ID, DueAt: dueAt,
						Status: "pending", CreatedAt: now,
						// 同上：来源显式写死，不依赖迁移里的 DEFAULT 'trial'。
						Source: "trial",
					}
					if outcome != "pending" {
						fu.CreatedAt = scheduled.Add(2 * time.Hour)
						if seq%3 == 0 {
							fu.Status = "done"
							done := dueAt.Add(-3 * time.Hour)
							fu.CompletedAt = &done
							fu.CompletedByUserID = &admins[st.OwnerIdx].ID
							fu.Note = "Called the family; agreed to decide after the weekend."
						}
					}
					if err := tx.Create(fu).Error; err != nil {
						return err
					}
					placed++
				}
				if !progressed {
					return fmt.Errorf("could not place %d %q trials for the demo consultant; "+
						"its 线索与试听 tabs would stay nearly empty", demoPerOutcome, outcome)
				}
			}
		}

		// ---- trials that already ran but whose result was never recorded ----
		//
		// The pending block above places every 待记录结果 row one to nine days
		// *ahead* of now, so none of them has been taught yet. On a real
		// Tuesday morning the first thing a consultant clears in that tab is
		// the opposite: yesterday's (or last week's) lesson that nobody
		// graded. Without one, that tab's first screen is entirely future
		// bookings, and the "已结束" marker its rows now carry never renders
		// - a feature sitting on screen looking broken, which is the same
		// trap the low-credit and upcoming-trials blocks above exist to
		// avoid.
		//
		// These rows deliberately get **no follow-up**. R2 creates one on
		// SetOutcome, and the defining fact about this state is that
		// SetOutcome never happened. Writing one here would put a 48h task on
		// a trial nobody has judged - claiming the consultant owes a call
		// they have not qualified for, and quietly double-counting a visit
		// that is already in the 待记录结果 tab.
		//
		// Four rows, so the marker shows both of its wordings: hours for the
		// one from this morning, days for the older three. Spread over four
		// students, because one student holding four ungraded trials reads
		// as a broken family rather than as a backlog.
		//
		// The morning row is anchored to the run time (now - 3h, floored to
		// the hour) instead of a tidy slot like the 16:00 used below: a
		// same-day lesson cannot be both tidy and certainly over. Flooring
		// to the hour still lands on :00 locally, because Melbourne's offset
		// is a whole number of hours in both AEST and AEDT.
		endedSchedules := []time.Time{now.Truncate(time.Hour).Add(-3 * time.Hour)}
		for _, back := range []int{1, 3, 6} {
			d := now.AddDate(0, 0, -back)
			endedSchedules = append(endedSchedules, time.Date(d.Year(), d.Month(), d.Day(),
				16, 0, 0, 0, clock.Loc()))
		}
		for i, scheduled := range endedSchedules {
			st := demo[i%len(demo)]
			// Same first-free-subject walk the demo board uses, so R1
			// (uq_trial_once) cannot be violated by reusing a pair.
			ci := -1
			for subjCursor[st.ID] < len(subjectIDs) {
				c := subjCursor[st.ID]
				subjCursor[st.ID]++
				if !taken[[2]uint64{st.ID, subjectIDs[c]}] {
					ci = c
					break
				}
			}
			if ci < 0 {
				return fmt.Errorf("could not place trial #%d that already ran with no recorded outcome; "+
					"the top of the 待记录结果 tab would be empty", i)
			}
			taken[[2]uint64{st.ID, subjectIDs[ci]}] = true
			teacherID := teachers[i%len(teachers)].ID
			t := &model.Trial{
				StudentID: st.ID, SubjectID: subjectIDs[ci], TeacherID: &teacherID,
				ScheduledAt: scheduled, DurationMin: 60,
				Outcome:     "pending",
				OutcomeNote: "Trial booked from " + sources[i%len(sources)],
				CreatedAt:   scheduled.AddDate(0, 0, -2),
				UpdatedAt:   scheduled.Add(time.Hour),
			}
			if err := tx.Create(t).Error; err != nil {
				return err
			}
			// Still pending, so only the booking hop applies - and every
			// student in `demo` is 'active', where promoteForTrial is a
			// no-op. Called anyway to keep this path identical to the one
			// real bookings take.
			if err := promoteForTrial(tx, now, st.ID, "pending"); err != nil {
				return err
			}
		}

		// ---- one approved leave on a future lesson, so the teacher's
		// roster shows the prefilled read-only state ----
		//
		// It has to sit on a lesson taught by teachers[0], because that is
		// the teacher login the demo uses and the roster endpoint refuses
		// another teacher's lesson with 403 - correctly so. Picking the
		// first future lesson instead put the leave on wu.min's class,
		// which made the prefilled state unreachable by anyone following
		// the README. The precondition is therefore explicit, and the
		// loop reports failure rather than quietly seeding nothing.
		leaveSeeded := false
		for _, l := range lessons {
			if !l.Date.After(now) {
				continue
			}
			if slots[l.ClassIdx].teacher != 0 {
				continue
			}
			var sid uint64
			if err := tx.Raw(`SELECT student_id FROM class_enrollments
				WHERE class_id=? AND status='active' LIMIT 1`, classIDs[l.ClassIdx]).Scan(&sid).Error; err != nil {
				return err
			}
			if sid == 0 {
				continue
			}
			start := l.Date.Add(time.Duration(slots[l.ClassIdx].start) * time.Minute)
			hours := int(start.Sub(now).Hours())
			// R4: leave notice of 24h or more is approved and does not
			// consume credit. Under 25h there is no headroom for a demo,
			// so skip and try the next slot.
			if hours < 25 {
				continue
			}
			if err := tx.Exec(`INSERT IGNORE INTO leave_requests
				(lesson_id, student_id, requested_by_user_id, requested_at, reason, resolution, hours_before_start, created_at)
				VALUES (?,?,?,?,?,?,?,?)`,
				l.ID, sid, admins[0].ID, now, "Family travel",
				"approved_ge_24h", hours, now).Error; err != nil {
				return err
			}
			leaveSeeded = true
			break
		}
		if !leaveSeeded {
			return fmt.Errorf("seed produced no approved leave on teachers[0]'s future lessons; " +
				"the roster prefill state would be unreachable from the demo teacher login")
		}

		// ---- drain a slice of students to the low-credit threshold ----
		//
		// R6 (low-credit warning) is one of the three queues the admin
		// workbench is built around. Left to chance the seed never triggers
		// it: every package is far larger than the handful of lessons we
		// generate, so nobody ever runs low — and an empty queue reads as a
		// broken feature rather than as a quiet week. The state is therefore
		// constructed deliberately.
		for i, s := range students {
			if i%6 != 0 {
				continue
			}
			// Drain 'active' students only. Both reportStates below and
			// /students?low_credit=1 define this queue as status='active',
			// so draining a lead or a trial-stage student is precisely what
			// made those two numbers disagree - the inconsistency this
			// change exists to remove. It is also self-guarding in the
			// other direction: a student with no package sums to 0, which
			// the next check skips, so nobody is ever drained below zero.
			if s.Status != model.StudentActive {
				continue
			}
			var bal int
			if err := tx.Raw("SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id = ?", s.ID).
				Scan(&bal).Error; err != nil {
				return err
			}
			target := cfg.Thresholds.LowCreditThreshold - 2
			if target < 1 {
				target = 1
			}
			if bal <= target {
				continue
			}
			// Append-only, like every other credit movement: we add the usage
			// the previous term would have produced rather than rewriting the
			// purchase entry. delta is non-zero by construction.
			if err := tx.Exec(`INSERT INTO credit_ledger
				(student_id, delta, reason, actor_user_id, note, created_at)
				VALUES (?,?, 'manual_adjust', ?,?,?)`,
				s.ID, -(bal - target), admins[s.OwnerIdx].ID,
				"term rollover: usage carried from the previous package",
				now.AddDate(0, 0, -9)).Error; err != nil {
				return err
			}
		}

		// ---- leads board: pack the demo consultant's funnel head ----
		//
		// mei.lin's leads tab needs at least ten rows. It is the first hop of
		// the funnel and the only panel that answers "who has not been
		// contacted yet"; three rows there read as "this panel is broken"
		// rather than "we are on top of it" - the same reason the three
		// workbench queues below refuse to be empty, and the same reason the
		// trials board is packed to ten per outcome.
		//
		// Why a separate block instead of widening the status formula above
		// (counter%9 == 0). That counter is load-bearing for three other
		// blocks - packages, class enrolment and trials all pick their
		// students by roster index - so changing the modulus moves every one
		// of them onto different people, while their comments and the
		// assertions in reportStates are written against the current
		// distribution. This block deliberately does NOT append to the
		// students slice, so nothing running after it can shift; the cost is
		// that the student count printed below has to add these rows back.
		//
		// Names are hard-coded rather than drawn from firstNamesM/F and
		// surnames: each pool holds 20 entries and the loop above already
		// consumed indices 1..12, so a modulus slip produces an exact
		// duplicate of a currently-enrolled student. Two people with the same
		// name on one screen is worse than a short list. Repeated surnames
		// (Chen and Yan twice) are intentional - only the full name has to be
		// unique, and real cohorts cluster by surname.
		//
		// daysAgo is an explicit ladder rather than i*N because this value
		// drives three distinct renders in LeadsPage.Prospects.tsx: "今天录入"
		// at 0, neutral up to 6 days, warn from 7. An arithmetic sequence
		// would park most rows in a single tier.
		prospects := []struct {
			surname string
			given   string
			daysAgo int
		}{
			{"Yan", "Chloe", 0},
			{"Zhu", "Marcus", 1},
			{"Deng", "Alice", 2},
			{"Zhou", "Hugo", 3},
			{"Wu", "Bella", 5},
			{"Lin", "Oscar", 6},
			{"Yang", "Nathan", 8},
			{"Chen", "Luna", 11},
			{"Yan", "Toby", 15},
			{"Chen", "Clara", 22},
		}
		for i, p := range prospects {
			lead := &model.Student{
				OwnerAdminID:  &admins[0].ID,
				FullName:      fmt.Sprintf("%s, %s", p.surname, p.given),
				PreferredName: p.given,
				YearLevel:     yearLevels[i%len(yearLevels)],
				Status:        model.StudentLead,
				Source:        sources[i%len(sources)],
				CreatedAt:     now.AddDate(0, 0, -p.daysAgo),
				UpdatedAt:     now,
			}
			// No user_id: a prospect has no household login yet. Everyone in
			// the loop above only got one on counter%5 == 0 for the same
			// reason - the family is still managed on their behalf.
			//
			// No trial either: a lead holding a trial would trip the
			// bookedStillLead assertion in reportStates (the lead -> trial hop
			// would look skipped), and these rows exist precisely to sit in
			// the stage before that hop.
			if err := tx.Create(lead).Error; err != nil {
				return err
			}
			if err := tx.Exec(`INSERT INTO guardians (student_id, name, phone, relationship, is_primary)
				VALUES (?,?,?,?,1)`, lead.ID, p.surname+" parent",
				fmt.Sprintf("04%02d %03d %03d", (i+7)%100, (i+41)%1000, (i*13+5)%1000),
				"parent").Error; err != nil {
				return err
			}
		}

		// ---- verify the headline demo states actually exist ----
		//
		// The summary is projected on screen during the demo, so it is
		// written for a human reading it, in Chinese, and deliberately
		// NOT column-aligned: `%-8s` pads by bytes, and a CJK character
		// occupies two columns in a terminal, so a padded Chinese column
		// shifts every row after it. `label：value` needs no padding and
		// cannot drift.
		fmt.Println("演示数据写入完成")
		fmt.Printf("  admin：3，演示登录 %s / %s\n", "mei.lin", demoPassword)
		fmt.Printf("  老师：4，演示登录 %s / %s\n", "zhou.ya", demoPassword)
		fmt.Printf("  家庭：演示登录 %s / %s（Zhao, Nina）\n", "parent.zhao", demoPassword)
		// len(students) is the roster slice, which the leads block above
		// deliberately stays out of (see its comment). This line reports rows
		// actually written, per README §1.2, so the prospects have to be added
		// back by hand - otherwise the number on screen would disagree with
		// the table.
		fmt.Printf("  学生：%d\n", len(students)+len(prospects))
		fmt.Printf("  班级：%d\n", len(slots))
		fmt.Printf("  课次：%d\n", len(lessons))
		return reportStates(tx, now, cfg)
	})
}

// teacherNote is the two sides of the same event, kept as a pair on purpose.
// Internal is what a teacher types into the roster's remark cell in the
// staffroom - concrete, a little blunt, written for colleagues. Handled is nil
// when that observation never turned into a follow-up, which is the normal
// case rather than a gap: a teacher noticing something and a consultant
// choosing to say something to the family are two separate decisions.
//
// Parent is written by hand, never derived from Internal. A rule that tried to
// soften Internal automatically would either leak staffroom wording or invent
// reassurance nobody actually gave - and it would make "we forgot to say
// anything" indistinguishable from "there was nothing to say". Leaving Parent
// empty is the honest way to say the latter.
//
// There are three mutually exclusive classes, and the demo needs all three:
//   - Handled != nil - the consultant dealt with it and told the family.
//   - Flagged       - the teacher ticked 「需要顾问跟进」 and the consultant
//     has NOT dealt with it yet, which is why there is no Handled to go with
//     it. This is what writes a pending follow_up.
//   - neither       - just a classroom remark, not worth saying anything
//     outside the staffroom.
//
// Writing them as one field instead (say, a status enum) would invite a value
// that means both at once, and the code that turns these into follow_ups would
// then have to guess which row to write.
type teacherNote struct {
	Internal string
	Handled  *teacherNoteHandled
	Flagged  bool
}

type teacherNoteHandled struct {
	Consult string // what the consultant did, internal
	Parent  string // the sentence the family is shown
}

// teacherNotes is the pool of remarks the seed writes onto attendances.note,
// paired with the consultant's response where one happened.
//
// It is the only human-authored text the AI renewal card reads, so it has to
// read like a teacher actually wrote it in the staffroom - concrete and a
// little blunt. Placeholder praise ("performed well") would make the card's
// evidence worthless and never trip the negative-feedback risk factor, which
// is why most of the pool is not praise. Deliberately "most" and not a
// fraction: whether a remark counts as negative is the model's reading of the
// text (feedback_negative, service/ai.go:263), not a keyword match, so any
// number written here is an eyeball count that the next appended entry makes
// stale - which is exactly what had happened to the "a third of the pool"
// this sentence used to carry, once the three classroom flags below were
// added.
//
// A package-level slice, not a function: the attendance loop indexes it with
// a counter, and the order is the demo's script - the negatives sit in the
// middle so a student with a few lessons collects a mix of both. The three
// classroom flags (teacherNote.Flagged, at the end) are appended past that
// middle rather than woven into it, so the twelve entries above keep their
// text and their order and the script's shape is untouched.
var teacherNotes = []teacherNote{
	{Internal: "Picked up the new tenses fast today and asked two good questions.",
		Handled: &teacherNoteHandled{
			Consult: "Rang home with the good news. Tenses have apparently been a sore point all year.",
			Parent:  "A really good lesson today. The new tenses went in quickly and there were two questions asked unprompted - tenses have apparently been a sore point all year, so this felt like a step forward.",
		}},
	{Internal: "Much more confident speaking this week - volunteered answers without being asked."},
	{Internal: "Finished the whole worksheet ahead of the class and helped the student beside her."},
	{Internal: "Good focus today; nailed the fractions questions she could not do last week."},
	{Internal: "Distracted for most of the hour; had to be reminded three times to stay on task.",
		Handled: &teacherNoteHandled{
			Consult: "Called home. School exams are on this week - agreed to keep lessons short and light until Friday.",
			Parent:  "We noticed some restlessness in lessons this week, so I rang home to check in. It sounds like school exams are the cause. We will keep lessons short and light until Friday, then take another look.",
		}},
	{Internal: "Tired and flat again - third lesson in a row with no energy.",
		Handled: &teacherNoteHandled{
			Consult: "Third flat lesson running. Asked home to look at sleep and at how packed the after-school week is.",
			Parent:  "Lessons have been flat three weeks running, which is unusual. I have asked home to take a look at sleep and at how full the after-school week is, and I will come back to you once we know more.",
		}},
	{Internal: "Stuck on the same long-division step again; went back to basics but it has not clicked.",
		Handled: &teacherNoteHandled{
			Consult: "Rebuilt long division from the start. Still not clicking - trying a different method next lesson.",
			Parent:  "Long division is still the sticking point, so this week we went right back to the beginning. It has not clicked yet. Next lesson we will try a different explanation, and I will let you know how it lands.",
		}},
	{Internal: "Said he does not want to come anymore. Worth a call home before next week.",
		Handled: &teacherNoteHandled{
			Consult: "Told me they do not want to come any more. Rang home the same afternoon - no one there knew. Longer chat booked for Thursday.",
			Parent:  "This week the student said they did not want to come to lessons any more, so I rang home the same afternoon. We are sitting down properly on Thursday to work out what is behind it, and I will be in touch straight after that call.",
		}},
	{Internal: "Parent asked whether we can add a second weekly lesson; said I would check availability.",
		Handled: &teacherNoteHandled{
			Consult: "Asked about a second weekly lesson. Thursday has room - held a spot until Monday.",
			Parent:  "You asked about a second lesson each week. There is room on Thursday, and I have held a place for now. I will confirm with you on Monday.",
		}},
	{Internal: "Homework from last week was not done, so we spent the first 15 minutes catching up."},
	{Internal: "Arrived flustered from school, settled after ten minutes and caught up fine."},
	{Internal: "Asked to move to the morning class; flagged it for the office to look at.",
		Handled: &teacherNoteHandled{
			Consult: "Asked to move to the morning group. It is full - put the request on the waitlist and said it could be a few weeks.",
			Parent:  "You asked about moving to the morning class. That group is full at the moment, so the request is on the waitlist - it may be a few weeks. I will let you know as soon as a place comes up.",
		}},
	// 追加三条 Flagged：这三条是顾问侧「需要顾问跟进」队列在演示数据里的
	// 全部来源，所以缺了它们，整区就是空的 —— 而空队列与坏查询在屏幕上一模一样。
	//
	// 立在末尾而不是插在中间有两个理由：上面 12 条是既有演示脚本，一条都不动；
	// 而且 noteSeq 是按池长取模的（:387-388），往中间插会让每个学生手上的备注
	// 整体换位。这三条同样是"负面观察"，与中间那批的语气一致 —— 值得让顾问
	// 拿去打电话的事，本来就不是夸奖。
	{Internal: "Has not brought the workbook for two weeks running - sharing with the student beside her instead.", Flagged: true},
	{Internal: "Says the Saturday class clashes with a new school activity. Family may want to move days.", Flagged: true},
	{Internal: "Told me the school maths teacher is moving faster than us; may be worth a look at her level.", Flagged: true},
}

func trialNote(outcome string) string {
	if outcome == "converted" {
		return "Parent asked about class times; child engaged well."
	}
	return "Child found the pace fast; parent wants to think about it."
}

// packageSizeFor is the package a student would be sold, keyed by their
// position in the roster.
//
// It is a function rather than an inline table because two blocks now need
// the same answer: the opening packages, and the package a conversion opens.
// Keying on the roster index - not on a running count of the students we
// have packaged so far - is deliberate: a count would shift every later
// student's package size by one the first time somebody was skipped, which
// is a change nobody asked for and nothing would report.
func packageSizeFor(idx int) int { return []int{20, 40, 40, 60}[idx%4] }

// openAccountForConversion opens a student's first credit package, dated to
// the day they converted. It is a no-op for anyone who already has one.
//
// The size is passed in rather than derived here: the caller is the only
// place that knows where the student sits in the roster, and the roster
// position is what packageSizeFor keys on.
//
// Only when absent, and that guard is load-bearing in both directions. A
// converted trial on a family that already has an account is a second sale
// we have no reason to invent, and re-billing them would inflate exactly
// the balances the low-credit demo is built out of.
func openAccountForConversion(tx *gorm.DB, credit *service.CreditService,
	adminID, studentID uint64, size int, soldAt time.Time) error {

	var existing int
	if err := tx.Raw("SELECT COUNT(*) FROM credit_packages WHERE student_id = ?", studentID).
		Scan(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}

	p := &model.CreditPackage{
		StudentID:          studentID,
		Name:               fmt.Sprintf("%d-credit package", size),
		TotalCredits:       size,
		PriceCents:         int64(size) * 8500,
		PurchasedByAdminID: adminID,
	}
	if err := credit.Purchase(tx, adminID, p); err != nil {
		return err
	}
	// Purchase stamps both rows with "now", so both are rewritten to the day
	// of the trial that produced this sale. The packages block only backdates
	// its ledger entry, because the opening purchase of a student who has
	// been with us for months has no single true date; a conversion does, so
	// here the row and its opening entry are made to agree rather than left
	// two days' worth of story apart.
	if err := tx.Exec("UPDATE credit_packages SET purchased_at = ? WHERE id = ?",
		soldAt, p.ID).Error; err != nil {
		return err
	}
	return tx.Exec("UPDATE credit_ledger SET created_at = ? WHERE package_id = ?",
		soldAt, p.ID).Error
}

// promoteForTrial replays the student-lifecycle hops that the service layer
// performs, for the trials this file writes directly.
//
// The seed inserts trials with tx.Create instead of going through CreateTrial
// and SetOutcome, so it has to replay what those do to the student:
// CreateTrial performs lead -> trial (service/trial.go:49), and a conversion
// performs trial -> active (service/trial.go). Leaving both out is what let a
// converted trial sit on a student still marked "已约试听" - the snapshot
// contradicted the rule the service enforces at runtime, and at demo time a
// skipped lifecycle hop is indistinguishable from a broken feature.
//
// Both statements are guarded rather than unconditional: a student who has
// already passed the hop is left alone, so a 'churned' student is never
// resurrected and an 'active' one is never rewritten. Any outcome other than
// "converted" - "pending", "lost" - replays only the booking hop, which is
// right because a lost trial leaves the student where the booking put them.
func promoteForTrial(tx *gorm.DB, now time.Time, studentID uint64, outcome string) error {
	if err := tx.Exec("UPDATE students SET status='trial', updated_at=? WHERE id=? AND status='lead'",
		now, studentID).Error; err != nil {
		return err
	}
	if outcome != "converted" {
		return nil
	}
	return tx.Exec("UPDATE students SET status='active', updated_at=? WHERE id=? AND status IN ('lead','trial')",
		now, studentID).Error
}

// reportStates prints the counts the dashboard should show, so a broken
// seed is obvious immediately rather than at demo time.
func reportStates(tx *gorm.DB, now time.Time, cfg *config.Config) error {
	var overdue, lowCredit, todayLessons, upcomingTrials, openLeads, endedPending int
	_ = tx.Raw("SELECT COUNT(*) FROM follow_ups WHERE status='pending' AND due_at < ?", now).Scan(&overdue)
	_ = tx.Raw(`SELECT COUNT(*) FROM students s
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.status='active' AND COALESCE(b.balance,0) <= ?`, cfg.Thresholds.LowCreditThreshold).Scan(&lowCredit)
	_ = tx.Raw("SELECT COUNT(*) FROM lessons WHERE lesson_date = ?", now.Format("2006-01-02")).Scan(&todayLessons)
	_ = tx.Raw("SELECT COUNT(*) FROM trials WHERE scheduled_at >= ?", now).Scan(&upcomingTrials)
	// Trials that have already been taught but whose outcome nobody recorded.
	// The 待记录结果 tab now leads with these, so a zero here means its first
	// screen is missing the one thing the tab exists to show. Scoped to the
	// demo consultant: another consultant holding one does not help the
	// account the demo logs in as.
	_ = tx.Raw(`SELECT COUNT(*) FROM trials t
		JOIN students s ON s.id = t.student_id
		JOIN users u ON u.id = s.owner_admin_id
		WHERE t.outcome='pending'
		  AND t.scheduled_at + INTERVAL t.duration_min MINUTE < ?
		  AND u.username = ?`, now, "mei.lin").Scan(&endedPending)
	// Scoped by username rather than by admins[0]: reportStates only receives
	// the transaction, and reaching back into Run's locals would make this
	// check depend on the order the staff block happens to create users in.
	_ = tx.Raw(`SELECT COUNT(*) FROM students s
		JOIN users u ON u.id = s.owner_admin_id
		WHERE s.deleted_at IS NULL AND s.status = 'lead' AND u.username = ?`, "mei.lin").Scan(&openLeads)
	fmt.Printf("  演示状态：%d 条跟进已逾期，%d 场试听待进行，%d 条试听已结束待记录，%d 名学生课时不足，%d 条线索待跟进，今日 %d 节课\n",
		overdue, upcomingTrials, endedPending, lowCredit, openLeads, todayLessons)

	// Each of these backs a panel on the admin workbench. An empty queue
	// is indistinguishable from a broken query at demo time, so the seed
	// refuses to report success while one is empty.
	if overdue == 0 {
		return fmt.Errorf("seed produced no overdue follow-ups; the admin queue would look empty")
	}
	if upcomingTrials == 0 {
		return fmt.Errorf("seed produced no upcoming trials; the workbench trials panel would look empty")
	}
	if lowCredit == 0 {
		return fmt.Errorf("seed produced no low-credit students; the R6 queue would look empty")
	}
	// The 待记录结果 tab now leads with trials that already finished and
	// whose outcome nobody recorded, so an empty set there puts a "已结束 N
	// 天" marker on screen that never renders - a feature that reads as
	// broken. Same class of failure as the queues above.
	if endedPending == 0 {
		return fmt.Errorf("seed produced no finished-but-unrecorded trials for mei.lin; " +
			"the top of the 待记录结果 tab would be empty")
	}

	// The leads board is the first hop of the funnel and the only panel that
	// answers "who has not been contacted yet". A handful of rows there reads
	// as "this panel is broken" rather than "we are on top of it" - the same
	// failure mode the three queues above are guarded against, and the same
	// reason the trials board is packed to ten per outcome. Hence a floor of
	// a screenful (the leads tab pages at 20, and ten fills a panel) rather
	// than 1.
	if openLeads < 10 {
		return fmt.Errorf("seed produced only %d open lead(s) for mei.lin; "+
			"the leads board needs at least 10 to fill a screen", openLeads)
	}

	// Teacher feedback is the only human-authored text the renewal card
	// reads. With the column empty every card falls back to "No teacher
	// feedback yet" and the negative-feedback risk factor becomes
	// unreachable, so the feature reads as absent - the same "empty queue
	// looks like a broken query" failure the checks above guard against.
	// A floor of 30 is a screenful of the feedback a reviewer might open a
	// drawer to read, and is well under what the density produces.
	var noteCount int
	_ = tx.Raw(`SELECT COUNT(*) FROM attendances
		WHERE source='teacher_override' AND note IS NOT NULL AND note <> ''`).Scan(&noteCount)
	fmt.Printf("  老师备注：%d 条\n", noteCount)
	if noteCount < 30 {
		return fmt.Errorf("seed produced only %d teacher note(s); the renewal cards "+
			"would all read \"No teacher feedback yet\"", noteCount)
	}

	// Parent updates are what the family's own screen shows. An empty
	// 「课堂反馈」 block there is the same ambiguous state as an empty workbench
	// queue: "this family genuinely had nothing said to them" and "the feature
	// was never built" look identical on screen. Hence a floor rather than a
	// non-zero check - a demo that shows one family two updates still proves
	// the pipe exists, but showing no family any of them does not.
	//
	// The row count alone is the wrong measure, though, because /me is read one
	// family at a time: 25 updates concentrated on one student would clear a
	// global floor while every other household still opened onto an empty
	// block. So the floor is checked as coverage too - how many distinct
	// students carry at least one update - and it is that second number which
	// actually matches the risk being guarded against.
	var parentUpdateRows, parentUpdateStudents int
	_ = tx.Raw(`SELECT COUNT(*) FROM follow_ups
		WHERE parent_note IS NOT NULL AND parent_note <> ''`).Scan(&parentUpdateRows)
	_ = tx.Raw(`SELECT COUNT(DISTINCT student_id) FROM follow_ups
		WHERE parent_note IS NOT NULL AND parent_note <> ''`).Scan(&parentUpdateStudents)
	fmt.Printf("  家长告知：%d 条 / 覆盖 %d 个家庭\n", parentUpdateRows, parentUpdateStudents)
	if parentUpdateRows < 8 || parentUpdateStudents < 8 {
		return fmt.Errorf("seed produced %d parent update(s) across %d student(s); the "+
			"family-facing 课堂反馈 block would look like an unbuilt feature for the "+
			"households it misses", parentUpdateRows, parentUpdateStudents)
	}

	// 「课堂记录标记」队列。老师在点名页勾了旗标之后，顾问**看得见**它的唯一入口
	// 就是 /dashboard/admin 的这一区（用户裁定：follow_ups 在别处没有列表入口），
	// 所以一个空的区与一个坏掉的查询在屏幕上一模一样 —— 与上面几个面板同一种
	// 失效模式，得靠演示数据来否证。
	//
	// 三个数，因为这一区的风险有三个不同的度量。前两个是**闸门**（下面有 if 判据），
	// 第三个只报数 —— 见它自己那段注释。
	var flaggedPending, flaggedAdmins, flaggedFuture int
	_ = tx.Raw(`SELECT COUNT(*) FROM follow_ups
		WHERE source='teacher_note' AND status='pending'`).Scan(&flaggedPending)
	// 第二个数是「覆盖了几个顾问」。这一区是按 owner_admin_id 过滤下发的
	// （handler/dashboard.go:140-143），所以全局条数根本不是风险的正确度量：
	// 3 条全落在同一个顾问名下时，另外两个顾问的 /today 依旧是空的，而全局计数
	// 完全看不出来。与家长告知那条闸门同一个道理 —— 按一个一个家庭读，就得查覆盖。
	_ = tx.Raw(`SELECT COUNT(DISTINCT s.owner_admin_id) FROM follow_ups fu
		JOIN students s ON s.id = fu.student_id
		WHERE fu.source='teacher_note' AND fu.status='pending'`).Scan(&flaggedAdmins)
	// 第三个数是「其中还有几条没到期」，但**只报数，不当闸门**。
	//
	// 它数的是这一区存在的全部理由（「还没到期也要看得见」，契约的 FlaggedFollowUpRow），
	// 可它的多少取决于**运行 seed 的那天是星期几**：标记行的 due_at 锚在课时日期上
	// （l.Date + 48h，见上面 attendance 循环里的写法），而 slots 的 weekday 只有
	// {2,3,4,5,6}（:91-100）—— 周一、周日一节课都没有。于是它周一必然为 0、周二
	// 只有一节课约四成、周三~周六才有 2~4 节课。上面两条闸门都不依赖当前日期
	// （历史课时总量足以让三条 Flagged 模板必然被轮转到），这一条却依赖。
	//
	// 一个结果取决于日历的判据不能当闸门用：`-seed` 会在「今天星期一」时失败，
	// 而失败的原因是星期几，不是数据错了 —— 它把一个数据问题和一个日历事实压成
	// 同一个非零退出码，看的人只会去查数据。所以降级成观测值：打出来，但不 return。
	// 真要修也不是改判据，而是给排课表补上周一/周日的班（那会牵动课时总数、
	// today_lessons、班级数一串别人的判据）或换个日子跑 seed —— 两者都不该为了让
	// 一条演示闸门过去而动。
	_ = tx.Raw(`SELECT COUNT(*) FROM follow_ups
		WHERE source='teacher_note' AND status='pending' AND due_at >= ?`, now).Scan(&flaggedFuture)
	// 若要在界面上看到「未逾期」的标记，请在周三~周六运行 seed（周一必然为 0）。
	fmt.Printf("  课堂标记：%d 条待处理 / 覆盖 %d 个顾问 / 其中 %d 条未到期\n",
		flaggedPending, flaggedAdmins, flaggedFuture)
	if flaggedPending < 3 {
		return fmt.Errorf("seed produced only %d pending classroom flag(s); the "+
			"flagged queue on the admin workbench would look like a broken query", flaggedPending)
	}
	if flaggedAdmins < 3 {
		return fmt.Errorf("seed produced pending classroom flags for only %d of 3 "+
			"consultants; the queue is delivered per owner, so the other consultants' "+
			"workbenches are empty and the global count cannot show it", flaggedAdmins)
	}

	// An 'active' student with no package is a contradiction the demo must
	// not ship: 'active' means "has an account and attends classes", and the
	// packages block assumes exactly that. It can only appear if some future
	// edit lets a student reach 'active' after the opening packages were
	// written - which is precisely how it appeared once already, when a
	// converted trial promoted a student the packages block had skipped.
	// The conversion path now opens the account; this is what makes the next
	// such path impossible to ship quietly, because the counters above do
	// not move when it happens.
	var activeWithoutPackage int
	_ = tx.Raw(`SELECT COUNT(*) FROM students s
		LEFT JOIN credit_packages p ON p.student_id = s.id
		WHERE s.deleted_at IS NULL AND s.status = 'active' AND p.id IS NULL`).
		Scan(&activeWithoutPackage)
	if activeWithoutPackage != 0 {
		return fmt.Errorf("seed left %d active student(s) with no credit package; "+
			"the opening packages are written before any status promotion, so a "+
			"conversion path is missing", activeWithoutPackage)
	}

	// The student lifecycle is lead -> trial -> active -> churned and the
	// snapshot must not contradict it. A converted trial on a student still
	// marked lead/trial reads as "the conversion did not take"; any trial at
	// all on a lead student means the lead -> trial hop was skipped. Both
	// are invisible in the workbench counters above, so they get their own
	// check rather than relying on promoteForTrial being called correctly.
	var convertedStillProspect, bookedStillLead int
	if err := tx.Raw(`SELECT COUNT(*) FROM students s JOIN trials t ON t.student_id = s.id
		WHERE s.deleted_at IS NULL AND t.outcome = 'converted' AND s.status IN ('lead','trial')`).
		Scan(&convertedStillProspect).Error; err != nil {
		return err
	}
	if err := tx.Raw(`SELECT COUNT(*) FROM students s JOIN trials t ON t.student_id = s.id
		WHERE s.deleted_at IS NULL AND s.status = 'lead'`).Scan(&bookedStillLead).Error; err != nil {
		return err
	}
	if convertedStillProspect > 0 {
		return fmt.Errorf("seed produced %d converted trial(s) whose student is still lead/trial; the conversion would look like it did not take",
			convertedStillProspect)
	}
	if bookedStillLead > 0 {
		return fmt.Errorf("seed produced %d student(s) marked lead but holding a trial; the lead -> trial hop is missing",
			bookedStillLead)
	}
	return nil
}

func makeUsers(tx *gorm.DB, role model.Role, hash string, usernames, names []string, now time.Time) ([]*model.User, error) {
	out := []*model.User{}
	for i, un := range usernames {
		u := &model.User{
			Role: role, Username: un, PasswordHash: hash,
			DisplayName: names[i], Status: "active",
			CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(u).Error; err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

func wipe(tx *gorm.DB) error {
	tables := []string{
		"audit_events", "ai_decisions", "follow_ups", "trials",
		"credit_ledger", "credit_packages", "leave_requests", "attendances",
		"lessons", "class_enrollments", "classes", "guardians", "students",
		"subjects", "teacher_profiles", "users",
	}
	for _, t := range tables {
		if err := tx.Exec("DELETE FROM " + t).Error; err != nil {
			return fmt.Errorf("wipe %s: %w", t, err)
		}
	}
	return nil
}
