// Package migrate applies the embedded .up.sql files in order and records
// what has run.
//
// Why not the golang-migrate CLI: it is an extra binary to install, and
// this project has a 10-hour budget. The file naming convention is kept
// compatible so the CLI remains an option, and the applied-version table
// below is the same idea. MySQL DDL implicitly commits, so a partially
// applied file leaves the schema half-built; each migration logs its
// progress and a failure is loud rather than silent.
package migrate

import (
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"gorm.io/gorm"

	"sms/internal/clock"
)

const createTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
	version    VARCHAR(64) NOT NULL,
	applied_at DATETIME(3) NOT NULL,
	PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

// Apply runs every .up.sql that has not been recorded yet.
func Apply(db *gorm.DB, fsys fs.FS) ([]string, error) {
	if err := db.Exec(createTable).Error; err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := db.Raw("SELECT version FROM schema_migrations").Rows()
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return nil, err
		}
		applied[v] = true
	}
	rows.Close()

	names := []string{}
	err = fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".up.sql") {
			return nil
		}
		names = append(names, path)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(names)

	ran := []string{}
	for _, name := range names {
		version := strings.TrimSuffix(name, ".up.sql")
		if applied[version] {
			continue
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return ran, err
		}
		fmt.Printf("  applying %s ...\n", version)
		if err := execStatements(db, string(body)); err != nil {
			return ran, fmt.Errorf("%s: %w", version, err)
		}
		if err := db.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			version, clock.Now()).Error; err != nil {
			return ran, err
		}
		ran = append(ran, version)
	}
	return ran, nil
}

// execStatements splits on semicolons at end of line. Good enough for DDL
// files that contain no stored procedures or semicolons inside literals.
func execStatements(db *gorm.DB, body string) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	for _, raw := range splitStatements(body) {
		stmt := strings.TrimSpace(raw)
		if stmt == "" {
			continue
		}
		if _, err := sqlDB.Exec(stmt); err != nil {
			return fmt.Errorf("%w\n--- statement ---\n%s", err, truncateForError(stmt))
		}
	}
	return nil
}

func splitStatements(body string) []string {
	lines := strings.Split(body, "\n")
	var out []string
	var cur strings.Builder
	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(ln)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	if strings.TrimSpace(cur.String()) != "" {
		out = append(out, cur.String())
	}
	return out
}

func truncateForError(s string) string {
	if len(s) <= 400 {
		return s
	}
	return s[:400] + "..."
}
