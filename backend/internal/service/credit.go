package service

import (
	"errors"
	"fmt"

	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/model"
)

// CreditService is the ONLY writer of credit_ledger.
//
// R5 - three layers, all of them real:
//
//	database   CHECK(delta <> 0); no updated_at / deleted_at columns;
//	           UNIQUE(student_id, lesson_id, reason) as an idempotency gate;
//	           the runtime account is granted SELECT + INSERT only.
//	repository there is no Update or Delete method on this type at all,
//	           so no caller can even compile a rewrite.
//	service    Apply forces actor_user_id, whitelists reason, and requires
//	           the caller to have taken the student row lock first.
type CreditService struct{}

// LockStudent serialises all credit movement for one student.
//
// MySQL cannot lock the result of an aggregate, so we lock a real row:
// the student row IS that student's account mutex. Every transaction that
// writes credit_ledger must call this as its first statement.
func (s *CreditService) LockStudent(tx *gorm.DB, studentID uint64) error {
	var id uint64
	err := tx.Raw("SELECT id FROM students WHERE id = ? FOR UPDATE", studentID).Scan(&id).Error
	if err != nil {
		return err
	}
	if id == 0 {
		return apierr.ErrNotFound
	}
	return nil
}

// SumBalance derives the balance from the ledger. There is no stored
// balance column anywhere; a redundant one would drift, and drift here
// is a billing dispute.
func (s *CreditService) SumBalance(tx *gorm.DB, studentID uint64) (int, error) {
	var balance *int
	err := tx.Raw("SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE student_id = ?", studentID).
		Scan(&balance).Error
	if err != nil {
		return 0, err
	}
	if balance == nil {
		return 0, nil
	}
	return *balance, nil
}

var allowedReasons = map[model.LedgerReason]bool{
	model.ReasonPurchase:     true,
	model.ReasonConsume:      true,
	model.ReasonLeaveAdjust:  true,
	model.ReasonManualAdjust: true,
	model.ReasonRefund:       true,
	model.ReasonTransferOut:  true,
}

// Apply appends one ledger entry. It never updates or deletes.
func (s *CreditService) Apply(tx *gorm.DB, e *model.CreditLedger) error {
	if e.StudentID == 0 {
		return errors.New("credit: student_id required")
	}
	if e.ActorUserID == 0 {
		return errors.New("credit: actor_user_id required; every movement must be attributable")
	}
	if e.Delta == 0 {
		return errors.New("credit: delta must be non-zero")
	}
	if !allowedReasons[e.Reason] {
		return fmt.Errorf("credit: reason %q not whitelisted", e.Reason)
	}
	// Business time comes from Go, never from SQL NOW(). See ADR-007.
	e.CreatedAt = clock.Now()
	return tx.Create(e).Error
}

// ErrDuplicateSettle surfaces the idempotency gate as a business error so
// a double-clicked "settle" reports 40906 instead of a raw MySQL error.
func IsDuplicateLedger(err error) bool {
	return IsDuplicate(err, "uq_ledger_consume")
}

// Purchase opens a new package: one credit_packages row plus the opening
// ledger entry, in a single transaction. This is the moment money comes in.
func (s *CreditService) Purchase(tx *gorm.DB, actorID uint64, p *model.CreditPackage) error {
	if p.TotalCredits <= 0 {
		return errors.New("package must carry at least one credit")
	}
	if err := s.LockStudent(tx, p.StudentID); err != nil {
		return err
	}
	p.PurchasedAt = clock.Now()
	p.PurchasedByAdminID = actorID
	p.Status = "active"
	if err := tx.Create(p).Error; err != nil {
		return err
	}
	return s.Apply(tx, &model.CreditLedger{
		StudentID:   p.StudentID,
		PackageID:   &p.ID,
		Delta:       p.TotalCredits,
		Reason:      model.ReasonPurchase,
		ActorUserID: actorID,
		Note:        p.Name,
	})
}

// Refund zeroes the balance by appending a reverse entry.
// It never edits or removes history (see DESIGN.md section 3).
func (s *CreditService) Refund(tx *gorm.DB, actorID, studentID uint64, note string) (int, error) {
	if err := s.LockStudent(tx, studentID); err != nil {
		return 0, err
	}
	bal, err := s.SumBalance(tx, studentID)
	if err != nil {
		return 0, err
	}
	if bal == 0 {
		return 0, nil
	}
	return -bal, s.Apply(tx, &model.CreditLedger{
		StudentID:   studentID,
		Delta:       -bal,
		Reason:      model.ReasonRefund,
		ActorUserID: actorID,
		Note:        note,
	})
}
