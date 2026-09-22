// Package clock is the single source of time for the whole application.
//
// Hard constraint (ADR-007): the MySQL instance runs with
// @@system_time_zone = CST while the business operates on
// Australia/Melbourne. Any SQL NOW()/CURDATE()/CURRENT_TIMESTAMP would
// silently write Beijing wall-clock into business columns. So business
// time is always produced here and passed into queries as a parameter.
//
// The blank import of time/tzdata is required on Windows, which ships no
// IANA tz database (golang/go#50248). Without it time.LoadLocation fails
// on the dev machine while working fine in Linux CI - a textbook
// "works on my machine" trap.
package clock

import (
	"time"

	_ "time/tzdata" // embed the IANA tz database; required on Windows
)

const TimezoneName = "Australia/Melbourne"

var loc *time.Location

func init() {
	l, err := time.LoadLocation(TimezoneName)
	if err != nil {
		panic("clock: cannot load " + TimezoneName + ": " + err.Error())
	}
	loc = l
}

// Now returns the current wall-clock time in Australia/Melbourne.
// Never call time.Now() directly anywhere else in this codebase.
func Now() time.Time { return time.Now().In(loc) }

// Loc exposes the business timezone for parsing and formatting.
func Loc() *time.Location { return loc }

// ParseIn interprets a DATETIME string coming back from MySQL as Melbourne
// wall-clock rather than UTC.
func ParseIn(layout, value string) (time.Time, error) {
	return time.ParseInLocation(layout, value, loc)
}
