package service

import (
	"strings"
	"testing"
)

// The renewal card's evidence is only worth reading if the note it shows was
// written by a teacher. This covers the boundary between the two system
// strings and a real remark, since a regression here silently turns
// scaffolding into an observation about the student.
func TestTeacherFeedbackKeepsOnlyHumanText(t *testing.T) {
	long := strings.Repeat("a", 260)

	cases := []struct {
		name   string
		note   string
		want   string
		wantOK bool
	}{
		{"teacher remark passes through", "Great focus today; asked two good questions.", "Great focus today; asked two good questions.", true},
		{"correction suffix is stripped", "Stuck on fractions | corrected from present", "Stuck on fractions", true},
		{"stacked suffixes keep the original", "Quiet but engaged | corrected from present | corrected from late", "Quiet but engaged", true},
		{"suffix-only note is rejected", "corrected from present", "", false},
		{"leading separator from CONCAT_WS is rejected", " | corrected from absent", "", false},
		{"system late-leave note is rejected", "late leave: notice < 24h", "", false},
		{"empty note is rejected", "", "", false},
		{"whitespace-only note is rejected", "   ", "", false},
		{"long remark is truncated to 200", long, long[:200], true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := teacherFeedback(tc.note)
			if ok != tc.wantOK {
				t.Fatalf("teacherFeedback(%q) ok = %v, want %v", tc.note, ok, tc.wantOK)
			}
			if got != tc.want {
				t.Fatalf("teacherFeedback(%q) = %q, want %q", tc.note, got, tc.want)
			}
		})
	}
}
