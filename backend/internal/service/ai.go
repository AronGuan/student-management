package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"
	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/model"
)

// AIService produces the two decision cards: trial conversion and renewal
// risk. Both sit exactly on the moments money comes in.
//
// R8 contract:
//   - the model call is optional, never load-bearing
//   - output must be JSON, but DeepSeek's json_object mode guarantees only
//     valid JSON syntax, not our business schema, so the enum whitelist
//     below is the real guarantee
//   - on any failure we persist ai_status and hand back a deterministic
//     rule-based card with the same shape, so the UI never shifts and the
//     follow-up SLA keeps running
type AIService struct {
	Cfg *config.Config
}

const promptVersion = "v1"

// ---- conversion card ----

type ConversionCard struct {
	// Identity fields, filled from the persisted ai_decisions row so the
	// card component and the decision log can key off a stable id.
	ID        uint64    `json:"id"`
	StudentID uint64    `json:"student_id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`

	ConversionSignal   string   `json:"conversion_signal"`
	GuardianConcerns   []string `json:"guardian_concerns"`
	Blocker            string   `json:"blocker"`
	NextAction         string   `json:"next_action"`
	FollowUpWithinDays int      `json:"follow_up_within_days"`
	AdvisorNote        string   `json:"advisor_note"`
	AIStatus           string   `json:"ai_status"`
	Source             string   `json:"source"`
	Evidence           []string `json:"evidence"`
	Model              string   `json:"model,omitempty"`
}

var (
	allowedSignals  = []string{"strong", "weak", "blocked"}
	allowedConcerns = []string{"price", "outcome", "schedule", "distance", "teacher", "other"}
	allowedBlockers = []string{"none", "price", "schedule", "outcome", "undecided", "competitor"}
	allowedActions  = []string{"call", "send_material", "arrange_second_trial", "wait", "close"}
)

func (s *AIService) Conversion(db *gorm.DB, studentID uint64) (*ConversionCard, error) {
	ctx := &conversionContext{}
	if err := db.Raw(`SELECT s.full_name, s.year_level, s.source, s.status,
		COALESCE(b.balance,0) AS balance
		FROM students s LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.id = ?`, studentID).Scan(ctx).Error; err != nil {
		return nil, err
	}
	if ctx.FullName == "" {
		return nil, apierr.ErrNotFound
	}

	var trials []struct {
		SubjectName string `json:"subject_name"`
		Outcome     string `json:"outcome"`
		OutcomeNote string `json:"outcome_note"`
		TeacherName string `json:"teacher_name"`
	}
	_ = db.Raw(`SELECT sub.name AS subject_name, t.outcome, t.outcome_note, u.display_name AS teacher_name
		FROM trials t LEFT JOIN subjects sub ON sub.id = t.subject_id
		LEFT JOIN users u ON u.id = t.teacher_id
		WHERE t.student_id = ? ORDER BY t.scheduled_at DESC LIMIT 3`, studentID).Scan(&trials)

	var notes []string
	_ = db.Raw(`SELECT note FROM follow_ups WHERE student_id = ? AND note IS NOT NULL AND note <> ''
		ORDER BY created_at DESC LIMIT 5`, studentID).Scan(&notes)

	prompt := buildConversionPrompt(ctx, trials, notes)
	card := &ConversionCard{AIStatus: "unavailable", Source: "rule"}

	raw, err := s.callLLM(prompt)
	if err == nil {
		var parsed ConversionCard
		if jerr := json.Unmarshal([]byte(raw), &parsed); jerr == nil {
			if verr := validateConversion(&parsed); verr == nil {
				card = &parsed
				card.AIStatus = "ok"
				card.Source = "llm"
				card.Model = s.Cfg.DeepSeek.Model
			} else {
				card.AIStatus = "invalid"
			}
		} else {
			card.AIStatus = "invalid"
		}
	}

	if card.AIStatus != "ok" {
		// Deterministic fallback. Same shape, same fields, so the front end
		// renders it in the identical slot.
		*card = ruleConversionCard(ctx, trials)
		card.AIStatus = fallbackStatus(card.AIStatus)
		card.Source = "rule"
	}

	card.Evidence = buildConversionEvidence(ctx, trials, notes)
	rec, _ := s.persist(db, studentID, "trial_conversion", prompt, card)
	card.StudentID = studentID
	card.Kind = "trial_conversion"
	card.CreatedAt = clock.Now()
	if rec != nil {
		card.ID = rec.ID
		card.CreatedAt = rec.CreatedAt
	}
	return card, nil
}

func fallbackStatus(cur string) string {
	if cur == "invalid" {
		return "invalid"
	}
	return "unavailable"
}

// buildConversionPrompt keeps the literal word "json" in the instruction:
// DeepSeek's json_object mode requires it, and may otherwise return empty
// content.
func buildConversionPrompt(ctx *conversionContext, trials []struct {
	SubjectName string `json:"subject_name"`
	Outcome     string `json:"outcome"`
	OutcomeNote string `json:"outcome_note"`
	TeacherName string `json:"teacher_name"`
}, notes []string) string {
	var b strings.Builder
	b.WriteString("You are assisting an education centre admissions counsellor in Melbourne.\n")
	b.WriteString("Given the trial evidence, return a JSON object only. Output valid json with these keys:\n")
	b.WriteString(`{"conversion_signal":"strong|weak|blocked","guardian_concerns":["price|outcome|schedule|distance|teacher|other"],"blocker":"none|price|schedule|outcome|undecided|competitor","next_action":"call|send_material|arrange_second_trial|wait|close","follow_up_within_days":0,"advisor_note":"max 60 chars"}` + "\n\n")
	fmt.Fprintf(&b, "Student: %s, year %s, source %s, status %s, credit balance %d\n",
		ctx.FullName, ctx.YearLevel, ctx.Source, ctx.Status, ctx.Balance)
	for _, t := range trials {
		fmt.Fprintf(&b, "Trial: subject %s, outcome %s, teacher %s, feedback: %s\n",
			t.SubjectName, t.Outcome, t.TeacherName, truncate(t.OutcomeNote, 200))
	}
	for _, n := range notes {
		fmt.Fprintf(&b, "Follow-up note: %s\n", truncate(n, 200))
	}
	b.WriteString("\nKeep advisor_note under 60 characters. No markdown, no code fences.")
	return b.String()
}

func validateConversion(c *ConversionCard) error {
	if !inSet(c.ConversionSignal, allowedSignals) {
		return errors.New("conversion_signal not whitelisted")
	}
	if !inSet(c.Blocker, allowedBlockers) {
		return errors.New("blocker not whitelisted")
	}
	if !inSet(c.NextAction, allowedActions) {
		return errors.New("next_action not whitelisted")
	}
	if len(c.GuardianConcerns) > 3 {
		return errors.New("too many concerns")
	}
	for _, v := range c.GuardianConcerns {
		if !inSet(v, allowedConcerns) {
			return errors.New("guardian_concerns contains " + v)
		}
	}
	if c.FollowUpWithinDays < 0 || c.FollowUpWithinDays > 14 {
		return errors.New("follow_up_within_days out of range")
	}
	return nil
}

func ruleConversionCard(ctx *conversionContext, trials []struct {
	SubjectName string `json:"subject_name"`
	Outcome     string `json:"outcome"`
	OutcomeNote string `json:"outcome_note"`
	TeacherName string `json:"teacher_name"`
}) ConversionCard {
	c := ConversionCard{
		ConversionSignal:   "weak",
		Blocker:            "undecided",
		NextAction:         "call",
		FollowUpWithinDays: 2,
		AdvisorNote:        "Trial logged; call the family to confirm next steps.",
	}
	for _, t := range trials {
		switch t.Outcome {
		case "converted":
			c.ConversionSignal = "strong"
			c.Blocker = "none"
			c.NextAction = "send_material"
			c.AdvisorNote = "Trial converted; send the class schedule and pricing."
		case "lost":
			c.ConversionSignal = "blocked"
			c.Blocker = "outcome"
			c.NextAction = "wait"
			c.AdvisorNote = "Trial marked lost; confirm before closing the lead."
		}
	}
	return c
}

func buildConversionEvidence(ctx *conversionContext, trials []struct {
	SubjectName string `json:"subject_name"`
	Outcome     string `json:"outcome"`
	OutcomeNote string `json:"outcome_note"`
	TeacherName string `json:"teacher_name"`
}, notes []string) []string {
	ev := []string{}
	for _, t := range trials {
		ev = append(ev, fmt.Sprintf("Trial %s with %s: %s", t.SubjectName, t.TeacherName, t.Outcome))
	}
	if len(notes) == 0 {
		ev = append(ev, "No follow-up logged yet")
	} else {
		ev = append(ev, fmt.Sprintf("%d follow-up notes on file", len(notes)))
	}
	ev = append(ev, fmt.Sprintf("Credit balance %d", ctx.Balance))
	return ev
}

// ---- renewal card ----

type RenewalCard struct {
	// Identity fields, filled from the persisted ai_decisions row.
	ID        uint64    `json:"id"`
	StudentID uint64    `json:"student_id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`

	ChurnRisk          string   `json:"churn_risk"`
	RiskFactors        []string `json:"risk_factors"`
	RecommendedPackage string   `json:"recommended_package"`
	ContactFrom        string   `json:"contact_from"`
	ContactTo          string   `json:"contact_to"`
	AdvisorNote        string   `json:"advisor_note"`
	AIStatus           string   `json:"ai_status"`
	Source             string   `json:"source"`
	Evidence           []string `json:"evidence"`
	Model              string   `json:"model,omitempty"`
}

var (
	allowedRisks    = []string{"high", "medium", "low"}
	allowedFactors  = []string{"attendance_drop", "feedback_negative", "low_usage", "long_gap", "none"}
	allowedPackages = []string{"small", "standard", "large", "none"}
)

func (s *AIService) Renewal(db *gorm.DB, studentID uint64) (*RenewalCard, error) {
	m := map[string]interface{}{}
	if err := db.Raw(`SELECT s.full_name, COALESCE(b.balance,0) AS balance
		FROM students s LEFT JOIN v_student_balance b ON b.student_id = s.id
		WHERE s.id = ?`, studentID).Scan(&m).Error; err != nil {
		return nil, err
	}
	if m["full_name"] == nil {
		return nil, apierr.ErrNotFound
	}

	var attended, absent int
	_ = db.Raw(`SELECT COUNT(*) FROM attendances WHERE student_id=? AND status IN ('present','late')`, studentID).Scan(&attended)
	_ = db.Raw(`SELECT COUNT(*) FROM attendances WHERE student_id=? AND status='absent'`, studentID).Scan(&absent)

	var lastFeedback []string
	_ = db.Raw(`SELECT note FROM attendances WHERE student_id=? AND note IS NOT NULL AND note <> ''
		ORDER BY recorded_at DESC LIMIT 3`, studentID).Scan(&lastFeedback)

	bal := toInt(m["balance"])
	prompt := buildRenewalPrompt(m, attended, absent, lastFeedback)

	card := &RenewalCard{AIStatus: "unavailable", Source: "rule"}
	raw, err := s.callLLM(prompt)
	if err == nil {
		var parsed RenewalCard
		if jerr := json.Unmarshal([]byte(raw), &parsed); jerr == nil {
			if verr := validateRenewal(&parsed); verr == nil {
				card = &parsed
				card.AIStatus = "ok"
				card.Source = "llm"
				card.Model = s.Cfg.DeepSeek.Model
			} else {
				card.AIStatus = "invalid"
			}
		} else {
			card.AIStatus = "invalid"
		}
	}
	if card.AIStatus != "ok" {
		*card = ruleRenewalCard(bal, absent)
		card.AIStatus = fallbackStatus(card.AIStatus)
		card.Source = "rule"
	}
	card.Evidence = buildRenewalEvidence(bal, attended, absent, lastFeedback)
	rec, _ := s.persist(db, studentID, "renewal_risk", prompt, card)
	card.StudentID = studentID
	card.Kind = "renewal_risk"
	card.CreatedAt = clock.Now()
	if rec != nil {
		card.ID = rec.ID
		card.CreatedAt = rec.CreatedAt
	}
	return card, nil
}

func buildRenewalPrompt(m map[string]interface{}, attended, absent int, notes []string) string {
	var b strings.Builder
	b.WriteString("You are assisting an education centre counsellor in Melbourne with student retention.\n")
	b.WriteString("Return a JSON object only. Output valid json with these keys:\n")
	b.WriteString(`{"churn_risk":"high|medium|low","risk_factors":["attendance_drop|feedback_negative|low_usage|long_gap|none"],"recommended_package":"small|standard|large|none","contact_from":"YYYY-MM-DD","contact_to":"YYYY-MM-DD","advisor_note":"max 60 chars"}` + "\n\n")
	fmt.Fprintf(&b, "Student: %v, credit balance %v\n", m["full_name"], m["balance"])
	fmt.Fprintf(&b, "Attended sessions: %d, absences: %d\n", attended, absent)
	fmt.Fprintf(&b, "Today: %s\n", clock.Now().Format("2006-01-02"))
	for _, n := range notes {
		fmt.Fprintf(&b, "Recent feedback: %s\n", truncate(n, 200))
	}
	b.WriteString("\ncontact_from and contact_to must be within the next 30 days. No markdown, no code fences.")
	return b.String()
}

func validateRenewal(c *RenewalCard) error {
	if !inSet(c.ChurnRisk, allowedRisks) {
		return errors.New("churn_risk not whitelisted")
	}
	if !inSet(c.RecommendedPackage, allowedPackages) {
		return errors.New("recommended_package not whitelisted")
	}
	if len(c.RiskFactors) > 3 {
		return errors.New("too many risk factors")
	}
	for _, v := range c.RiskFactors {
		if !inSet(v, allowedFactors) {
			return errors.New("risk_factors contains " + v)
		}
	}
	// The window must be a real, forward-looking interval.
	f, e1 := time.ParseInLocation("2006-01-02", c.ContactFrom, clock.Loc())
	t, e2 := time.ParseInLocation("2006-01-02", c.ContactTo, clock.Loc())
	if e1 != nil || e2 != nil {
		return errors.New("contact window must be YYYY-MM-DD")
	}
	if t.Before(f) {
		return errors.New("contact_to before contact_from")
	}
	if f.Before(clock.Now().AddDate(0, 0, -1)) || t.After(clock.Now().AddDate(0, 0, 30)) {
		return errors.New("contact window outside the next 30 days")
	}
	return nil
}

func ruleRenewalCard(balance, absent int) RenewalCard {
	c := RenewalCard{
		ChurnRisk:          "low",
		RiskFactors:        []string{"none"},
		RecommendedPackage: "standard",
		ContactFrom:        clock.Now().AddDate(0, 0, 3).Format("2006-01-02"),
		ContactTo:          clock.Now().AddDate(0, 0, 10).Format("2006-01-02"),
		AdvisorNote:        "Usage looks healthy; agree the next package early.",
	}
	switch {
	case balance <= 0:
		c.ChurnRisk = "high"
		c.RiskFactors = []string{"low_usage"}
		c.RecommendedPackage = "standard"
		c.AdvisorNote = "Balance is zero or negative; contact before the next lesson."
	case balance <= 4:
		c.ChurnRisk = "medium"
		c.RiskFactors = []string{"low_usage"}
		c.AdvisorNote = "Credits running low; propose renewal this week."
	}
	if absent > 2 {
		c.ChurnRisk = "high"
		c.RiskFactors = appendIfMissing(c.RiskFactors, "attendance_drop")
	}
	return c
}

func buildRenewalEvidence(balance, attended, absent int, notes []string) []string {
	ev := []string{
		fmt.Sprintf("Credit balance %d", balance),
		fmt.Sprintf("%d sessions attended, %d absences", attended, absent),
	}
	if len(notes) > 0 {
		ev = append(ev, "Recent teacher feedback on file")
	} else {
		ev = append(ev, "No teacher feedback yet")
	}
	return ev
}

// ---- transport ----

func (s *AIService) callLLM(prompt string) (string, error) {
	if s.Cfg.DeepSeek.APIKey == "" {
		return "", errors.New("DEEPSEEK_API_KEY not configured")
	}
	oc := openai.DefaultConfig(s.Cfg.DeepSeek.APIKey)
	oc.BaseURL = s.Cfg.DeepSeek.BaseURL
	cli := openai.NewClientWithConfig(oc)

	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration(s.Cfg.DeepSeek.TimeoutSec)*time.Second)
	defer cancel()

	resp, err := cli.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model: s.Cfg.DeepSeek.Model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: "You are a concise admissions analyst. Reply with JSON only."},
			{Role: openai.ChatMessageRoleUser, Content: prompt},
		},
		ResponseFormat: &openai.ChatCompletionResponseFormat{
			Type: openai.ChatCompletionResponseFormatTypeJSONObject,
		},
		Temperature: 0.2,
		MaxTokens:   600,
	})
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", errors.New("empty completion")
	}
	// A truncated completion is invalid even if it parses.
	if resp.Choices[0].FinishReason == openai.FinishReasonLength {
		return "", errors.New("completion truncated")
	}
	return stripFences(resp.Choices[0].Message.Content), nil
}

// stripFences removes ```json fences. DeepSeek occasionally wraps output
// even in json_object mode.
func stripFences(s string) string {
	out := strings.TrimSpace(s)
	out = strings.TrimPrefix(out, "```json")
	out = strings.TrimPrefix(out, "```")
	out = strings.TrimSuffix(out, "```")
	return strings.TrimSpace(out)
}

// persist writes the decision row and hands the record back, so the caller
// can stamp the row's identity onto the card it returns. A failed write is
// not fatal: the card still leaves with ai_status/source intact.
//
// output_json stores the ANALYSIS only. The identity fields live on the
// row's own columns, so leaving them in the blob would persist the zeros
// they hold at write time and let the stored card contradict its row.
func (s *AIService) persist(db *gorm.DB, studentID uint64, kind, prompt string, card interface{}) (*model.AIDecision, error) {
	b, err := json.Marshal(card)
	if err != nil {
		return nil, err
	}
	status := "ok"
	switch v := card.(type) {
	case *ConversionCard:
		status = v.AIStatus
	case *RenewalCard:
		status = v.AIStatus
	}
	rec := &model.AIDecision{
		StudentID:     studentID,
		Kind:          kind,
		Model:         s.Cfg.DeepSeek.Model,
		PromptVersion: promptVersion,
		InputHash:     HashInput(prompt),
		OutputJSON:    string(StripCardIdentity(b)),
		AIStatus:      status,
		CreatedAt:     clock.Now(),
	}
	if err := db.Create(rec).Error; err != nil {
		return nil, err
	}
	return rec, nil
}

// ---- small helpers ----

// aiCardIdentityKeys are the four identity fields added on top of the
// analysis. Each is owned by an ai_decisions column, and each is still
// zero at write time, so persisting them would store a card that
// contradicts its own row. Every other field, including ai_status and
// source, is the analysis and stays.
var aiCardIdentityKeys = []string{"id", "student_id", "kind", "created_at"}

// StripCardIdentity returns the card JSON with the identity keys removed.
// On any parse failure it returns the input unchanged: losing the identity
// keys is cosmetic, losing the analysis is not.
func StripCardIdentity(b []byte) []byte {
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		return b
	}
	for _, k := range aiCardIdentityKeys {
		delete(m, k)
	}
	out, err := json.Marshal(m)
	if err != nil {
		return b
	}
	return out
}

func inSet(v string, set []string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

func appendIfMissing(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// toInt reads a numeric value out of a map scan. The extra []byte and
// string cases are not defensive padding: SUM() over an INT column comes
// back from MySQL as a DECIMAL, which the driver hands over as []byte, and
// without these the renewal card reported "Credit balance 0" for a family
// that still had credits - a wrong number in the one place the product
// promises an honest one.
func toInt(v interface{}) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case []byte:
		if f, err := strconv.ParseFloat(string(t), 64); err == nil {
			return int(f)
		}
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return int(f)
		}
	}
	return 0
}

type conversionContext struct {
	FullName  string `json:"full_name"`
	YearLevel string `json:"year_level"`
	Source    string `json:"source"`
	Status    string `json:"status"`
	Balance   int    `json:"balance"`
}
