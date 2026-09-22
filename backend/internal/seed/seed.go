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
	subjects  = []string{"Beginner Maths", "AEIS Maths", "AEIS Writing", "English Oral", "Advanced Maths", "Science"}
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
			name      string
			subject   int
			teacher   int
			weekday   int // 1=Mon .. 7=Sun
			start     int
			capacity  int
			room      string
		}
		slots := []slot{
			{"Beginner Maths A", 0, 0, 4, 16 * 60, 8, "Room 1"},
			{"Beginner Maths B", 0, 0, 6, 10 * 60, 8, "Room 1"},
			{"AEIS Maths A", 1, 1, 4, 17 * 60 + 30, 8, "Room 2"},
			{"AEIS Writing A", 2, 1, 2, 17 * 60 + 30, 8, "Room 2"},
			{"English Oral B", 3, 2, 5, 17 * 60 + 30, 6, "Room 3"},
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
			pkgSize := []int{20, 40, 40, 60}[i%4]
			p := &model.CreditPackage{
				StudentID: s.ID,
				Name:      fmt.Sprintf("%d-credit package", pkgSize),
				TotalCredits: pkgSize,
				PriceCents:   int64(pkgSize) * 8500,
				PurchasedByAdminID: admins[s.OwnerIdx].ID,
			}
			// Purchases are historical, so write them with a backdated
			// timestamp rather than "now".
			if err := credit.Purchase(tx, admins[s.OwnerIdx].ID, p); err != nil {
				return err
			}
			if err := tx.Exec("UPDATE credit_ledger SET created_at = ? WHERE package_id = ?",
				now.AddDate(0, 0, -(20 + i%30)), p.ID).Error; err != nil {
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
				res := tx.Exec(`INSERT IGNORE INTO attendances
					(lesson_id, student_id, status, source, recorded_by_user_id, recorded_at)
					VALUES (?,?,?,'teacher_override',?,?)`, l.ID, sid, status, actor, l.Date.Add(90*time.Minute))
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
			st := students[(i*5+1)%len(students)]
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

			dueAt := scheduled.Add(48 * time.Hour)
			fu := &model.FollowUp{
				StudentID: st.ID, TrialID: &t.ID, DueAt: dueAt,
				Status: "pending", CreatedAt: scheduled.Add(2 * time.Hour),
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
		//  2. Every student still in the 'lead' or 'trial' stage is
		//     skipped, and that is what keeps the roster believable
		//     afterwards. mei.lin has exactly one of each - the two
		//     samples the students page filters by. Any trial on either
		//     one replays a lifecycle hop (promoteForTrial: lead -> trial,
		//     or trial -> active when the outcome is converted), so both
		//     samples would quietly turn 'active' and the 线索 /
		//     已约试听 filters would come back empty.
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
		//     the two student-page filters coming back empty - no error
		//     anywhere, just a quietly less believable snapshot.
		//
		//     Hero (index 0) is 'active', so it stays eligible exactly as
		//     before. The exclusion is deliberate, not an oversight.
		//
		// The other eleven students are cycled through, each with a
		// subject cursor that persists across the three outcomes, so one
		// student's three trials land on three different subjects.
		const demoPerOutcome = 10
		demo := []madeStudent{}
		for _, s := range students {
			if s.OwnerIdx != 0 || s.Status == model.StudentLead || s.Status == model.StudentTrial {
				continue
			}
			demo = append(demo, s)
		}
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
		subjCursor := make([]int, len(demo))
		// Tidy wall-clock slots, the same shape the block above uses: the
		// demo should show 4:00pm, not the minute the seed happened to run.
		demoSlots := []int{16 * 60, 10 * 60, 17 * 60, 15 * 60, 11 * 60, 14 * 60}
		demoSeq := 0
		for oi, outcome := range []string{"lost", "converted", "pending"} {
			placed := 0
			for placed < demoPerOutcome {
				progressed := false
				for si, st := range demo {
					if placed == demoPerOutcome {
						break
					}
					// First subject this student has not already tried.
					ci := -1
					for subjCursor[si] < len(subjectIDs) {
						c := subjCursor[si]
						subjCursor[si]++
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
		fmt.Printf("  学生：%d\n", len(students))
		fmt.Printf("  班级：%d\n", len(slots))
		fmt.Printf("  课次：%d\n", len(lessons))
		return reportStates(tx, now, cfg)
	})
}

func trialNote(outcome string) string {
	if outcome == "converted" {
		return "Parent asked about class times; child engaged well."
	}
	return "Child found the pace fast; parent wants to think about it."
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
	var overdue, lowCredit, todayLessons, upcomingTrials int
	_ = tx.Raw("SELECT COUNT(*) FROM follow_ups WHERE status='pending' AND due_at < ?", now).Scan(&overdue)
	_ = tx.Raw(`SELECT COUNT(*) FROM students s
		LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.status='active' AND COALESCE(b.balance,0) <= ?`, cfg.Thresholds.LowCreditThreshold).Scan(&lowCredit)
	_ = tx.Raw("SELECT COUNT(*) FROM lessons WHERE lesson_date = ?", now.Format("2006-01-02")).Scan(&todayLessons)
	_ = tx.Raw("SELECT COUNT(*) FROM trials WHERE scheduled_at >= ?", now).Scan(&upcomingTrials)
	fmt.Printf("  演示状态：%d 条跟进已逾期，%d 场试听待进行，%d 名学生课时不足，今日 %d 节课\n",
		overdue, upcomingTrials, lowCredit, todayLessons)

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
