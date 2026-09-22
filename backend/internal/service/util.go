package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
)

// IsDuplicate reports whether err is a uniqueness violation on one of the
// given index names. Two guards, because neither is sufficient alone:
// TranslateError turns 1062 into gorm.ErrDuplicatedKey but drops the index
// name; without it the raw MySQL message still carries the index name. A
// constraint violation must never reach the client as a 500.
func IsDuplicate(err error, index ...string) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	msg := err.Error()
	if strings.Contains(msg, "Error 1062") || strings.Contains(msg, "Duplicate entry") {
		return true
	}
	for _, name := range index {
		if name != "" && strings.Contains(msg, name) {
			return true
		}
	}
	return false
}

func jsonMarshal(v interface{}) ([]byte, error) { return json.Marshal(v) }

// HashInput fingerprints the prompt inputs so identical context can reuse
// a cached decision (R8 audit trail).
func HashInput(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:32]
}

// MinutesToClock renders 16:00 from 960.
func MinutesToClock(m int) string {
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

// WeekdayName renders the Australian convention used in the UI.
func WeekdayName(wd int) string {
	names := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	if wd >= 0 && wd < len(names) {
		return names[wd]
	}
	return "?"
}
